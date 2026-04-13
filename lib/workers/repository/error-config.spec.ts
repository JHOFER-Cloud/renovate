import { mock } from 'vitest-mock-extended';
import type { RenovateConfig } from '~test/util.ts';
import { partial, platform } from '~test/util.ts';
import { GlobalConfig } from '../../config/global.ts';
import { CONFIG_VALIDATION } from '../../constants/error-messages.ts';
import { logger } from '../../logger/index.ts';
import type { Pr } from '../../modules/platform/index.ts';
import {
  raiseConfigWarningIssue,
  raiseCredentialsWarningIssue,
  raiseRepositoryErrorIssue,
} from './error-config.ts';

let config: RenovateConfig;

beforeEach(() => {
  // default values
  config = partial<RenovateConfig>({
    onboardingBranch: 'configure/renovate',
    configWarningReuseIssue: true,
    confidential: false,
  });
});

describe('workers/repository/error-config', () => {
  describe('raiseConfigWarningIssue()', () => {
    beforeEach(() => {
      GlobalConfig.reset();
    });

    it('returns if mode is silent', async () => {
      config.mode = 'silent';

      const res = await raiseConfigWarningIssue(
        config,
        new Error(CONFIG_VALIDATION),
      );

      expect(res).toBeUndefined();

      expect(logger.debug).toHaveBeenCalledWith(
        'Config warning issues are not created, updated or closed when mode=silent',
      );
    });

    it('creates issues', async () => {
      const expectedBody = `There are missing credentials for the authentication-required feature. As a precaution, Renovate will pause PRs until it is resolved.

Location: \`package.json\`
Error type: some-error
Message: some-message
`;
      const error = new Error(CONFIG_VALIDATION);
      error.validationSource = 'package.json';
      error.validationMessage = 'some-message';
      error.validationError = 'some-error';
      platform.ensureIssue.mockResolvedValueOnce('created');

      const res = await raiseCredentialsWarningIssue(config, error);

      expect(res).toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        { configError: error, res: 'created' },
        'Configuration Warning',
      );
      expect(platform.ensureIssue).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ body: expectedBody }),
      );
    });

    it('creates issues (dryRun)', async () => {
      const error = new Error(CONFIG_VALIDATION);
      error.validationSource = 'package.json';
      error.validationMessage = 'some-message';
      platform.ensureIssue.mockResolvedValueOnce('created');
      GlobalConfig.set({ dryRun: 'full' });

      const res = await raiseConfigWarningIssue(config, error);

      expect(res).toBeUndefined();

      expect(logger.info).toHaveBeenCalledWith(
        { configError: error },
        'DRY-RUN: Would ensure configuration error issue',
      );
    });

    it('handles onboarding', async () => {
      const error = new Error(CONFIG_VALIDATION);
      error.validationSource = 'package.json';
      error.validationMessage = 'some-message';
      const pr = partial<Pr>({
        title: 'onboarding',
        number: 1,
        state: 'open',
      });
      platform.getBranchPr.mockResolvedValue(pr);

      const res = await raiseConfigWarningIssue(config, error);

      expect(res).toBeUndefined();
      expect(platform.updatePr).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ prTitle: pr.title, number: pr.number }),
      );
    });

    it('handles onboarding (dryRun)', async () => {
      const error = new Error(CONFIG_VALIDATION);
      error.validationSource = 'package.json';
      error.validationMessage = 'some-message';
      const pr = partial<Pr>({
        number: 1,
        state: 'open',
      });
      platform.getBranchPr.mockResolvedValue(pr);
      GlobalConfig.set({ dryRun: 'full' });

      const res = await raiseConfigWarningIssue(config, error);

      expect(res).toBeUndefined();

      expect(logger.info).toHaveBeenCalledWith(
        `DRY-RUN: Would update PR #${pr.number}`,
      );
    });

    it('disable issue creation on config failure', async () => {
      const notificationName = 'configErrorIssue';
      const error = new Error(CONFIG_VALIDATION);
      error.validationSource = 'package.json';
      error.validationMessage = 'some-message';
      config.suppressNotifications = [notificationName];
      platform.getBranchPr.mockResolvedValueOnce({
        ...mock<Pr>(),
        number: 1,
        state: '!open',
      });

      const res = await raiseConfigWarningIssue(config, error);

      expect(res).toBeUndefined();

      expect(logger.info).toHaveBeenCalledWith(
        { notificationName },
        'Configuration failure, issues will be suppressed',
      );
    });
  });

  describe('raiseRepositoryErrorIssue()', () => {
    beforeEach(() => {
      GlobalConfig.reset();
    });

    it('returns if mode is silent', async () => {
      config.mode = 'silent';
      const res = await raiseRepositoryErrorIssue(config, new Error('oops'));
      expect(res).toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith(
        'Repository error issues are not created, updated or closed when mode=silent',
      );
    });

    it('suppresses issue when suppressNotifications includes repositoryErrorIssue', async () => {
      config.suppressNotifications = ['repositoryErrorIssue'];
      const res = await raiseRepositoryErrorIssue(config, new Error('oops'));
      expect(res).toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith(
        { notificationName: 'repositoryErrorIssue' },
        'Repository error, issues will be suppressed',
      );
    });

    it('logs dry-run message instead of creating issue', async () => {
      GlobalConfig.set({ dryRun: 'full' });
      const error = new Error('oops');
      const res = await raiseRepositoryErrorIssue(config, error);
      expect(res).toBeUndefined();
      expect(platform.ensureIssue).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { err: error },
        'DRY-RUN: Would ensure repository error issue',
      );
    });

    it('dry-run takes precedence over suppressNotifications', async () => {
      GlobalConfig.set({ dryRun: 'full' });
      config.suppressNotifications = ['repositoryErrorIssue'];
      const error = new Error('oops');
      const res = await raiseRepositoryErrorIssue(config, error);
      expect(res).toBeUndefined();
      expect(platform.ensureIssue).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { err: error },
        'DRY-RUN: Would ensure repository error issue',
      );
    });

    it('creates issue with sanitized message and logs warning', async () => {
      platform.ensureIssue.mockResolvedValueOnce('created');
      const error = new Error('Invalid URL: https://token@example.com/repo');
      const res = await raiseRepositoryErrorIssue(config, error);
      expect(res).toBeUndefined();
      expect(platform.ensureIssue).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          title: 'Action Required: Fix Renovate Repository Error',
          body: expect.stringContaining('**redacted**'),
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        { err: error, res: 'created' },
        'Repository Error Warning',
      );
    });

    it('updates existing issue and logs warning', async () => {
      platform.ensureIssue.mockResolvedValueOnce('updated');
      const error = new Error('some error');
      const res = await raiseRepositoryErrorIssue(config, error);
      expect(res).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        { err: error, res: 'updated' },
        'Repository Error Warning',
      );
    });

    it('does not log warning when issue is unchanged', async () => {
      platform.ensureIssue.mockResolvedValueOnce(null);
      const res = await raiseRepositoryErrorIssue(config, new Error('oops'));
      expect(res).toBeUndefined();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
