// TODO #22198
import { GlobalConfig } from '../../config/global.ts';
import type { RenovateConfig } from '../../config/types.ts';
import { logger } from '../../logger/index.ts';
import { sanitizeUrls } from '../../logger/utils.ts';
import type { PackageFile } from '../../modules/manager/types.ts';
import type { Pr } from '../../modules/platform/index.ts';
import { platform } from '../../modules/platform/index.ts';
import { getInheritedOrGlobal } from '../../util/common.ts';
import { sanitize } from '../../util/sanitize.ts';
import { getDepWarnings } from './errors-warnings.ts';

export function raiseConfigWarningIssue(
  config: RenovateConfig,
  error: Error,
): Promise<void> {
  logger.debug('raiseConfigWarningIssue()');
  const title = `Action Required: Fix Renovate Configuration`;
  const body = `There is an error with this repository's Renovate configuration that needs to be fixed. As a precaution, Renovate will stop PRs until it is resolved.\n\n`;
  const notificationName = 'configErrorIssue';
  return raiseWarningIssue(config, notificationName, title, body, error);
}

export function raiseCredentialsWarningIssue(
  config: RenovateConfig,
  error: Error,
): Promise<void> {
  logger.debug('raiseCredentialsWarningIssue()');
  const title = `Action Required: Add missing credentials`;
  const body = `There are missing credentials for the authentication-required feature. As a precaution, Renovate will pause PRs until it is resolved.\n\n`;
  const notificationName = 'missingCredentialsError';
  return raiseWarningIssue(config, notificationName, title, body, error);
}

export async function raiseRepositoryErrorIssue(
  config: RenovateConfig,
  error: Error,
): Promise<void> {
  logger.debug('raiseRepositoryErrorIssue()');
  if (config.mode === 'silent') {
    logger.debug(
      `Repository error issues are not created, updated or closed when mode=silent`,
    );
    return;
  }
  const notificationName = 'repositoryErrorIssue';
  if (GlobalConfig.get('dryRun')) {
    logger.info({ err: error }, 'DRY-RUN: Would ensure repository error issue');
    return;
  }
  if (config.suppressNotifications?.includes(notificationName)) {
    logger.info(
      { notificationName },
      'Repository error, issues will be suppressed',
    );
    return;
  }
  const title = `Action Required: Fix Renovate Repository Error`;
  const safeMessage = sanitize(sanitizeUrls(error.message)).slice(0, 150);
  const body = `Renovate encountered an unexpected error in this repository and has aborted. Please check the logs or contact your Renovate administrator for more details.\n\n**Error:** \`${safeMessage}\`\n`;
  const res = await platform.ensureIssue({
    title,
    body,
    once: false,
    shouldReOpen: true,
    confidential: config.confidential,
  });
  if (res === 'updated' || res === 'created') {
    logger.warn({ err: error, res }, 'Repository Error Warning');
  }
}

async function raiseWarningIssue(
  config: RenovateConfig,
  notificationName: string,
  title: string,
  initialBody: string,
  error: Error,
): Promise<void> {
  if (config.mode === 'silent') {
    logger.debug(
      `Config warning issues are not created, updated or closed when mode=silent`,
    );
    return;
  }
  let body = initialBody;
  if (error.validationSource) {
    body += `Location: \`${error.validationSource}\`\n`;
  }
  if (error.validationError) {
    body += `Error type: ${error.validationError}\n`;
  }
  if (error.validationMessage) {
    body += `Message: ${error.validationMessage}\n`;
  }

  const pr = await platform.getBranchPr(
    getInheritedOrGlobal('onboardingBranch')!,
    config.baseBranch,
  );
  if (pr?.state === 'open') {
    await handleOnboardingPr(pr, body);
    return;
  }

  if (GlobalConfig.get('dryRun')) {
    logger.info(
      { configError: error },
      'DRY-RUN: Would ensure configuration error issue',
    );
    return;
  }

  if (config.suppressNotifications?.includes(notificationName)) {
    logger.info(
      { notificationName },
      'Configuration failure, issues will be suppressed',
    );
    return;
  }

  const res = await platform.ensureIssue({
    title,
    body,
    once: false,
    shouldReOpen: config.configWarningReuseIssue,
    confidential: config.confidential,
  });
  if (res === 'updated' || res === 'created') {
    logger.warn({ configError: error, res }, 'Configuration Warning');
  }
}

async function handleOnboardingPr(pr: Pr, issueMessage: string): Promise<void> {
  logger.debug('Updating onboarding PR with config error notice');
  if (GlobalConfig.get('dryRun')) {
    logger.info(`DRY-RUN: Would update PR #${pr.number}`);
    return;
  }

  let prBody = `## Action Required: Fix Renovate Configuration\n\n${issueMessage}`;
  prBody += `\n\nOnce you have resolved this problem (in this onboarding branch), Renovate will return to providing you with a preview of your repository's configuration.`;

  try {
    await platform.updatePr({
      number: pr.number,
      prTitle: pr.title,
      prBody,
    });
  } catch (err) /* istanbul ignore next */ {
    logger.warn({ err }, 'Error updating onboarding PR');
  }
}

export async function raiseDependencyLookupWarningsIssue(
  config: RenovateConfig,
  packageFiles: Record<string, PackageFile[]>,
): Promise<void> {
  logger.debug('raiseDependencyLookupWarningsIssue()');
  if (config.mode === 'silent') {
    logger.debug(
      'Dependency lookup warning issues are not created, updated or closed when mode=silent',
    );
    return;
  }
  const notificationName = 'dependencyLookupWarnings';
  if (config.suppressNotifications?.includes(notificationName)) {
    logger.info(
      { notificationName },
      'Dependency lookup warnings, issues will be suppressed',
    );
    return;
  }
  const { warnings, warningFiles } = getDepWarnings(packageFiles);
  if (GlobalConfig.get('dryRun')) {
    logger.info(
      { warnings },
      warnings.length
        ? 'DRY-RUN: Would ensure dependency lookup warning issue'
        : 'DRY-RUN: Would close dependency lookup warning issue',
    );
    return;
  }
  if (!warnings.length) {
    await platform.ensureIssueClosing(
      `Action Required: Fix Dependency Lookup Errors`,
    );
    return;
  }
  const title = `Action Required: Fix Dependency Lookup Errors`;
  let body = `Renovate failed to look up the following dependencies. Please investigate and fix these issues in your repository.\n\n`;
  for (const w of warnings) {
    const line = w
      .split('\n')
      .join(' ')
      .trim()
      .replace(/#(\d)/g, '&#35;$1')
      .replace(/@/g, '&#64;');
    body += `- ${line}\n`;
  }
  body += `\nFiles affected: ${warningFiles.map((f) => '`' + f + '`').join(', ')}\n`;
  const res = await platform.ensureIssue({
    title,
    body,
    once: false,
    shouldReOpen: true,
    confidential: config.confidential,
  });
  if (res === 'updated' || res === 'created') {
    logger.warn({ warnings, res }, 'Dependency Lookup Warning');
  }
}
