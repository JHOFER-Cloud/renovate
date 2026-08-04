import * as httpMock from '~test/http-mock.ts';
import { getPkgReleases } from '../index.ts';
import { GithubReleaseAssetDatasource, parseAssetUrl } from './index.ts';

const apiBaseUrl = 'https://api.github.com';
const datasource = GithubReleaseAssetDatasource.id;
const packageName =
  'https://github.com/ghostty-org/ghostty/releases/download/tip/ghostty-macos-universal.zip';
const digest =
  'sha256:5b7c508e432c88c82265c84c2f15a5430dfd1ca68bf1675b2e166ccfd7829825';

describe('modules/datasource/github-release-asset/index', () => {
  describe('parseAssetUrl', () => {
    it('parses an asset download URL', () => {
      expect(parseAssetUrl(packageName)).toEqual({
        repo: 'ghostty-org/ghostty',
        tag: 'tip',
        assetName: 'ghostty-macos-universal.zip',
      });
    });

    it('parses a tag containing slashes', () => {
      expect(
        parseAssetUrl(
          'https://github.com/o/r/releases/download/release/v1.2/pkg.zip',
        ),
      ).toEqual({
        repo: 'o/r',
        tag: 'release/v1.2',
        assetName: 'pkg.zip',
      });
    });

    it('returns null for a non-asset URL', () => {
      expect(parseAssetUrl('https://github.com/o/r')).toBeNull();
      expect(parseAssetUrl('https://example.com/foo.zip')).toBeNull();
    });
  });

  describe('getReleases', () => {
    it('returns the asset digest as the version', async () => {
      httpMock
        .scope(apiBaseUrl)
        .get('/repos/ghostty-org/ghostty/releases/tags/tip')
        .reply(200, {
          assets: [
            { name: 'ghostty-source.tar.gz', digest: 'sha256:aaa' },
            { name: 'ghostty-macos-universal.zip', digest },
          ],
        });

      const res = await getPkgReleases({ datasource, packageName });

      expect(res).toMatchObject({
        sourceUrl: 'https://github.com/ghostty-org/ghostty',
        releases: [{ version: digest }],
      });
    });

    it('returns null when the asset has no digest', async () => {
      httpMock
        .scope(apiBaseUrl)
        .get('/repos/ghostty-org/ghostty/releases/tags/tip')
        .reply(200, {
          assets: [{ name: 'ghostty-macos-universal.zip' }],
        });

      expect(await getPkgReleases({ datasource, packageName })).toBeNull();
    });

    it('returns null when the asset is not in the release', async () => {
      httpMock
        .scope(apiBaseUrl)
        .get('/repos/ghostty-org/ghostty/releases/tags/tip')
        .reply(200, { assets: [{ name: 'other.zip', digest }] });

      expect(await getPkgReleases({ datasource, packageName })).toBeNull();
    });

    it('returns null when the release reports no assets', async () => {
      httpMock
        .scope(apiBaseUrl)
        .get('/repos/ghostty-org/ghostty/releases/tags/tip')
        .reply(200, {});

      expect(await getPkgReleases({ datasource, packageName })).toBeNull();
    });

    it('returns null when packageName is not an asset URL', async () => {
      expect(
        await getPkgReleases({
          datasource,
          packageName: 'ghostty-org/ghostty',
        }),
      ).toBeNull();
    });
  });
});
