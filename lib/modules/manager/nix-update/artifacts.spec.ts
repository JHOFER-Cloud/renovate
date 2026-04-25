import type { StatusResult } from 'simple-git';
import { mockExecAll } from '~test/exec-util.ts';
import { env, fs, git, partial } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import type { RepoGlobalConfig } from '../../../config/types.ts';
import type { UpdateArtifactsConfig } from '../types.ts';
import { updateArtifacts } from './artifacts.ts';

vi.mock('../../../util/exec/env.ts');
vi.mock('../../../util/fs/index.ts');
vi.mock('node:os', () => ({ arch: () => 'x64', platform: () => 'linux' }));

const adminConfig: RepoGlobalConfig = {
  localDir: '/tmp/github/some/repo',
  cacheDir: '/tmp/renovate/cache',
  containerbaseDir: '/tmp/renovate/cache/containerbase',
};

const config: UpdateArtifactsConfig = {};

const nixRunCmd =
  "nix --extra-experimental-features 'nix-command flakes' run nixpkgs#nix-update -- --flake --system x86_64-linux";

describe('modules/manager/nix-update/artifacts', () => {
  beforeEach(() => {
    env.getChildProcessEnv.mockReturnValue({});
    GlobalConfig.set(adminConfig);
  });

  it('returns null if no attrName in managerData', async () => {
    const execSnapshots = mockExecAll();
    const result = await updateArtifacts({
      packageFileName: 'flake.nix',
      updatedDeps: [{ depName: 'foo', managerData: {} }],
      newPackageFileContent: '',
      config,
    });
    expect(result).toBeNull();
    expect(execSnapshots).toEqual([]);
  });

  it('returns null if nix-update makes no changes', async () => {
    const execSnapshots = mockExecAll();
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );

    const result = await updateArtifacts({
      packageFileName: 'flake.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.0',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            updateScriptArgs: [],
            isBranchTracked: false,
          },
        },
      ],
      newPackageFileContent: 'original content',
      config,
    });

    expect(result).toBeNull();
    expect(execSnapshots).toMatchObject([
      { cmd: `${nixRunCmd} --version 1.0.0 foo` },
    ]);
  });

  it('returns changed files when nix-update updates a package', async () => {
    const execSnapshots = mockExecAll();
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({
        modified: ['packages/foo/default.nix'],
        not_added: [],
      }),
    );
    fs.readLocalFile.mockResolvedValueOnce('updated nix content');

    const result = await updateArtifacts({
      packageFileName: 'flake.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.0',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            updateScriptArgs: [],
            isBranchTracked: false,
          },
        },
      ],
      newPackageFileContent: 'original content',
      config,
    });

    expect(result).toEqual([
      {
        file: {
          type: 'addition',
          path: 'packages/foo/default.nix',
          contents: 'updated nix content',
        },
      },
    ]);
    expect(execSnapshots[0]).toMatchObject({
      cmd: `${nixRunCmd} --version 1.0.0 foo`,
    });
  });

  it('does not pass --version for branch-tracked packages', async () => {
    const execSnapshots = mockExecAll();
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );

    await updateArtifacts({
      packageFileName: 'flake.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: 'unstable-2024-01-15',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            updateScriptArgs: ['--version=branch'],
            isBranchTracked: true,
          },
        },
      ],
      newPackageFileContent: 'content',
      config,
    });

    // --version=branch from updateScriptArgs is passed, but --version flag is not
    expect(execSnapshots).toMatchObject([
      { cmd: `${nixRunCmd} --version=branch foo` },
    ]);
  });

  it('does not pass --version when newVersion is absent', async () => {
    const execSnapshots = mockExecAll();
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );

    await updateArtifacts({
      packageFileName: 'flake.nix',
      updatedDeps: [
        {
          depName: 'foo',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            updateScriptArgs: [],
            isBranchTracked: false,
          },
        },
      ],
      newPackageFileContent: 'content',
      config,
    });

    expect(execSnapshots).toMatchObject([{ cmd: `${nixRunCmd} foo` }]);
  });

  it('passes --build when nixUpdateBuild postUpdateOption is set', async () => {
    const execSnapshots = mockExecAll();
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );

    await updateArtifacts({
      packageFileName: 'flake.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.0',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            updateScriptArgs: [],
            isBranchTracked: false,
          },
        },
      ],
      newPackageFileContent: 'content',
      config: { ...config, postUpdateOptions: ['nixUpdateBuild'] },
    });

    expect(execSnapshots).toMatchObject([
      { cmd: `${nixRunCmd} --version 1.0.0 --build foo` },
    ]);
  });

  it('skips --build when package system does not match runner system', async () => {
    const execSnapshots = mockExecAll();
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );

    await updateArtifacts({
      packageFileName: 'flake.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.0',
          managerData: {
            attrName: 'foo',
            system: 'aarch64-darwin', // runner is x86_64-linux
            updateScriptArgs: [],
            isBranchTracked: false,
          },
        },
      ],
      newPackageFileContent: 'content',
      config: { ...config, postUpdateOptions: ['nixUpdateBuild'] },
    });

    // --build must NOT appear in the command
    expect(execSnapshots[0].cmd).not.toContain('--build');
  });

  it('passes updateScriptArgs extracted from passthru.updateScript.command', async () => {
    const execSnapshots = mockExecAll();
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );

    await updateArtifacts({
      packageFileName: 'flake.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: 'unstable-2024-01-15',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            updateScriptArgs: ['--version=branch'],
            isBranchTracked: true,
          },
        },
      ],
      newPackageFileContent: 'content',
      config,
    });

    expect(execSnapshots).toMatchObject([
      { cmd: `${nixRunCmd} --version=branch foo` },
    ]);
  });

  it('returns artifactError if nix-update throws', async () => {
    mockExecAll(new Error('nix-update failed'));

    const result = await updateArtifacts({
      packageFileName: 'flake.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.0',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            updateScriptArgs: [],
            isBranchTracked: false,
          },
        },
      ],
      newPackageFileContent: 'content',
      config,
    });

    expect(result).toEqual([
      {
        artifactError: {
          fileName: 'flake.nix',
          stderr: 'nix-update failed',
        },
      },
    ]);
  });

  it('returns multiple changed files', async () => {
    const execSnapshots = mockExecAll();
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({
        modified: ['packages/foo/default.nix', 'packages/foo/extra.nix'],
        not_added: [],
      }),
    );
    fs.readLocalFile
      .mockResolvedValueOnce('updated content 1')
      .mockResolvedValueOnce('updated content 2');

    const result = await updateArtifacts({
      packageFileName: 'flake.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newVersion: '1.0.0',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            updateScriptArgs: [],
            isBranchTracked: false,
          },
        },
      ],
      newPackageFileContent: 'original',
      config,
    });

    expect(result).toHaveLength(2);
    expect(execSnapshots[0]).toMatchObject({
      cmd: `${nixRunCmd} --version 1.0.0 foo`,
    });
  });

  it('uses newValue as fallback when newVersion is absent', async () => {
    const execSnapshots = mockExecAll();
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: [], not_added: [] }),
    );

    await updateArtifacts({
      packageFileName: 'flake.nix',
      updatedDeps: [
        {
          depName: 'foo',
          newValue: '2.0.0',
          managerData: {
            attrName: 'foo',
            system: 'x86_64-linux',
            updateScriptArgs: [],
            isBranchTracked: false,
          },
        },
      ],
      newPackageFileContent: 'content',
      config,
    });

    expect(execSnapshots).toMatchObject([
      { cmd: `${nixRunCmd} --version 2.0.0 foo` },
    ]);
  });
});
