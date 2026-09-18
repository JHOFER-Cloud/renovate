import type { RenovateConfig } from '~test/util.ts';
import { partial, platform } from '~test/util.ts';
import { GlobalConfig } from '../../config/global.ts';
import { logger } from '../../logger/index.ts';
import type { PackageFile } from '../../modules/manager/types.ts';
import {
  LOCAL_PATH_FIXED_MARKER,
  ensureLocalPathInputIssues,
  getLocalPathInputs,
  localPathIssueTitle,
} from './local-path-issue.ts';

let config: RenovateConfig;

const localDep = {
  depName: 'my-local-flake',
  skipReason: 'local-dependency' as const,
  managerData: { localPath: 'file:///home/user/projects/my-local-flake' },
};

function nixPackageFiles(
  deps: PackageFile['deps'] = [localDep],
): Record<string, PackageFile[]> {
  return {
    nix: [partial<PackageFile>({ packageFile: 'flake.nix', deps })],
  };
}

beforeEach(() => {
  GlobalConfig.reset();
  config = partial<RenovateConfig>({
    confidential: false,
  });
  platform.getIssueList.mockResolvedValue([]);
});

describe('workers/repository/local-path-issue', () => {
  describe('getLocalPathInputs()', () => {
    it('handles null packageFiles', () => {
      expect(getLocalPathInputs(null).size).toBe(0);
    });

    it('ignores deps without local path data and dedupes', () => {
      const res = getLocalPathInputs(
        nixPackageFiles([
          localDep,
          localDep, // duplicate
          { depName: 'other', skipReason: 'unsupported-url' },
          { depName: 'no-data', skipReason: 'local-dependency' },
          { skipReason: 'local-dependency', managerData: { localPath: '/x' } },
        ]),
      );
      expect([...res.keys()]).toEqual(['my-local-flake']);
      expect(res.get('my-local-flake')).toEqual({
        localPath: 'file:///home/user/projects/my-local-flake',
        packageFile: 'flake.nix',
      });
    });
  });

  describe('ensureLocalPathInputIssues()', () => {
    it('does nothing if mode is silent', async () => {
      config.mode = 'silent';
      await ensureLocalPathInputIssues(config, nixPackageFiles());
      expect(platform.getIssueList).not.toHaveBeenCalled();
      expect(platform.ensureIssue).not.toHaveBeenCalled();
    });

    it('logs and returns in dry-run mode', async () => {
      GlobalConfig.set({ dryRun: 'full' });
      await ensureLocalPathInputIssues(config, nixPackageFiles());
      expect(logger.info).toHaveBeenCalledWith(
        { localPathInputs: ['my-local-flake'] },
        'DRY-RUN: Would ensure local path warning issues',
      );
      expect(platform.ensureIssue).not.toHaveBeenCalled();
    });

    it('creates an issue for a newly detected local path input', async () => {
      platform.ensureIssue.mockResolvedValueOnce('created');
      await ensureLocalPathInputIssues(config, nixPackageFiles());
      expect(platform.ensureIssue).toHaveBeenCalledExactlyOnceWith({
        title: localPathIssueTitle('my-local-flake'),
        body: expect.stringContaining(
          'file:///home/user/projects/my-local-flake',
        ),
        once: false,
        shouldReOpen: true,
        confidential: false,
      });
      expect(platform.ensureIssueClosing).not.toHaveBeenCalled();
    });

    it('updates an existing open issue without logging creation', async () => {
      platform.getIssueList.mockResolvedValue([
        {
          number: 1,
          state: 'open',
          title: localPathIssueTitle('my-local-flake'),
        },
      ]);
      platform.ensureIssue.mockResolvedValueOnce(null);
      await ensureLocalPathInputIssues(config, nixPackageFiles());
      expect(platform.ensureIssue).toHaveBeenCalledOnce();
      expect(platform.ensureIssueClosing).not.toHaveBeenCalled();
    });

    it('respects a user-closed issue and stays silent', async () => {
      platform.getIssueList.mockResolvedValue([
        {
          number: 1,
          state: 'closed',
          title: localPathIssueTitle('my-local-flake'),
          body: 'closed by user',
        },
      ]);
      await ensureLocalPathInputIssues(config, nixPackageFiles());
      expect(platform.ensureIssue).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        { depName: 'my-local-flake' },
        'Local path warning issue was closed by the user, skipping',
      );
    });

    it('reopens an issue closed by Renovate when the local path returns', async () => {
      platform.getIssueList.mockResolvedValue([
        {
          number: 1,
          state: 'closed',
          title: localPathIssueTitle('my-local-flake'),
          body: `fixed\n\n${LOCAL_PATH_FIXED_MARKER}\n`,
        },
      ]);
      platform.ensureIssue.mockResolvedValueOnce('updated');
      await ensureLocalPathInputIssues(config, nixPackageFiles());
      expect(platform.ensureIssue).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          title: localPathIssueTitle('my-local-flake'),
          shouldReOpen: true,
        }),
      );
    });

    it('fetches the closed issue body via getIssue when missing from the list', async () => {
      platform.getIssueList.mockResolvedValue([
        {
          number: 1,
          state: 'closed',
          title: localPathIssueTitle('my-local-flake'),
        },
      ]);
      platform.getIssue.mockResolvedValueOnce({
        number: 1,
        body: LOCAL_PATH_FIXED_MARKER,
      });
      platform.ensureIssue.mockResolvedValueOnce('updated');
      await ensureLocalPathInputIssues(config, nixPackageFiles());
      expect(platform.getIssue).toHaveBeenCalledWith(1);
      expect(platform.ensureIssue).toHaveBeenCalledOnce();
    });

    it('treats a closed issue without retrievable body as user-closed', async () => {
      platform.getIssueList.mockResolvedValue([
        {
          state: 'closed',
          title: localPathIssueTitle('my-local-flake'),
        },
      ]);
      await ensureLocalPathInputIssues(config, nixPackageFiles());
      expect(platform.getIssue).not.toHaveBeenCalled();
      expect(platform.ensureIssue).not.toHaveBeenCalled();
    });

    it('closes a stale issue with the fixed marker when input is fixed', async () => {
      platform.getIssueList.mockResolvedValue([
        {
          number: 1,
          state: 'open',
          title: localPathIssueTitle('old-input'),
        },
      ]);
      await ensureLocalPathInputIssues(config, nixPackageFiles());
      expect(platform.ensureIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: localPathIssueTitle('old-input'),
          body: expect.stringContaining(LOCAL_PATH_FIXED_MARKER),
          shouldReOpen: false,
          confidential: false,
        }),
      );
      expect(platform.ensureIssueClosing).toHaveBeenCalledExactlyOnceWith(
        localPathIssueTitle('old-input'),
      );
    });

    it('treats issues without a state field as open', async () => {
      // GitLab only lists open issues and omits `state` entirely
      platform.getIssueList.mockResolvedValue([
        { number: 1, title: localPathIssueTitle('my-local-flake') },
        { number: 2, title: localPathIssueTitle('old-input') },
      ]);
      platform.ensureIssue.mockResolvedValue(null);
      await ensureLocalPathInputIssues(config, nixPackageFiles());
      // stale stateless issue is closed as fixed
      expect(platform.ensureIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: localPathIssueTitle('old-input'),
          body: expect.stringContaining(LOCAL_PATH_FIXED_MARKER),
        }),
      );
      expect(platform.ensureIssueClosing).toHaveBeenCalledExactlyOnceWith(
        localPathIssueTitle('old-input'),
      );
      // detected stateless issue takes the open-issue update path
      expect(platform.ensureIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: localPathIssueTitle('my-local-flake'),
          shouldReOpen: true,
        }),
      );
      expect(platform.getIssue).not.toHaveBeenCalled();
    });

    it('ignores closed stale issues and unrelated issues', async () => {
      platform.getIssueList.mockResolvedValue([
        {
          number: 1,
          state: 'closed',
          title: localPathIssueTitle('old-input'),
        },
        { number: 2, state: 'open', title: 'Dependency Dashboard' },
        { number: 3, state: 'open' },
      ]);
      await ensureLocalPathInputIssues(config, null);
      expect(platform.ensureIssue).not.toHaveBeenCalled();
      expect(platform.ensureIssueClosing).not.toHaveBeenCalled();
    });

    it('closes open issues and creates nothing when suppressed', async () => {
      config.suppressNotifications = ['localPathWarningIssue'];
      platform.getIssueList.mockResolvedValue([
        {
          number: 1,
          state: 'open',
          title: localPathIssueTitle('my-local-flake'),
        },
      ]);
      await ensureLocalPathInputIssues(config, nixPackageFiles());
      expect(platform.ensureIssue).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          title: localPathIssueTitle('my-local-flake'),
          body: expect.stringContaining(LOCAL_PATH_FIXED_MARKER),
        }),
      );
      expect(platform.ensureIssueClosing).toHaveBeenCalledExactlyOnceWith(
        localPathIssueTitle('my-local-flake'),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        { notificationName: 'localPathWarningIssue' },
        'Local path warning issues are suppressed',
      );
    });
  });
});
