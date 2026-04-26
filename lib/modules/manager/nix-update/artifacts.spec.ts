import type { StatusResult } from 'simple-git';
import { mockExecSequence } from '~test/exec-util.ts';
import { env, fs, git, partial } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import type { RepoGlobalConfig } from '../../../config/types.ts';
import type { UpdateArtifactsConfig } from '../types.ts';
import { updateArtifacts } from './artifacts.ts';
import type { FodInfo } from './extract.ts';
import { _resetPrefetchCacheForTesting } from './prefetch.ts';

vi.mock('../../../util/exec/env.ts');
vi.mock('../../../util/fs/index.ts');

const adminConfig: RepoGlobalConfig = {
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
const stderrWithGot = (h: string) => `error: hash mismatch\n  got: ${h}`;

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

    mockExecSequence([makeMismatchError(stderrWithGot(NEW_HASH))]);

    const fileContent = `{
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

  it('runs src first then vendor FOD', async () => {
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('updated content');

    const NEW_SRC = 'sha256-SRCSRCSRCSRCSRCSRCSRCSRCSRCSRCSRCSRCSRCSRC=';
    const NEW_VENDOR = 'sha256-VENVENVENVENVENVENVENVENVENVENVENVENVENVEN=';
    const snapshots = mockExecSequence([
      makeMismatchError(stderrWithGot(NEW_SRC)),
      makeMismatchError(stderrWithGot(NEW_VENDOR)),
    ]);

    const fileContent = `{
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

    // first exec: src; second exec: vendor (with --eval-system darwin)
    expect(snapshots[0].cmd).toContain('runnerPkgs.fetchFromGitHub');
    expect(snapshots[1].cmd).toContain('runnerPkgs.buildGoModule');
    expect(snapshots[0].cmd).toContain('--eval-system x86_64-darwin');
    // vendor expression should reference the now-known src hash, not the placeholder
    expect(snapshots[1].cmd).toContain(NEW_SRC);
  });

  it('returns artifactError when prefetch fails (does not throw, does not abort)', async () => {
    mockExecSequence([new Error('exec died')]);

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
    GlobalConfig.set({} as RepoGlobalConfig);
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

    const fileContent = `{
      src = fetchurl {
        url = "https://example.com/x";
        hash = "${NEW_HASH}";
      };
    }`;
    mockExecSequence([makeMismatchError(stderrWithGot(NEW_HASH))]);

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
    const snapshots = mockExecSequence([makeMismatchError(stderrWithGot(NEW))]);

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

    const cmd = snapshots[0].cmd;
    expect(cmd).toContain('rev = "v0.0.61"');
    expect(cmd).not.toContain('vv0.0.61');
  });

  it('bumps via newDigest for branch-tracked packages', async () => {
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    fs.readLocalFile.mockResolvedValue('updated content');
    const NEW = 'sha256-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW=';
    const snapshots = mockExecSequence([makeMismatchError(stderrWithGot(NEW))]);

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

    const cmd = snapshots[0].cmd;
    expect(cmd).toContain('rev = "newcommitsha2"');
    expect(cmd).not.toContain('oldcommitsha1');
  });

  it('skips rewrite when file already has new hash (existing branch reuse)', async () => {
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );
    const NEW = 'sha256-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW=';
    mockExecSequence([makeMismatchError(stderrWithGot(NEW))]);

    // newPackageFileContent already has NEW hash (existing PR branch). Our
    // extract captured the OLD hash from main. rewriteHash's contextual
    // path would no-op; we should not throw.
    const content = `{
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
    mockExecSequence([]);
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

    const opts = snapshots[0].options as {
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
    const opts = snapshots[0].options as { env?: Record<string, string> };
    expect(opts.env?.GITLAB_TOKEN).toBe('glpat-testtoken');
    hostRules.clear();
  });

  it('collects multiple FOD errors into a single artifactError', async () => {
    mockExecSequence([
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
});
