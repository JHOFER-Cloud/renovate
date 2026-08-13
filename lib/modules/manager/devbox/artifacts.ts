import { isNonEmptyArray } from '@sindresorhus/is';
import semver from 'semver';
import { quote } from 'shlex';
import { logger } from '../../../logger/index.ts';
import { exec } from '../../../util/exec/index.ts';
import type { ExecOptions } from '../../../util/exec/types.ts';
import { getSiblingFileName, readLocalFile } from '../../../util/fs/index.ts';
import type { UpdateArtifact, UpdateArtifactsResult } from '../types.ts';

export async function updateArtifacts({
  config: { constraints, isLockFileMaintenance },
  packageFileName,
  updatedDeps,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  const lockFileName = getSiblingFileName(packageFileName, 'devbox.lock');
  const existingLockFileContent = await readLocalFile(lockFileName, 'utf8');
  if (!existingLockFileContent) {
    logger.debug('No devbox.lock found');
    return null;
  }

  const supportsNoInstall = constraints?.devbox
    ? semver.intersects(constraints.devbox, '>=0.14.0')
    : true;

  const execOptions: ExecOptions = {
    cwdFile: packageFileName,
    // devbox spawns nix internally, but no nix toolConstraint: containerbase's
    // wrapper relocates the store dir and makes binary caches unusable, so the
    // image provides nix instead.
    // https://github.com/renovatebot/renovate/discussions/35382
    toolConstraints: [
      {
        toolName: 'devbox',
        constraint: constraints?.devbox,
      },
    ],
    docker: {},
  };

  const cmd = [];
  if (isLockFileMaintenance) {
    cmd.push(
      supportsNoInstall ? 'devbox update --no-install' : 'devbox update',
    );
  } else if (isNonEmptyArray(updatedDeps)) {
    if (supportsNoInstall) {
      const updateCommands: string[] = updatedDeps
        .map(
          (dep) =>
            dep.depName && `devbox update ${quote(dep.depName)} --no-install`,
        )
        .filter((dep): dep is string => Boolean(dep));
      if (updateCommands.length) {
        cmd.push(...updateCommands);
      } else {
        logger.trace('No updated devbox packages - returning null');
        return null;
      }
    } else {
      cmd.push('devbox install');
    }
  } else {
    logger.trace('No updated devbox packages - returning null');
    return null;
  }

  const oldLockFileContent = await readLocalFile(lockFileName);
  if (!oldLockFileContent) {
    logger.trace(`No ${lockFileName} found`);
    return null;
  }

  try {
    await exec(cmd, execOptions);
    const newLockFileContent = await readLocalFile(lockFileName);

    if (
      !newLockFileContent ||
      Buffer.compare(oldLockFileContent, newLockFileContent) === 0
    ) {
      return null;
    }
    logger.trace('Returning updated devbox.lock');
    return [
      {
        file: {
          type: 'addition',
          path: lockFileName,
          contents: newLockFileContent,
        },
      },
    ];
  } catch (err) {
    logger.warn({ err }, 'Error updating devbox.lock');
    return [
      {
        artifactError: {
          fileName: lockFileName,
          stderr: err.message,
        },
      },
    ];
  }
}
