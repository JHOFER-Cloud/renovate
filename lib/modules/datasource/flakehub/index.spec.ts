import * as httpMock from '~test/http-mock.ts';
import { getPkgReleases } from '../index.ts';
import { FlakeHubDatasource } from './index.ts';

const flakeCompatResponse = {
  version: '1.1.0+rev-ff81ac966bb2cae68946d5ed5fc4994f96d0ffec',
  simplified_version: '1.1.0',
  revision: 'ff81ac966bb2cae68946d5ed5fc4994f96d0ffec',
  commit_count: 69,
  description: 'Compatibility shim for Nix flakes',
  visibility: 'public',
  repo_url: 'https://github.com/edolstra/flake-compat',
  source_subdirectory: null,
  mirrored: false,
  yanked_at: null,
  readme: '# flake-compat\\n\\nA compatibility shim for Nix flakes.',
  published_at: '2024-12-04T12:00:00Z',
  updated_at: '2024-12-04T12:00:00Z',
  download_url:
    'https://api.flakehub.com/f/pinned/edolstra/flake-compat/1.1.0+rev-ff81ac966bb2cae68946d5ed5fc4994f96d0ffec/01234567-89ab-cdef-0123-456789abcdef/source.tar.gz',
  pretty_download_url:
    'https://flakehub.com/f/edolstra/flake-compat/1.1.0.tar.gz',
};

const baseUrl = 'https://api.flakehub.com';
const datasource = FlakeHubDatasource.id;

describe('modules/datasource/flakehub/index', () => {
  describe('getReleases', () => {
    it('returns null for empty result', async () => {
      httpMock.scope(baseUrl).get('/version/non-existent/package/*').reply(200);
      expect(
        await getPkgReleases({
          datasource,
          packageName: 'non-existent/package',
        }),
      ).toBeNull();
    });

    it('returns null for 404', async () => {
      httpMock.scope(baseUrl).get('/version/some/package/*').reply(404);
      expect(
        await getPkgReleases({ datasource, packageName: 'some/package' }),
      ).toBeNull();
    });

    it('returns null for unknown error', async () => {
      httpMock.scope(baseUrl).get('/version/some/package/*').replyWithError('');
      expect(
        await getPkgReleases({ datasource, packageName: 'some/package' }),
      ).toBeNull();
    });

    it('processes real data', async () => {
      httpMock
        .scope(baseUrl)
        .get('/version/edolstra/flake-compat/*')
        .reply(200, flakeCompatResponse);
      const res = await getPkgReleases({
        datasource,
        packageName: 'edolstra/flake-compat',
      });
      expect(res).not.toBeNull();
      expect(res).toBeDefined();
      expect(res?.sourceUrl).toBe('https://github.com/edolstra/flake-compat');
      expect(res?.releases).toHaveLength(1);
      expect(res?.releases[0]?.version).toBe('1.1.0');
      expect(res?.releases[0]?.gitRef).toBe(
        'ff81ac966bb2cae68946d5ed5fc4994f96d0ffec',
      );
    });

    it('uses currentValue as constraint', async () => {
      const unstableResponse = {
        version: '0.1.6176+rev-475921375def3eb930e1f8883f619ff8609accb6',
        simplified_version: '0.1.6176',
        revision: '475921375def3eb930e1f8883f619ff8609accb6',
        commit_count: 6176,
        repo_url: 'https://github.com/nix-community/home-manager',
        yanked_at: null,
        published_at: '2026-01-30T12:00:00Z',
      };

      httpMock
        .scope(baseUrl)
        .get('/version/nix-community/home-manager/0.1')
        .reply(200, unstableResponse);

      const res = await getPkgReleases({
        datasource,
        packageName: 'nix-community/home-manager',
        currentValue: '0.1',
      });

      expect(res?.releases).toHaveLength(1);
      expect(res?.releases[0]?.version).toBe('0.1.6176');
      expect(res?.releases[0]?.gitRef).toBe(
        '475921375def3eb930e1f8883f619ff8609accb6',
      );
    });

    it('extracts deprecated info for yanked releases', async () => {
      const yankedRelease = {
        version: '1.0.0+rev-0f9255e01c2351cc7d116c072cb317785dd33b33',
        simplified_version: '1.0.0',
        revision: '0f9255e01c2351cc7d116c072cb317785dd33b33',
        repo_url: 'https://github.com/test/test',
        yanked_at: '2024-01-01T00:00:00Z',
        published_at: '2023-12-01T00:00:00Z',
      };

      httpMock
        .scope(baseUrl)
        .get('/version/test/test/*')
        .reply(200, yankedRelease);

      const res = await getPkgReleases({
        datasource,
        packageName: 'test/test',
      });
      expect(res?.releases[0]?.isDeprecated).toBeTrue();
    });

    it('includes git refs', async () => {
      httpMock
        .scope(baseUrl)
        .get('/version/edolstra/flake-compat/*')
        .reply(200, flakeCompatResponse);
      const res = await getPkgReleases({
        datasource,
        packageName: 'edolstra/flake-compat',
      });
      expect(res?.releases[0]?.gitRef).toBe(
        'ff81ac966bb2cae68946d5ed5fc4994f96d0ffec',
      );
    });

    it('includes release timestamps', async () => {
      httpMock
        .scope(baseUrl)
        .get('/version/edolstra/flake-compat/*')
        .reply(200, flakeCompatResponse);
      const res = await getPkgReleases({
        datasource,
        packageName: 'edolstra/flake-compat',
      });
      expect(res?.releases[0]?.releaseTimestamp).toBe(
        '2024-12-04T12:00:00.000Z',
      );
    });

    it('detects updates for pinned versions', async () => {
      const newVersion = {
        version: '3.15.2',
        simplified_version: '3.15.2',
        revision: 'new222222222222222222222222222222222222',
        repo_url: 'https://github.com/test/test',
        yanked_at: null,
        published_at: '2026-01-21T00:00:00Z',
      };

      httpMock
        .scope(baseUrl)
        .get('/version/test/test/3.13.1')
        .reply(200, newVersion);

      const res = await getPkgReleases({
        datasource,
        packageName: 'test/test',
        currentValue: '3.13.1',
      });

      expect(res?.releases).toHaveLength(1);
      expect(res?.releases[0]?.version).toBe('3.15.2');
      expect(res?.releases[0]?.gitRef).toBe(
        'new222222222222222222222222222222222222',
      );
    });

    it('respects version constraints to stay within channels', async () => {
      const unstableVersion = {
        version: '0.1.2312+rev-unstable1111111111111111111111111111111',
        simplified_version: '0.1.2312',
        revision: 'unstable1111111111111111111111111111111',
        repo_url: 'https://github.com/test/test',
        yanked_at: null,
        published_at: '2026-01-30T00:00:00Z',
      };

      httpMock
        .scope(baseUrl)
        .get('/version/test/test/0.1')
        .reply(200, unstableVersion);

      const res = await getPkgReleases({
        datasource,
        packageName: 'test/test',
        currentValue: '0.1',
      });

      // Should only return version within the 0.1 constraint
      // and not upgrade to stable channels like 0.2511
      expect(res?.releases).toHaveLength(1);
      expect(res?.releases[0]?.version).toBe('0.1.2312');
      expect(res?.releases[0]?.gitRef).toBe(
        'unstable1111111111111111111111111111111',
      );
    });

    it('handles missing simplified_version by splitting full version', async () => {
      const releaseWithoutSimplified = {
        version: '1.0.0+rev-abc123',
        revision: 'abc123',
        repo_url: 'https://github.com/test/test',
        yanked_at: null,
        published_at: '2026-01-30T00:00:00Z',
      };

      httpMock
        .scope(baseUrl)
        .get('/version/test/test/*')
        .reply(200, releaseWithoutSimplified);

      const res = await getPkgReleases({
        datasource,
        packageName: 'test/test',
      });

      expect(res?.releases).toHaveLength(1);
      expect(res?.releases[0]?.version).toBe('1.0.0');
    });

    it('handles missing repo_url', async () => {
      const releaseWithoutRepoUrl = {
        version: '1.0.0+rev-abc123',
        simplified_version: '1.0.0',
        revision: 'abc123',
        yanked_at: null,
        published_at: '2026-01-30T00:00:00Z',
      };

      httpMock
        .scope(baseUrl)
        .get('/version/test/test/*')
        .reply(200, releaseWithoutRepoUrl);

      const res = await getPkgReleases({
        datasource,
        packageName: 'test/test',
      });

      expect(res?.releases).toHaveLength(1);
      expect(res?.sourceUrl).toBeUndefined();
    });
  });

  describe('getDigest', () => {
    it('returns latest revision when no version specified', async () => {
      httpMock
        .scope(baseUrl)
        .get('/version/edolstra/flake-compat/*')
        .reply(200, flakeCompatResponse);

      const ds = new FlakeHubDatasource();
      const digest = await ds.getDigest({
        packageName: 'edolstra/flake-compat',
        registryUrl: baseUrl,
      });

      expect(digest).toBe('ff81ac966bb2cae68946d5ed5fc4994f96d0ffec');
    });

    it('returns specific version revision', async () => {
      const v101Response = {
        version: '1.0.1',
        simplified_version: '1',
        revision: '0f9255e01c2351cc7d116c072cb317785dd33b33',
        repo_url: 'https://github.com/edolstra/flake-compat',
        yanked_at: null,
        published_at: '2024-11-15T10:00:00Z',
      };

      httpMock
        .scope(baseUrl)
        .get('/version/edolstra/flake-compat/1.0.1')
        .reply(200, v101Response);

      const ds = new FlakeHubDatasource();
      const digest = await ds.getDigest(
        {
          packageName: 'edolstra/flake-compat',
          registryUrl: baseUrl,
        },
        '1.0.1',
      );

      expect(digest).toBe('0f9255e01c2351cc7d116c072cb317785dd33b33');
    });

    it('returns null when version not found', async () => {
      httpMock
        .scope(baseUrl)
        .get('/version/edolstra/flake-compat/99.99.99')
        .reply(404);

      const ds = new FlakeHubDatasource();
      const digest = await ds.getDigest(
        {
          packageName: 'edolstra/flake-compat',
          registryUrl: baseUrl,
        },
        '99.99.99',
      );

      expect(digest).toBeNull();
    });
  });
});
