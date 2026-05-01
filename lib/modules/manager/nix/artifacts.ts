import { isNonEmptyStringAndNotWhitespace } from '@sindresorhus/is';
import { quote } from 'shlex';
import { logger } from '../../../logger/index.ts';
import { findGithubToken } from '../../../util/check-token.ts';
import { exec } from '../../../util/exec/index.ts';
import type { ExecOptions } from '../../../util/exec/types.ts';
import {
  ensureCacheDir,
  getSiblingFileName,
  readLocalFile,
  writeLocalFile,
} from '../../../util/fs/index.ts';
import { getGitEnvironmentVariables } from '../../../util/git/auth.ts';
import { getRepoStatus } from '../../../util/git/index.ts';
import * as hostRules from '../../../util/host-rules.ts';
import type { UpdateArtifact, UpdateArtifactsResult } from '../types.ts';

export async function updateArtifacts({
  packageFileName,
  config,
  updatedDeps,
  newPackageFileContent,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  const lockFileName = getSiblingFileName(packageFileName, 'flake.lock');
  const existingLockFileContent = await readLocalFile(lockFileName);

  logger.trace({ packageFileName, updatedDeps }, 'nix.updateArtifacts');

  if (!existingLockFileContent) {
    logger.debug('No flake.lock found');
    return null;
  }

  await writeLocalFile(packageFileName, newPackageFileContent);

  let cmd = `nix --extra-experimental-features 'nix-command flakes' `;

  const token = findGithubToken(
    hostRules.find({
      hostType: 'github',
      url: 'https://api.github.com/',
    }),
  );

  // Build --extra-access-tokens: main token plus any per-org cross-org trust tokens.
  // Use a Map keyed by host string to deduplicate in case the same org appears
  // in hostRules more than once.
  const accessTokenMap = new Map<string, string>();
  if (token) {
    accessTokenMap.set('github.com', token);
  }
  // Per-org rules have matchHost like 'https://github.com/OrgName/' (set by cross-org trust groups)
  for (const rule of hostRules.getAll()) {
    if (rule.hostType !== 'github' || !rule.matchHost) {
      continue;
    }
    try {
      const ruleUrl = new URL(rule.matchHost);
      const pathParts = ruleUrl.pathname.split('/').filter(Boolean);
      if (ruleUrl.hostname === 'github.com' && pathParts.length === 1) {
        const orgToken = findGithubToken(rule);
        if (orgToken) {
          accessTokenMap.set(`github.com/${pathParts[0]}`, orgToken);
        }
      }
    } catch {
      // matchHost is not a URL (e.g. bare hostname), skip
    }
  }
  if (accessTokenMap.size > 0) {
    const tokenStr = [...accessTokenMap.entries()]
      .map(([host, tok]) => `${host}=${tok}`)
      .join(' ');
    cmd += `--extra-access-tokens ${quote(tokenStr)} `;
  }

  if (config.isLockFileMaintenance) {
    cmd += 'flake update';
  } else {
    const inputs = updatedDeps
      .map(({ depName }: { depName?: string }) => depName)
      .filter(isNonEmptyStringAndNotWhitespace)
      .map((depName: string) => quote(depName))
      .join(' ');
    cmd += `flake update ${inputs}`;
  }
  const execOptions: ExecOptions = {
    cwdFile: packageFileName,
    extraEnv: {
      ...getGitEnvironmentVariables(),
      NIX_CACHE_HOME: await ensureCacheDir('nix'),
    },
    toolConstraints: [
      {
        toolName: 'nix',
        constraint: config.constraints?.nix,
      },
    ],
    docker: {},
  };

  try {
    await exec(cmd, execOptions);

    const status = await getRepoStatus();
    if (!status.modified.includes(lockFileName)) {
      return null;
    }
    logger.debug('Returning updated flake.lock');
    return [
      {
        file: {
          type: 'addition',
          path: lockFileName,
          contents: await readLocalFile(lockFileName),
        },
      },
    ];
  } catch (err) {
    logger.warn({ err }, 'Error updating flake.lock');
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
