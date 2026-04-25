import { arch, platform } from 'node:os';
import { quote } from 'shlex';
import { logger } from '../../../logger/index.ts';
import { exec } from '../../../util/exec/index.ts';
import type { ExecOptions } from '../../../util/exec/types.ts';
import { readLocalFile, writeLocalFile } from '../../../util/fs/index.ts';
import { getGitEnvironmentVariables } from '../../../util/git/auth.ts';
import { getRepoStatus } from '../../../util/git/index.ts';
import type { UpdateArtifact, UpdateArtifactsResult } from '../types.ts';

const nixCmd = `nix --extra-experimental-features 'nix-command flakes'`;

export async function updateArtifacts({
  packageFileName,
  updatedDeps,
  newPackageFileContent,
  config,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  // Renovate calls updateArtifacts once per dep for this manager, so
  // updatedDeps always has exactly one entry.
  const dep = updatedDeps[0];
  const attrName = dep?.managerData?.attrName as string | undefined;
  if (!attrName) {
    return null;
  }

  // system was recorded at extraction time — passed to nix-update so it
  // evaluates the package on the correct platform (e.g. x86_64-linux for
  // Linux-only packages) regardless of where renovate itself is running.
  const system = dep.managerData?.system as string | undefined;

  // isBranchTracked packages track a branch head rather than a version tag;
  // for these we skip --version since nix-update handles it via --version=branch.
  const isBranchTracked = dep.managerData?.isBranchTracked as
    | boolean
    | undefined;

  // Extra args extracted from passthru.updateScript.command at extraction time
  // (e.g. ["--version=branch"] or ["--version-regex", "pattern"]).
  // We call nix-update directly instead of --use-update-script to avoid
  // nix develop, which requires foreign-system binaries and breaks cross-platform.
  const updateScriptArgs =
    (dep.managerData?.updateScriptArgs as string[] | undefined) ?? [];

  // The version renovate resolved from the real datasource. Passed to nix-update
  // so it fetches exactly that version rather than re-querying upstream.
  const newVersion = dep.newVersion ?? dep.newValue;

  await writeLocalFile(packageFileName, newPackageFileContent);

  const execOptions: ExecOptions = {
    cwdFile: packageFileName,
    toolConstraints: [{ toolName: 'nix', constraint: config.constraints?.nix }],
    extraEnv: {
      ...getGitEnvironmentVariables(),
    },
    docker: {},
  };

  // Map Node.js arch/platform to Nix system triple for --build comparison.
  // Only x86_64 and aarch64 on linux/darwin are supported; warn on others.
  const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };
  const osMap: Record<string, string> = { linux: 'linux', darwin: 'darwin' };
  const nixArch = archMap[arch()];
  const nixOs = osMap[platform()];
  if (!nixArch || !nixOs) {
    logger.warn(
      { arch: arch(), platform: platform() },
      'nix-update: unsupported runner arch/platform — --build will be skipped',
    );
  }
  const runnerSystem = nixArch && nixOs ? `${nixArch}-${nixOs}` : null;

  const cmd = [
    `${nixCmd} run nixpkgs#nix-update --`,
    '--flake',
    system ? '--system' : null,
    system ? quote(system) : null,
    !isBranchTracked && newVersion ? '--version' : null,
    !isBranchTracked && newVersion ? quote(newVersion) : null,
    config.postUpdateOptions?.includes('nixUpdateBuild') &&
    (!system || system === runnerSystem)
      ? '--build'
      : null,
    ...updateScriptArgs.map(quote),
    quote(attrName),
  ]
    .filter(Boolean)
    .join(' ');

  try {
    await exec(cmd, execOptions);

    // nix-update may modify any .nix file in the repo — detect via git status
    const status = await getRepoStatus();
    const changedFiles = [...status.modified, ...status.not_added];

    if (!changedFiles.length) {
      return null;
    }

    return await Promise.all(
      changedFiles.map(async (filePath) => ({
        file: {
          type: 'addition' as const,
          path: filePath,
          contents: await readLocalFile(filePath),
        },
      })),
    );
  } catch (err) {
    logger.warn({ err }, 'nix-update: error running nix-update');
    return [
      {
        artifactError: {
          fileName: packageFileName,
          stderr: err.message,
        },
      },
    ];
  }
}
