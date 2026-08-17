import * as httpMock from '~test/http-mock.ts';
import { partial } from '~test/util.ts';
import { getConfig } from '../../../config/defaults.ts';
import { Result } from '../../../util/result.ts';
import * as lookup from '../../../workers/repository/process/lookup/index.ts';
import type { LookupUpdateConfig } from '../../../workers/repository/process/lookup/types.ts';
import { getPkgReleases, supportsDigests } from '../index.ts';
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
      // `(.+)` is greedy and backtracks to the final `/`, so the tag takes
      // everything up to the last segment.
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
    it('reports the pinned tag as the only version', async () => {
      // The tag is frozen by design — the digest is what moves. Reporting the
      // tag keeps the dep from being skipped as `invalid-value`.
      const res = await getPkgReleases({ datasource, packageName });

      expect(res).toMatchObject({
        sourceUrl: 'https://github.com/ghostty-org/ghostty',
        releases: [{ version: 'tip' }],
      });
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

  describe('getDigest', () => {
    const ds = new GithubReleaseAssetDatasource();

    it('returns the asset digest for the pinned tag', async () => {
      httpMock
        .scope(apiBaseUrl)
        .get('/repos/ghostty-org/ghostty/releases/tags/tip')
        .reply(200, {
          assets: [
            { name: 'ghostty-source.tar.gz', digest: 'sha256:aaa' },
            { name: 'ghostty-macos-universal.zip', digest },
          ],
        });

      expect(await ds.getDigest({ packageName }, 'tip')).toBe(digest);
    });

    it('returns null when the release cannot be fetched', async () => {
      // Rolling releases get deleted and recreated by CI, so a 404 is an
      // expected transient state, not a datasource failure.
      httpMock
        .scope(apiBaseUrl)
        .get('/repos/ghostty-org/ghostty/releases/tags/tip')
        .reply(404);

      expect(await ds.getDigest({ packageName }, 'tip')).toBeNull();
    });

    it('propagates a non-404 host error instead of caching a null', async () => {
      // Swallowing this would persist `null` for the whole cache TTL and report
      // "could not determine new digest" instead of an actionable host error.
      httpMock
        .scope(apiBaseUrl)
        .get('/repos/ghostty-org/ghostty/releases/tags/tip')
        .reply(403);

      await expect(ds.getDigest({ packageName }, 'tip')).rejects.toThrow(
        'Request failed with status code 403',
      );
    });

    it('returns null when the asset has no digest', async () => {
      httpMock
        .scope(apiBaseUrl)
        .get('/repos/ghostty-org/ghostty/releases/tags/tip')
        .reply(200, { assets: [{ name: 'ghostty-macos-universal.zip' }] });

      expect(await ds.getDigest({ packageName }, 'tip')).toBeNull();
    });

    it('returns null when the asset is missing from the release', async () => {
      httpMock
        .scope(apiBaseUrl)
        .get('/repos/ghostty-org/ghostty/releases/tags/tip')
        .reply(200, { assets: [{ name: 'other.zip', digest }] });

      expect(await ds.getDigest({ packageName }, 'tip')).toBeNull();
    });

    it('returns null when the release reports no assets', async () => {
      httpMock
        .scope(apiBaseUrl)
        .get('/repos/ghostty-org/ghostty/releases/tags/tip')
        .reply(200, {});

      expect(await ds.getDigest({ packageName }, 'tip')).toBeNull();
    });

    it('returns null when packageName is not an asset URL', async () => {
      expect(
        await ds.getDigest({ packageName: 'ghostty-org/ghostty' }, 'tip'),
      ).toBeNull();
    });
  });
  describe('lookup integration', () => {
    // The unit tests above cannot show that Renovate actually acts on the
    // digest. These two do: one proves an update is produced, the other proves
    // it stops once the file catches up.
    function lookupConfig(currentDigest: string): LookupUpdateConfig {
      return {
        ...partial<LookupUpdateConfig>(getConfig() as never),
        datasource,
        packageName,
        currentValue: 'tip',
        currentDigest,
        versioning: 'exact',
      };
    }

    it('is routed down the digest path', () => {
      expect(supportsDigests(datasource)).toBe(true);
    });

    it('produces a digest update when the artifact content changes', async () => {
      httpMock
        .scope(apiBaseUrl)
        .get('/repos/ghostty-org/ghostty/releases/tags/tip')
        .reply(200, {
          assets: [{ name: 'ghostty-macos-universal.zip', digest }],
        });

      const { updates } = await Result.wrap(
        lookup.lookupUpdates(lookupConfig(`sha256:${'0'.repeat(64)}`)),
      ).unwrapOrThrow();

      expect(updates).toMatchObject([
        { updateType: 'digest', newValue: 'tip', newDigest: digest },
      ]);
    });

    it('proposes nothing once the pinned digest already matches', async () => {
      httpMock
        .scope(apiBaseUrl)
        .get('/repos/ghostty-org/ghostty/releases/tags/tip')
        .reply(200, {
          assets: [{ name: 'ghostty-macos-universal.zip', digest }],
        });

      const { updates } = await Result.wrap(
        lookup.lookupUpdates(lookupConfig(digest)),
      ).unwrapOrThrow();

      expect(updates).toBeEmptyArray();
    });
  });
});
