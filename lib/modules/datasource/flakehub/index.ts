import { logger } from '../../../logger/index.ts';
import { withCache } from '../../../util/cache/package/with-cache.ts';
import { joinUrlParts } from '../../../util/url.ts';
import { Datasource } from '../datasource.ts';
import type {
  DigestConfig,
  GetReleasesConfig,
  ReleaseResult,
} from '../types.ts';
import { FlakeHubRelease } from './schema.ts';

export class FlakeHubDatasource extends Datasource {
  static readonly id = 'flakehub';

  constructor() {
    super(FlakeHubDatasource.id);
  }

  override readonly defaultRegistryUrls = ['https://api.flakehub.com'];

  override readonly releaseTimestampSupport = true;
  override readonly releaseTimestampNote =
    'The release timestamp is determined from the `published_at` field in the results.';
  override readonly sourceUrlSupport = 'package';
  override readonly sourceUrlNote =
    'The source URL is determined from the `repo_url` field in the results.';

  getReleases(config: GetReleasesConfig): Promise<ReleaseResult | null> {
    // Include currentValue in cache key since different constraints return different results
    const cacheKey = config.currentValue
      ? `${config.packageName}:${config.currentValue}`
      : config.packageName;
    return withCache(
      {
        namespace: `datasource-${FlakeHubDatasource.id}`,
        key: cacheKey,
        fallback: true,
      },
      () => this._getReleases(config),
    );
  }

  private async _getReleases({
    packageName,
    registryUrl,
    currentValue,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    /* v8 ignore next 3 -- should never happen */
    if (!registryUrl) {
      return null;
    }

    const releasesMap = new Map<string, typeof FlakeHubRelease._type>();
    let sourceUrl: string | undefined;

    try {
      // Query with specific version constraint or wildcard
      // The API returns the latest version matching the constraint
      const constraint = currentValue ?? '*';
      const url = joinUrlParts(
        registryUrl,
        `/version/${packageName}/${constraint}`,
      );
      const { body: result } = await this.http.getJson(url, FlakeHubRelease);

      if (result) {
        releasesMap.set(result.version, result);
        sourceUrl ??= result.repo_url;
      }

      if (releasesMap.size === 0) {
        return null;
      }

      // Transform releases to ReleaseResult
      const releases = Array.from(releasesMap.values()).map((rel) => {
        // Use simplified_version for URL updates, or strip +rev-... from version
        // Fallback: strip +rev-... suffix from full version
        const version = rel.simplified_version ?? rel.version.split('+')[0];
        return {
          version,
          gitRef: rel.revision,
          releaseTimestamp: rel.published_at,
          isDeprecated: !!rel.yanked_at,
        };
      });

      return {
        releases,
        sourceUrl,
      };
    } catch (err) {
      /* istanbul ignore next */
      const statusCode = err?.statusCode;
      /* istanbul ignore next */
      if (statusCode === 404) {
        logger.debug(
          { packageName, currentValue },
          'FlakeHub package not found',
        );
        return null;
      }
      /* istanbul ignore next */
      this.handleGenericErrors(err);
    }
  }

  override async getDigest(
    { packageName, registryUrl }: DigestConfig,
    newValue?: string,
  ): Promise<string | null> {
    // Query with specific version or wildcard
    const constraint = newValue ?? '*';
    const releases = await this.getReleases({
      packageName,
      registryUrl,
      currentValue: constraint,
    });

    if (!releases?.releases?.[0]) {
      return null;
    }

    // gitRef is required by schema but TypeScript doesn't know that
    return releases.releases[0].gitRef ?? null;
  }
}
