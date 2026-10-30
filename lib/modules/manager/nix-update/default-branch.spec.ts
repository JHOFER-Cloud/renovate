import * as httpMock from '~test/http-mock.ts';
import { explicitBranch, getDefaultBranch } from './default-branch.ts';

const api = 'https://api.github.com';

describe('modules/manager/nix-update/default-branch', () => {
  describe('explicitBranch', () => {
    it('reads nix-update syntax --version=branch=<name>', () => {
      expect(explicitBranch(['--version=branch=develop'])).toBe('develop');
    });

    it('still reads --version=branch:<name>', () => {
      expect(explicitBranch(['--version=branch:develop'])).toBe('develop');
    });

    it('keeps slashes in branch names', () => {
      expect(explicitBranch(['--version=branch=chore/update_yarn'])).toBe(
        'chore/update_yarn',
      );
    });

    it('returns null for a bare --version=branch', () => {
      expect(explicitBranch(['--version=branch'])).toBeNull();
      expect(explicitBranch([])).toBeNull();
    });
  });

  describe('getDefaultBranch', () => {
    it('returns the repository default branch', async () => {
      httpMock
        .scope(api)
        .get('/repos/owner/repo')
        .reply(200, { default_branch: 'master' });
      await expect(getDefaultBranch('owner/repo')).resolves.toBe('master');
    });

    it('returns null when the response has no default branch', async () => {
      httpMock.scope(api).get('/repos/owner/empty').reply(200, {});
      await expect(getDefaultBranch('owner/empty')).resolves.toBeNull();
    });

    it('returns null for a repository that does not exist', async () => {
      httpMock.scope(api).get('/repos/owner/gone').reply(404);
      await expect(getDefaultBranch('owner/gone')).resolves.toBeNull();
    });

    it('propagates other errors instead of skipping the package', async () => {
      httpMock.scope(api).get('/repos/owner/flaky').reply(500);
      // GithubHttp turns a 5xx into an ExternalHostError, which Renovate
      // reports as a host problem and retries next run
      await expect(getDefaultBranch('owner/flaky')).rejects.toThrow(
        'external-host-error',
      );
    });
  });
});
