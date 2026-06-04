import is from '@sindresorhus/is';
import { GlobalConfig } from '../../config/global.ts';
import type { RenovateConfig } from '../../config/types.ts';
import { logger } from '../../logger/index.ts';
import type { PackageFile } from '../../modules/manager/types.ts';
import type { Issue } from '../../modules/platform/index.ts';
import { platform } from '../../modules/platform/index.ts';
import { regEx } from '../../util/regex.ts';

/**
 * Per-input warning issues for machine-local flake inputs (e.g. `git+file://`
 * URLs or absolute `path:` inputs). These can only be fetched on the machine
 * that locked them, so Renovate cannot update them — and neither can anyone
 * else consuming the flake.
 *
 * Lifecycle:
 * - input with a local path detected -> ensure an open issue for it
 * - input fixed (or removed)        -> stamp a hidden marker and close
 * - local path detected again       -> reopen only if the marker is present;
 *                                      a user-closed issue (no marker) means
 *                                      "ignore this input" and stays closed
 * - `suppressNotifications: ["localPathWarningIssue"]` disables the feature
 */

export const LOCAL_PATH_FIXED_MARKER = '<!-- renovate:local-path-fixed -->';

const issueTitleRegex = regEx(
  /^Renovate: Flake input "(?<depName>.+)" uses a local path$/,
);

export function localPathIssueTitle(depName: string): string {
  return `Renovate: Flake input "${depName}" uses a local path`;
}

interface LocalPathInput {
  localPath: string;
  packageFile: string;
}

export function getLocalPathInputs(
  packageFiles: Record<string, PackageFile[]> | null,
): Map<string, LocalPathInput> {
  const detected = new Map<string, LocalPathInput>();
  for (const file of packageFiles?.nix ?? []) {
    for (const dep of file.deps) {
      const localPath = dep.managerData?.localPath;
      if (
        dep.skipReason === 'local-dependency' &&
        is.string(dep.depName) &&
        is.string(localPath) &&
        !detected.has(dep.depName)
      ) {
        detected.set(dep.depName, {
          localPath,
          packageFile: file.packageFile,
        });
      }
    }
  }
  return detected;
}

function warningBody(depName: string, input: LocalPathInput): string {
  return (
    `Renovate noticed that the flake input \`${depName}\` points to a **local path**:\n\n` +
    '```\n' +
    `${input.localPath}\n` +
    '```\n\n' +
    `Local paths only exist on the machine where the flake was last locked, so Renovate (and anyone else using this flake) cannot fetch or update this input.\n\n` +
    `## How to resolve\n\n` +
    `- **Fix it**: point the input back to a remote URL and run \`nix flake update ${depName}\`. Renovate will then close this issue automatically, and re-open it if a local path is detected again.\n` +
    `- **Ignore this input**: close this issue. Renovate will not remind you about \`${depName}\` again.\n` +
    `- **Ignore local paths entirely**: add \`"suppressNotifications": ["localPathWarningIssue"]\` to your Renovate config to never get these issues.\n\n` +
    `File: \`${input.packageFile}\`\n`
  );
}

function fixedBody(depName: string): string {
  return (
    `Renovate no longer detects a local path for the flake input \`${depName}\` — closing this issue. It will be re-opened if a local path is detected again.\n\n` +
    `${LOCAL_PATH_FIXED_MARKER}\n`
  );
}

// some platforms (e.g. GitLab) only list open issues and omit `state`
// entirely — treat anything not explicitly closed as open
function isOpen(issue: Issue): boolean {
  return issue.state !== 'closed';
}

async function closeWithMarker(
  depName: string,
  confidential: boolean | undefined,
): Promise<void> {
  const title = localPathIssueTitle(depName);
  // stamp the marker first so a future detection knows Renovate (not the
  // user) closed this issue and may reopen it
  await platform.ensureIssue({
    title,
    body: fixedBody(depName),
    once: false,
    shouldReOpen: false,
    confidential,
  });
  await platform.ensureIssueClosing(title);
}

async function getIssueBody(issue: Issue): Promise<string | undefined> {
  if (is.string(issue.body)) {
    return issue.body;
  }
  if (is.number(issue.number) && platform.getIssue) {
    return (await platform.getIssue(issue.number))?.body;
  }
  return undefined;
}

export async function ensureLocalPathInputIssues(
  config: RenovateConfig,
  packageFiles: Record<string, PackageFile[]> | null,
): Promise<void> {
  logger.debug('ensureLocalPathInputIssues()');
  if (config.mode === 'silent') {
    logger.debug(
      'Local path warning issues are not created, updated or closed when mode=silent',
    );
    return;
  }
  const detected = getLocalPathInputs(packageFiles);
  const suppressed = !!config.suppressNotifications?.includes(
    'localPathWarningIssue',
  );
  if (GlobalConfig.get('dryRun')) {
    logger.info(
      { localPathInputs: [...detected.keys()] },
      'DRY-RUN: Would ensure local path warning issues',
    );
    return;
  }
  const issues = (await platform.getIssueList()).filter(
    (i) => is.string(i.title) && issueTitleRegex.test(i.title),
  );

  // close open issues for inputs that are fixed/removed, or when suppressed
  for (const issue of issues) {
    const depName = issueTitleRegex.exec(issue.title!)!.groups!.depName;
    if (isOpen(issue) && (suppressed || !detected.has(depName))) {
      logger.debug(
        { depName, suppressed },
        'Closing local path warning issue with fixed marker',
      );
      await closeWithMarker(depName, config.confidential);
    }
  }

  if (suppressed) {
    logger.debug(
      { notificationName: 'localPathWarningIssue' },
      'Local path warning issues are suppressed',
    );
    return;
  }

  for (const [depName, input] of detected) {
    const title = localPathIssueTitle(depName);
    const existing = issues.filter((i) => i.title === title);
    const openIssue = existing.find(isOpen);
    if (!openIssue && existing.length) {
      // previously closed: reopen only if Renovate closed it as fixed
      const body = await getIssueBody(existing[existing.length - 1]);
      if (!body?.includes(LOCAL_PATH_FIXED_MARKER)) {
        logger.debug(
          { depName },
          'Local path warning issue was closed by the user, skipping',
        );
        continue;
      }
    }
    const res = await platform.ensureIssue({
      title,
      body: warningBody(depName, input),
      once: false,
      shouldReOpen: true,
      confidential: config.confidential,
    });
    if (res === 'created' || res === 'updated') {
      logger.info(
        { depName, localPath: input.localPath, res },
        'Local path warning issue ensured',
      );
    }
  }
}
