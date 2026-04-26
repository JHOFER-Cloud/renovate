import { DEBUG, ERROR, FATAL, INFO, TRACE, WARN, nameFromLevel } from 'bunyan';
import { getProblems } from '../../logger/index.ts';
import { emojify } from '../../util/emoji.ts';

export function extractRepoProblems(
  repository: string | undefined,
): Set<string> {
  return new Set(
    getProblems()
      .filter(
        (problem) =>
          problem.repository === repository && !problem.artifactErrors,
      )
      .map((problem) => `${formatProblemLevel(problem.level)}: ${problem.msg}`),
  );
}

// Pull just the nix-update prefetch failures for this repo so we can post a
// dedicated user-facing issue. Identified by message prefix — artifacts.ts
// always emits `nix-update: failed to prefetch <attr> <path> (<fetcher>)`.
export function extractNixUpdateArtifactWarnings(
  repository: string | undefined,
): string[] {
  return Array.from(
    new Set(
      getProblems()
        .filter(
          (problem) =>
            problem.repository === repository &&
            problem.level >= WARN &&
            typeof problem.msg === 'string' &&
            problem.msg.startsWith('nix-update: failed to prefetch'),
        )
        .map((problem) => problem.msg),
    ),
  );
}

type EmojiLogLevelMapping = Record<number, string>;

const logLevelEmojis: EmojiLogLevelMapping = {
  [TRACE]: ':microscope:',
  [DEBUG]: ':mag:',
  [INFO]: ':information_source:',
  [WARN]: ':warning:',
  [ERROR]: ':x:',
  [FATAL]: ':skull:',
};

export function formatProblemLevel(level: number): string {
  const name = nameFromLevel[level].toUpperCase();
  const emojiName = logLevelEmojis[level];

  return `${emojify(emojiName)} ${name}`;
}
