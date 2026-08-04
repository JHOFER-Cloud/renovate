import { logger } from '../../../logger/index.ts';
import { withCache } from '../../../util/cache/package/with-cache.ts';
import { getApiBaseUrl, getSourceUrl } from '../../../util/github/url.ts';
import { GithubHttp } from '../../../util/http/github.ts';
import { regEx } from '../../../util/regex.ts';
import * as exactVersioning from '../../versioning/exact/index.ts';
import { Datasource } from '../datasource.ts';
import type { GetReleasesConfig, ReleaseResult } from '../types.ts';

interface GithubAsset {
  name: string;
  digest?: string | null;
}

interface GithubRelease {
  assets?: GithubAsset[];
}

// https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>
// The tag segment is matched non-greedily so tags containing `/` still work.
const assetUrlRegex = regEx(
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/(.+)\/([^/]+)$/,
);

export interface ParsedAssetUrl {
  repo: string;
  tag: string;
  assetName: string;
}

export function parseAssetUrl(url: string): ParsedAssetUrl | null {
  const m = assetUrlRegex.exec(url);
  if (!m) {
    return null;
  }
  return { repo: `${m[1]}/${m[2]}`, tag: m[3], assetName: m[4] };
}

/**
 * Reports the *content digest* of a GitHub release asset at a fixed tag.
 *
 * Renovate can already track a moving container tag (`docker`) or a moving git
 * ref (`github-digest`), but had no way to notice that the bytes behind a
 * stable release tag changed — the case of a `tip`/`nightly` release that is
 * re-published on every upstream commit. This fills that gap.
 *
 * `packageName` is the asset's own download URL, which makes the dependency
 * self-describing and lets callers pass through the URL they already have.
 * The single returned "release" is the asset's digest, so a content change
 * surfaces as an ordinary version change.
 */
export class GithubReleaseAssetDatasource extends Datasource {
  static readonly id = 'github-release-asset';

  override http: GithubHttp;

  constructor() {
    super(GithubReleaseAssetDatasource.id);
    this.http = new GithubHttp(GithubReleaseAssetDatasource.id);
  }

  override readonly defaultRegistryUrls = ['https://github.com'];

  override readonly defaultVersioning = exactVersioning.id;

  override readonly releaseTimestampSupport = false;

  override readonly sourceUrlSupport = 'package';
  override readonly sourceUrlNote =
    'The source URL is derived from the asset download URL.';

  getReleases(config: GetReleasesConfig): Promise<ReleaseResult | null> {
    return withCache(
      {
        namespace: `datasource-${GithubReleaseAssetDatasource.id}`,
        key: `${config.registryUrl}:${config.packageName}`,
      },
      () => this._getReleases(config),
    );
  }

  private async _getReleases({
    packageName,
    registryUrl,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    const parsed = parseAssetUrl(packageName);
    if (!parsed) {
      logger.debug(
        { packageName },
        'github-release-asset: packageName is not a GitHub release asset URL',
      );
      return null;
    }

    const apiBaseUrl = getApiBaseUrl(registryUrl);
    const url = `${apiBaseUrl}repos/${parsed.repo}/releases/tags/${parsed.tag}`;
    const { body: release } =
      await this.http.getJsonUnchecked<GithubRelease>(url);

    const asset = release.assets?.find((a) => a.name === parsed.assetName);
    // `digest` is only populated for assets uploaded since GitHub started
    // recording it; without one there is nothing to compare against.
    if (!asset?.digest) {
      logger.debug(
        { packageName, tag: parsed.tag },
        'github-release-asset: release asset has no digest',
      );
      return null;
    }

    return {
      sourceUrl: getSourceUrl(parsed.repo, registryUrl),
      releases: [{ version: asset.digest }],
    };
  }
}
