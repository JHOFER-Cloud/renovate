import { codeBlock } from 'common-tags';
import { exec, mockExecSequence } from '~test/exec-util.ts';
import { env, fs } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import type { UpdateArtifactsConfig } from '../types.ts';
import { _resetPrefetchCacheForTesting } from './prefetch.ts';
import { updateVendorHashes } from './rehash.ts';
import type { FodInfo } from './types.ts';

vi.mock('../../../util/exec/env.ts');
vi.mock('../../../util/fs/index.ts');

const config: UpdateArtifactsConfig = {};

const SRC_HASH = 'sha256-SRCSRCSRCSRCSRCSRCSRCSRCSRCSRCSRCSRCSRCSRCS=';
const OLD_DEPS = 'sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO=';
const NEW_DEPS = 'sha256-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWN=';

const STORE_DIR_PROBE = { stdout: '/nix/store\n', stderr: '' };

function mismatch(got: string): Error {
  const err = new Error('nix-build failed (expected)') as Error & {
    stderr?: string;
  };
  err.stderr = `error: hash mismatch\n  got: ${got}`;
  return err;
}

function makeFod(
  attrPath: string[],
  inputs: Partial<FodInfo['inputs']>,
): FodInfo {
  return {
    attrPath,
    inputs: {
      outputHash: OLD_DEPS,
      outputHashAlgo: 'sha256',
      outputHashMode: 'recursive',
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

function makePackage(position: string | null) {
  return {
    system: 'x86_64-linux',
    version: '0.14.3',
    pname: 'mcp-remote',
    srcUrl: 'https://github.com/geelen/mcp-remote/archive/v0.14.3.tar.gz',
    srcRev: 'v0.14.3',
    position,
    updateScriptArgs: [],
    renovate: null,
    fods: [
      makeFod(['src'], {
        outputHash: SRC_HASH,
        url: 'https://github.com/geelen/mcp-remote/archive/v0.14.3.tar.gz',
        rev: 'v0.14.3',
      }),
      makeFod(['pnpmDeps'], { fetcherVersion: 4, pnpmVersion: '12.9.0' }),
    ],
  };
}

function evalResult(packages: Record<string, unknown>) {
  return { stdout: JSON.stringify(packages), stderr: '' };
}

const POSITION = '/nix/store/abc-source/packages/mcp-remote/default.nix:12';
const packageFile = codeBlock`
  pnpmDeps = fetchPnpmDeps {
    fetcherVersion = 4;
    hash = "${OLD_DEPS}";
  };
`;

describe('modules/manager/nix-update/rehash', () => {
  beforeEach(() => {
    env.getChildProcessEnv.mockReturnValue({});
    GlobalConfig.set({ localDir: '/tmp/repo', cacheDir: '/tmp/cache' });
    _resetPrefetchCacheForTesting();
    fs.readLocalFile.mockImplementation((file) => {
      if (file === 'flake.lock') {
        return Promise.resolve('lock');
      }
      return Promise.resolve(packageFile);
    });
  });

  it('rewrites a vendor hash that changed', async () => {
    const snapshots = mockExecSequence([
      evalResult({ 'mcp-remote': makePackage(POSITION) }),
      STORE_DIR_PROBE,
      mismatch(NEW_DEPS),
    ]);

    const res = await updateVendorHashes(config);

    expect(res).toEqual([
      {
        file: {
          type: 'addition',
          path: 'packages/mcp-remote/default.nix',
          contents: packageFile.replace(OLD_DEPS, NEW_DEPS),
        },
      },
    ]);
    // Only the vendor FOD is rebuilt, against the src hash already in the file.
    expect(snapshots).toHaveLength(3);
    expect(snapshots[2].cmd).toContain('runnerPkgs.fetchPnpmDeps');
    expect(snapshots[2].cmd).toContain('runnerPkgs.pnpm_12');
    expect(snapshots[2].cmd).toContain(SRC_HASH);
  });

  it('returns nothing when no hash changed', async () => {
    mockExecSequence([
      evalResult({ 'mcp-remote': makePackage(POSITION) }),
      STORE_DIR_PROBE,
      mismatch(OLD_DEPS),
    ]);

    const res = await updateVendorHashes(config);

    expect(res).toEqual([]);
  });

  it('rewrites a hash shared by two attributes once', async () => {
    mockExecSequence([
      evalResult({
        'mcp-remote': makePackage(POSITION),
        'mcp-remote-alias': makePackage(POSITION),
      }),
      STORE_DIR_PROBE,
      mismatch(NEW_DEPS),
    ]);

    const res = await updateVendorHashes(config);

    expect(res).toEqual([
      {
        file: {
          type: 'addition',
          path: 'packages/mcp-remote/default.nix',
          contents: packageFile.replace(OLD_DEPS, NEW_DEPS),
        },
      },
    ]);
  });

  it('reports a hash it cannot locate and keeps going', async () => {
    fs.readLocalFile.mockResolvedValue(null);
    mockExecSequence([
      evalResult({
        broken: makePackage(null),
        // A different pname makes a different expression, so no cache hit.
        failing: { ...makePackage(POSITION), pname: 'failing' },
      }),
      STORE_DIR_PROBE,
      mismatch(NEW_DEPS),
    ]);
    exec.mockRejectedValueOnce('exec died');

    const res = await updateVendorHashes(config);

    expect(res).toEqual([
      {
        artifactError: {
          fileName: 'flake.nix',
          stderr:
            'broken (pnpmDeps): Could not locate hash for attrPath pnpmDeps in nix file',
        },
      },
      {
        artifactError: {
          fileName: 'packages/mcp-remote/default.nix',
          stderr: 'failing (pnpmDeps): exec died',
        },
      },
    ]);
  });

  it('reports when the flake packages cannot be evaluated', async () => {
    mockExecSequence([new Error('eval failed')]);

    const res = await updateVendorHashes(config);

    expect(res).toEqual([
      {
        artifactError: {
          fileName: 'flake.lock',
          stderr:
            'nix-update: could not evaluate the flake packages to update their vendor hashes',
        },
      },
    ]);
  });

  it('reports an unusable nix store', async () => {
    mockExecSequence([
      evalResult({ 'mcp-remote': makePackage(POSITION) }),
      { stdout: '/tmp/containerbase/nix/store\n', stderr: '' },
    ]);

    const res = await updateVendorHashes(config);

    expect(res).toMatchObject([
      {
        artifactError: {
          fileName: 'flake.lock',
          stderr: expect.stringContaining(
            "nix store dir is '/tmp/containerbase/nix/store'",
          ),
        },
      },
    ]);
  });

  it('reports a non-Error store failure', async () => {
    mockExecSequence([evalResult({ 'mcp-remote': makePackage(POSITION) })]);
    exec.mockRejectedValueOnce('store probe died');

    const res = await updateVendorHashes(config);

    expect(res).toEqual([
      {
        artifactError: { fileName: 'flake.lock', stderr: 'store probe died' },
      },
    ]);
  });
});
