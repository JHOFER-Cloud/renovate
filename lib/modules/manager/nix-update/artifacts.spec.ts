import { codeBlock } from 'common-tags';
import type { StatusResult } from 'simple-git';
import { mockExecSequence } from '~test/exec-util.ts';
import { env, fs, git, partial } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import type {
  InternalGlobalConfigOptions,
  RepoGlobalConfig,
} from '../../../config/types.ts';
import { logger } from '../../../logger/index.ts';
import type { Timestamp } from '../../../util/timestamp.ts';
import type { UpdateArtifactsConfig } from '../types.ts';
import { updateArtifacts } from './artifacts.ts';
import type { FodInfo } from './extract.ts';
import { _resetPrefetchCacheForTesting } from './prefetch.ts';

vi.mock('../../../util/exec/env.ts');
vi.mock('../../../util/fs/index.ts');
vi.mock('../../datasource/index.ts');

const adminConfig: RepoGlobalConfig & InternalGlobalConfigOptions = {
  localDir: '/tmp/repo',
  cacheDir: '/tmp/cache',
  containerbaseDir: '/tmp/cache/containerbase',
};

const config: UpdateArtifactsConfig = {};

function makeMismatchError(stderr: string): Error {
  const err = new Error('nix-build failed (expected)') as Error & {
    stderr?: string;
  };
  err.stderr = stderr;
  return err;
}

// prefetch probes `builtins.storeDir` once per process before it builds.
const STORE_DIR_PROBE = { stdout: '/nix/store\n', stderr: '' };

function makeFod(
  attrPath: string[],
  inputs: Partial<FodInfo['inputs']>,
): FodInfo {
  return {
    attrPath,
    inputs: {
      outputHash: 'sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO=',
      outputHashAlgo: 'sha256',
      outputHashMode: 'flat',
      url: null,
      rev: null,
      fetchSubmodules: null,
      leaveDotGit: null,
      deepClone: null,
      forceFetchGit: null,
      sparseCheckout: null,
      name: null,
      ...inputs,
    },
  };
}

const NEW_HASH = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
function stderrWithGot(h: string): string {
  return `error: hash mismatch\n  got: ${h}`;
}

// A minimal single-src upgrade, for tests that only care about the nix command.
function srcOnlyUpgrade() {
  return {
    packageFileName: 'packages/foo/default.nix',
    updatedDeps: [
      {
        depName: 'foo',
        newVersion: '1.0.1',
        managerData: {
          attrName: 'foo',
          system: 'x86_64-linux',
          pname: 'foo',
          fods: [
            makeFod(['src'], {
              url: 'https://example.com/foo.tar.gz',
              outputHashMode: 'flat',
            }),
          ],
        },
      },
    ],
    newPackageFileContent: '...',
  };
}

describe('modules/manager/nix-update/artifacts', () => {
  beforeEach(() => {
    env.getChildProcessEnv.mockReturnValue({});
    GlobalConfig.set(adminConfig);
    _resetPrefetchCacheForTesting();
  });

  it('returns null when managerData has no attrName', async () => {
    const result = await updateArtifacts({
      packageFileName: 'packages/foo/default.nix',
      updatedDeps: [{ depName: 'foo', managerData: {} }],
      newPackageFileContent: '',
      config,
    });
    expect(result).toBeNull();
  });

  it('returns null when managerData has no fods', async () => {
    const result = await updateArtifacts({
      packageFileName: 'packages/foo/default.nix',
      updatedDeps: [
        {
          depName: 'foo',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            pname: 'foo',
            fods: [],
          },
        },
      ],
      newPackageFileContent: '',
      config,
    });
    expect(result).toBeNull();
  });

  it('updates a single src FOD and returns the rewritten file', async () => {
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('content with new hash');

    mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(stderrWithGot(NEW_HASH)),
    ]);

    const fileContent = codeBlock`{
      src = fetchurl {
        url = "https://example.com/foo.tar.gz";
        hash = "sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO=";
      };
    }`;

    const result = await updateArtifacts({
      packageFileName: 'packages/foo/default.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.1',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            pname: 'foo',
            fods: [
              makeFod(['src'], {
                url: 'https://example.com/foo.tar.gz',
                outputHashMode: 'flat',
              }),
            ],
          },
        },
      ],
      newPackageFileContent: fileContent,
      config,
    });

    expect(result).toEqual([
      {
        file: {
          type: 'addition',
          path: 'packages/foo/default.nix',
          contents: 'content with new hash',
        },
      },
    ]);
  });

  it('rewrites the src url when upgrade carries downloadUrl', async () => {
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    // Capture what artifacts writes back so we can assert on it.
    let writtenContent: string | undefined;
    const { writeLocalFile, readLocalFile } =
      await import('../../../util/fs/index.ts');
    vi.mocked(writeLocalFile).mockImplementation((_path, contents) => {
      writtenContent = contents as string;
      return Promise.resolve();
    });
    vi.mocked(readLocalFile).mockImplementation(() =>
      Promise.resolve(writtenContent ?? ''),
    );

    mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(stderrWithGot(NEW_HASH)),
    ]);

    const oldUrl =
      'https://x-r2.raycast-releases.com/Raycast_Beta_0.61.0.0_aaa_arm64.dmg';
    const newUrl =
      'https://x-r2.raycast-releases.com/Raycast_Beta_0.62.0.0_bbb_arm64.dmg';

    const fileContent = codeBlock`{
      version = "0.62.0.0";
      src = fetchurl {
        url = "${oldUrl}";
        hash = "sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO=";
      };
    }`;

    const result = await updateArtifacts({
      packageFileName: 'packages/raycast-beta/default.nix',
      updatedDeps: [
        {
          depName: 'raycast-beta',
          newVersion: '0.62.0.0',
          downloadUrl: newUrl,
          managerData: {
            attrName: 'raycast-beta',
            system: 'aarch64-darwin',
            pname: 'raycast-beta',
            fods: [makeFod(['src'], { url: oldUrl, outputHashMode: 'flat' })],
          },
        },
      ],
      newPackageFileContent: fileContent,
      config,
    });

    // File written back contains the new URL and new hash.
    expect(writtenContent).toContain(newUrl);
    expect(writtenContent).not.toContain(oldUrl);
    expect(writtenContent).toContain(NEW_HASH);
    expect(result).not.toBeNull();
  });

  it('runs src first then vendor FOD', async () => {
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('updated content');

    const NEW_SRC = 'sha256-SRCSRCSRCSRCSRCSRCSRCSRCSRCSRCSRCSRCSRCSRC=';
    const NEW_VENDOR = 'sha256-VENVENVENVENVENVENVENVENVENVENVENVENVENVEN=';
    const snapshots = mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(stderrWithGot(NEW_SRC)),
      makeMismatchError(stderrWithGot(NEW_VENDOR)),
    ]);

    const fileContent = codeBlock`{
      src = fetchFromGitHub {
        owner = "o"; repo = "r"; rev = "v1";
        hash = "sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO=";
      };
      vendorHash = "sha256-OLDVENOLDVENOLDVENOLDVENOLDVENOLDVENOLDVE=";
    }`;

    await updateArtifacts({
      packageFileName: 'packages/foo/default.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.1',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-darwin',
            pname: 'foo',
            fods: [
              // Order is mixed in; artifacts should sort src first.
              makeFod(['goModules'], {
                outputHash: 'sha256-OLDVENOLDVENOLDVENOLDVENOLDVENOLDVENOLDVE=',
              }),
              makeFod(['src'], {
                url: 'https://github.com/o/r/archive/v1.tar.gz',
                outputHashMode: 'recursive',
              }),
            ],
          },
        },
      ],
      newPackageFileContent: fileContent,
      config,
    });

    // first exec: src; second exec: vendor — both use runnerPkgs (no --eval-system)
    expect(snapshots[1].cmd).toContain('runnerPkgs.fetchFromGitHub');
    expect(snapshots[2].cmd).toContain('runnerPkgs.buildGoModule');
    expect(snapshots[1].cmd).not.toContain('--eval-system');
    // vendor expression should reference the now-known src hash, not the placeholder
    expect(snapshots[2].cmd).toContain(NEW_SRC);
  });

  it('returns artifactError when prefetch fails (does not throw, does not abort)', async () => {
    mockExecSequence([STORE_DIR_PROBE, new Error('exec died')]);

    const result = await updateArtifacts({
      packageFileName: 'packages/foo/default.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.1',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-darwin',
            pname: 'foo',
            fods: [
              makeFod(['src'], {
                url: 'https://example.com/foo.tar.gz',
                outputHashMode: 'flat',
              }),
            ],
          },
        },
      ],
      newPackageFileContent: '...',
      config,
    });

    expect(result).toEqual([
      {
        artifactError: {
          fileName: 'packages/foo/default.nix',
          stderr: expect.stringContaining('exec died'),
        },
      },
    ]);
  });

  it('returns null when localDir is unset', async () => {
    GlobalConfig.set({});
    const result = await updateArtifacts({
      packageFileName: 'flake.nix',
      updatedDeps: [
        {
          depName: 'foo',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            pname: 'foo',
            fods: [makeFod(['src'], { url: 'https://x' })],
          },
        },
      ],
      newPackageFileContent: '',
      config,
    });
    expect(result).toBeNull();
  });

  it('skips rewrite when prefetch returns the same hash as before', async () => {
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );

    const fileContent = codeBlock`{
      src = fetchurl {
        url = "https://example.com/x";
        hash = "${NEW_HASH}";
      };
    }`;
    mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(stderrWithGot(NEW_HASH)),
    ]);

    const result = await updateArtifacts({
      packageFileName: 'packages/foo/default.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.0',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            pname: 'foo',
            fods: [
              makeFod(['src'], {
                url: 'https://example.com/x',
                outputHashMode: 'flat',
                outputHash: NEW_HASH, // same as what nix-build returns
              }),
            ],
          },
        },
      ],
      newPackageFileContent: fileContent,
      config,
    });

    // No file changes (hash matched).
    expect(result).toBeNull();
  });

  it('bumps version in url/rev before prefetching (and strips leading v on inputs)', async () => {
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('updated content');
    const NEW = 'sha256-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW=';
    const snapshots = mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(stderrWithGot(NEW)),
    ]);

    await updateArtifacts({
      packageFileName: 'packages/k/default.nix',
      updatedDeps: [
        {
          depName: 'k',
          currentValue: '0.0.60',
          newVersion: 'v0.0.61', // newVersion may include the v prefix
          managerData: {
            attrName: 'k',
            system: 'x86_64-linux',
            pname: 'k',
            fods: [
              makeFod(['src'], {
                url: 'https://github.com/o/k/archive/v0.0.60.tar.gz',
                rev: 'v0.0.60',
                outputHashMode: 'recursive',
              }),
            ],
          },
        },
      ],
      newPackageFileContent: `{ src = fetchFromGitHub { rev = "v0.0.60"; hash = "sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO="; }; }`,
      config,
    });

    const cmd = snapshots[1].cmd;
    expect(cmd).toContain('rev = "v0.0.61"');
    expect(cmd).not.toContain('vv0.0.61');
  });

  it('bumps via newDigest for branch-tracked packages', async () => {
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('updated content');
    const NEW = 'sha256-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW=';
    const snapshots = mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(stderrWithGot(NEW)),
    ]);

    await updateArtifacts({
      packageFileName: 'packages/x/default.nix',
      updatedDeps: [
        {
          depName: 'x',
          currentValue: 'main',
          newValue: 'main',
          currentDigest: 'oldcommitsha1',
          newDigest: 'newcommitsha2',
          managerData: {
            attrName: 'x',
            system: 'x86_64-linux',
            pname: 'x',
            // No datasource on the dep, so the commit-date lookup is skipped.
            isBranchTracked: true,
            fods: [
              makeFod(['src'], {
                url: 'https://github.com/o/x.git',
                rev: 'oldcommitsha1',
                outputHashMode: 'recursive',
              }),
            ],
          },
        },
      ],
      newPackageFileContent: `{ src = fetchgit { rev = "oldcommitsha1"; hash = "sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO="; }; }`,
      config,
    });

    const cmd = snapshots[1].cmd;
    expect(cmd).toContain('rev = "newcommitsha2"');
    expect(cmd).not.toContain('oldcommitsha1');
  });

  it('writes the new commit into the file for branch-tracked packages', async () => {
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    // Capture what artifacts writes back so we can assert on it.
    let writtenContent: string | undefined;
    const { writeLocalFile, readLocalFile } =
      await import('../../../util/fs/index.ts');
    vi.mocked(writeLocalFile).mockImplementation((_path, contents) => {
      writtenContent = contents as string;
      return Promise.resolve();
    });
    vi.mocked(readLocalFile).mockImplementation(() =>
      Promise.resolve(writtenContent ?? ''),
    );

    const NEW = 'sha256-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW=';
    mockExecSequence([STORE_DIR_PROBE, makeMismatchError(stderrWithGot(NEW))]);

    // The unstable date comes from the datasource, not the upgrade: digest
    // updates never carry a releaseTimestamp.
    const { getPkgReleases } = await import('../../datasource/index.ts');
    vi.mocked(getPkgReleases).mockResolvedValue({
      releases: [
        {
          version: 'main',
          releaseTimestamp: '2026-06-30T17:00:31.000Z' as Timestamp,
        },
      ],
    });

    const fileContent = codeBlock`{
      version = "0-unstable-2025-11-17";
      src = fetchFromGitHub {
        owner = "acsandmann"; repo = "aerospace-swipe";
        rev = "oldcommitsha1";
        hash = "sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO=";
      };
    }`;

    await updateArtifacts({
      packageFileName: 'packages/aerospace-swipe/default.nix',
      updatedDeps: [
        {
          depName: 'aerospace-swipe',
          datasource: 'github-digest',
          packageName: 'acsandmann/aerospace-swipe',
          currentValue: 'main',
          newValue: 'main',
          currentDigest: 'oldcommitsha1',
          newDigest: 'newcommitsha2',
          managerData: {
            attrName: 'aerospace-swipe',
            system: 'aarch64-darwin',
            pname: 'aerospace-swipe',
            isBranchTracked: true,
            fods: [
              makeFod(['src'], {
                url: 'https://github.com/acsandmann/aerospace-swipe/archive/oldcommitsha1.tar.gz',
                rev: 'oldcommitsha1',
                outputHashMode: 'recursive',
              }),
            ],
          },
        },
      ],
      newPackageFileContent: fileContent,
      config,
    });

    // Both the commit and the hash must land in the file — pairing the newly
    // computed hash with the old rev is a guaranteed build failure.
    expect(writtenContent).toContain('rev = "newcommitsha2"');
    expect(writtenContent).not.toContain('oldcommitsha1');
    expect(writtenContent).toContain(NEW);
    // ...and the nixpkgs unstable date follows the commit date.
    expect(writtenContent).toContain('version = "0-unstable-2026-06-30"');
  });

  it('rewrites only the hash for --version=skip packages', async () => {
    // skip deps carry a currentDigest too (the artifact's content hash), but
    // their src is a plain fetchurl with no `rev` anywhere. Gating the rev
    // rewrite on the digest alone made every one of these updates fail.
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    let writtenContent: string | undefined;
    const { writeLocalFile, readLocalFile } =
      await import('../../../util/fs/index.ts');
    vi.mocked(writeLocalFile).mockImplementation((_path, contents) => {
      writtenContent = contents as string;
      return Promise.resolve();
    });
    vi.mocked(readLocalFile).mockImplementation(() =>
      Promise.resolve(writtenContent ?? ''),
    );

    const NEW = 'sha256-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW=';
    mockExecSequence([STORE_DIR_PROBE, makeMismatchError(stderrWithGot(NEW))]);

    const url =
      'https://github.com/ghostty-org/ghostty/releases/download/tip/ghostty-macos-universal.zip';
    const fileContent = codeBlock`{
      version = "tip";
      src = fetchurl {
        url = "${url}";
        hash = "sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO=";
      };
    }`;

    const result = await updateArtifacts({
      packageFileName: 'packages/ghostty-tip/default.nix',
      updatedDeps: [
        {
          depName: 'ghostty-tip',
          currentValue: 'tip',
          newValue: 'tip',
          currentDigest: `sha256:${'a'.repeat(64)}`,
          newDigest: `sha256:${'b'.repeat(64)}`,
          managerData: {
            attrName: 'ghostty-tip',
            system: 'aarch64-darwin',
            pname: 'ghostty-tip',
            isBranchTracked: false,
            fods: [makeFod(['src'], { url, outputHashMode: 'flat' })],
          },
        },
      ],
      newPackageFileContent: fileContent,
      config,
    });

    expect(result?.[0].artifactError).toBeUndefined();
    expect(writtenContent).toContain(NEW);
    // The frozen version attribute is left alone.
    expect(writtenContent).toContain('version = "tip"');
  });

  it('keeps the rev update when the commit-date lookup fails', async () => {
    // getPkgReleases re-throws host errors; the date is cosmetic and must never
    // discard an otherwise-complete rev + hash update.
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    let writtenContent: string | undefined;
    const { writeLocalFile, readLocalFile } =
      await import('../../../util/fs/index.ts');
    vi.mocked(writeLocalFile).mockImplementation((_path, contents) => {
      writtenContent = contents as string;
      return Promise.resolve();
    });
    vi.mocked(readLocalFile).mockImplementation(() =>
      Promise.resolve(writtenContent ?? ''),
    );

    const { getPkgReleases } = await import('../../datasource/index.ts');
    vi.mocked(getPkgReleases).mockRejectedValue(
      new Error('external-host-error'),
    );

    const NEW = 'sha256-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW=';
    mockExecSequence([STORE_DIR_PROBE, makeMismatchError(stderrWithGot(NEW))]);

    const result = await updateArtifacts({
      packageFileName: 'packages/aerospace-swipe/default.nix',
      updatedDeps: [
        {
          depName: 'aerospace-swipe',
          datasource: 'github-digest',
          packageName: 'acsandmann/aerospace-swipe',
          currentValue: 'main',
          newValue: 'main',
          currentDigest: 'oldcommitsha1',
          newDigest: 'newcommitsha2',
          managerData: {
            attrName: 'aerospace-swipe',
            system: 'aarch64-darwin',
            pname: 'aerospace-swipe',
            isBranchTracked: true,
            fods: [
              makeFod(['src'], {
                url: 'https://github.com/acsandmann/aerospace-swipe.git',
                rev: 'oldcommitsha1',
                outputHashMode: 'recursive',
              }),
            ],
          },
        },
      ],
      newPackageFileContent: codeBlock`{
        version = "0-unstable-2025-11-17";
        src = fetchgit {
          rev = "oldcommitsha1";
          hash = "sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO=";
        };
      }`,
      config,
    });

    expect(result?.[0].artifactError).toBeUndefined();
    expect(writtenContent).toContain('rev = "newcommitsha2"');
    expect(writtenContent).toContain(NEW);
    // Date left stale rather than the whole update being thrown away.
    expect(writtenContent).toContain('version = "0-unstable-2025-11-17"');
  });

  it('reports a failed rev rewrite as an artifactError instead of throwing', async () => {
    // These rewrites run outside the per-FOD loop; if they threw,
    // getUpdatedPackageFiles() would fail for the whole branch instead of
    // surfacing a per-package problem.
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('unchanged');
    mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(
        stderrWithGot('sha256-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW='),
      ),
    ]);

    const result = await updateArtifacts({
      packageFileName: 'packages/x/default.nix',
      updatedDeps: [
        {
          depName: 'x',
          currentValue: 'main',
          newValue: 'main',
          currentDigest: 'oldcommitsha1',
          newDigest: 'newcommitsha2',
          managerData: {
            attrName: 'x',
            system: 'x86_64-linux',
            pname: 'x',
            isBranchTracked: true,
            fods: [
              makeFod(['src'], {
                url: 'https://github.com/o/x.git',
                rev: 'oldcommitsha1',
                outputHashMode: 'recursive',
              }),
            ],
          },
        },
      ],
      // No `rev` binding anywhere, and the old sha is absent — both the fast
      // path and the contextual scan fail, so rewriteRev throws.
      newPackageFileContent: `{ other = "nothing to anchor on"; }`,
      config,
    });

    expect(result?.[0].artifactError?.stderr).toMatch(/Could not locate rev/);
  });

  it('skips rewrite when file already has new hash (existing branch reuse)', async () => {
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    const NEW = 'sha256-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW=';
    mockExecSequence([STORE_DIR_PROBE, makeMismatchError(stderrWithGot(NEW))]);

    // newPackageFileContent already has NEW hash (existing PR branch). Our
    // extract captured the OLD hash from main. rewriteHash's contextual
    // path would no-op; we should not throw.
    const content = codeBlock`{
      src = fetchurl {
        hash = "${NEW}";
      };
    }`;
    const result = await updateArtifacts({
      packageFileName: 'p.nix',
      updatedDeps: [
        {
          depName: 'foo',
          currentValue: '0.0.60',
          newVersion: '0.0.61',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            pname: 'foo',
            fods: [
              makeFod(['src'], {
                url: 'https://example.com/x',
                outputHash:
                  'sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO=',
              }),
            ],
          },
        },
      ],
      newPackageFileContent: content,
      config,
    });
    expect(result).toBeNull();
  });

  it('reports vendor-FOD failure when package has no src', async () => {
    // Only the store-dir probe runs; classification fails before any build.
    mockExecSequence([STORE_DIR_PROBE]);
    const result = await updateArtifacts({
      packageFileName: 'packages/foo/default.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.1',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            pname: 'foo',
            fods: [makeFod(['goModules'], {})],
          },
        },
      ],
      newPackageFileContent: '...',
      config,
    });
    expect(result?.[0].artifactError?.stderr).toMatch(
      /vendor FOD requires a src/,
    );
  });

  it('passes GITHUB_TOKEN env when host rules provide one', async () => {
    const hostRules = await import('../../../util/host-rules.ts');
    hostRules.add({
      hostType: 'github',
      matchHost: 'https://api.github.com/',
      token: 'ghs_testtoken',
    });
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('updated content');

    const snapshots = mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(stderrWithGot(NEW_HASH)),
    ]);

    await updateArtifacts({
      packageFileName: 'packages/foo/default.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.1',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            pname: 'foo',
            fods: [
              makeFod(['src'], {
                url: 'https://x',
                outputHashMode: 'flat',
              }),
            ],
          },
        },
      ],
      newPackageFileContent: `{ src = fetchurl { hash = "sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO="; }; }`,
      config,
    });

    const opts = snapshots[1].options as {
      env?: Record<string, string>;
    };
    expect(opts.env?.GITHUB_TOKEN).toBe('ghs_testtoken');
    hostRules.clear();
  });

  it('passes GITLAB_TOKEN env when gitlab host rule has a token', async () => {
    const hostRules = await import('../../../util/host-rules.ts');
    hostRules.add({
      hostType: 'gitlab',
      matchHost: 'https://gitlab.com/api/v4/',
      token: 'glpat-testtoken',
    });
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('updated');
    const snapshots = mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(stderrWithGot(NEW_HASH)),
    ]);
    await updateArtifacts({
      packageFileName: 'p.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            pname: 'foo',
            fods: [makeFod(['src'], { url: 'https://x' })],
          },
        },
      ],
      newPackageFileContent: `{ hash = "sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO="; }`,
      config,
    });
    const opts = snapshots[1].options as { env?: Record<string, string> };
    expect(opts.env?.GITLAB_TOKEN).toBe('glpat-testtoken');
    hostRules.clear();
  });

  it('collects multiple FOD errors into a single artifactError', async () => {
    mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError('garbage no got line here'),
      new Error('boom'),
    ]);

    const result = await updateArtifacts({
      packageFileName: 'packages/foo/default.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.1',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-darwin',
            pname: 'foo',
            fods: [
              makeFod(['src'], {
                url: 'https://example.com/x.tar.gz',
                outputHashMode: 'flat',
              }),
              makeFod(['goModules'], {}),
            ],
          },
        },
      ],
      newPackageFileContent: '...',
      config,
    });

    expect(result).toHaveLength(1);
    expect(result?.[0].artifactError?.stderr).toMatch(/fetchurl/);
    expect(result?.[0].artifactError?.stderr).toMatch(/goModules/);
  });
  it('reports one artifactError when the nix store cannot substitute', async () => {
    const snapshots = mockExecSequence([
      { stdout: '/tmp/containerbase/cache/nix/store\n', stderr: '' },
    ]);

    const result = await updateArtifacts({
      packageFileName: 'packages/foo/default.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.1',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            pname: 'foo',
            fods: [
              makeFod(['src'], {
                url: 'https://example.com/foo.tar.gz',
                outputHashMode: 'flat',
              }),
              makeFod(['goModules'], {}),
            ],
          },
        },
      ],
      newPackageFileContent: '...',
      config,
    });

    // One error for the package, not one per FOD, and no build attempted.
    expect(result).toHaveLength(1);
    expect(result?.[0].artifactError?.stderr).toMatch(
      /binary caches only serve/,
    );
    expect(snapshots).toHaveLength(1);
  });
  it('passes allowlisted substituters with the admin signing keys', async () => {
    GlobalConfig.set({
      ...adminConfig,
      allowedNixSubstituters: ['https://nixkit.cachix.org'],
      nixTrustedPublicKeys: ['nixkit.cachix.org-1:abc='],
    });
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('updated content');
    const snapshots = mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(stderrWithGot(NEW_HASH)),
    ]);

    await updateArtifacts({
      ...srcOnlyUpgrade(),
      config: { ...config, nixSubstituters: ['https://nixkit.cachix.org'] },
    });

    const cmd = snapshots[1].cmd;
    expect(cmd).toContain(
      "--option extra-substituters 'https://nixkit.cachix.org'",
    );
    expect(cmd).toContain(
      "--option extra-trusted-public-keys 'nixkit.cachix.org-1:abc='",
    );
  });

  it('drops substituters missing from the admin allowlist', async () => {
    GlobalConfig.set({
      ...adminConfig,
      allowedNixSubstituters: ['https://nixkit.cachix.org'],
      nixTrustedPublicKeys: ['nixkit.cachix.org-1:abc='],
    });
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('updated content');
    const snapshots = mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(stderrWithGot(NEW_HASH)),
    ]);

    await updateArtifacts({
      ...srcOnlyUpgrade(),
      config: { ...config, nixSubstituters: ['https://evil.example.com'] },
    });

    const cmd = snapshots[1].cmd;
    expect(cmd).not.toContain('extra-substituters');
    // No allowed cache survives, so the admin keys are not passed either.
    expect(cmd).not.toContain('extra-trusted-public-keys');
    expect(logger.warn).toHaveBeenCalledWith(
      { rejected: ['https://evil.example.com'] },
      'nix-update: ignoring substituters missing from allowedNixSubstituters',
    );
  });

  it('rejects an allowlisted entry that smuggles a second substituter', async () => {
    GlobalConfig.set({
      ...adminConfig,
      // Unanchored regex: matches anywhere in the string.
      allowedNixSubstituters: ['/nixkit\\.cachix\\.org/'],
      nixTrustedPublicKeys: ['nixkit.cachix.org-1:abc='],
    });
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('updated content');
    const snapshots = mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(stderrWithGot(NEW_HASH)),
    ]);

    await updateArtifacts({
      ...srcOnlyUpgrade(),
      config: {
        ...config,
        // nix splits this option on whitespace.
        nixSubstituters: ['https://nixkit.cachix.org https://evil.example.com'],
      },
    });

    expect(snapshots[1].cmd).not.toContain('extra-substituters');
  });

  it('passes nothing when the allowlist is empty', async () => {
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('updated content');
    const snapshots = mockExecSequence([
      STORE_DIR_PROBE,
      makeMismatchError(stderrWithGot(NEW_HASH)),
    ]);

    await updateArtifacts({
      ...srcOnlyUpgrade(),
      config: { ...config, nixSubstituters: ['https://nixkit.cachix.org'] },
    });

    expect(snapshots[1].cmd).not.toContain('extra-substituters');
  });
});
