import { logger } from '../../../logger/index.ts';
import { withCache } from '../../../util/cache/package/with-cache.ts';
import { getApiBaseUrl, getSourceUrl } from '../../../util/github/url.ts';
import { GithubHttp } from '../../../util/http/github.ts';
import { regEx } from '../../../util/regex.ts';
import * as exactVersioning from '../../versioning/exact/index.ts';
import { Datasource } from '../datasource.ts';
import type {
  DigestConfig,
  GetReleasesConfig,
  ReleaseResult,
} from '../types.ts';

interface GithubAsset {
  name: string;
  digest?: string | null;
}

interface GithubRelease {
  assets?: GithubAsset[];
}

// https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>
// `(.+)` is greedy, so it backtracks to the *last* `/`: the tag captures
// everything up to the final segment, which is why tags containing `/`
// (e.g. `release/v1.2`) still parse correctly.
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
 * Tracks the **content digest** of a GitHub release asset at a fixed tag.
 *
 * Renovate can already follow a moving container tag (`docker`) and a moving
 * git ref (`github-digest`), but had no way to notice that the bytes behind a
 * *stable* release tag changed — the `tip`/`nightly` pattern, where a release
 * is re-published on every upstream commit.
 *
 * Modelled exactly like a Docker `:latest` pin: the value (the tag) is frozen
 * and the digest moves. `getReleases` therefore reports the tag itself as the
 * only version — `exact` versioning guarantees no version update is ever
 * proposed — and `getDigest` resolves the asset's current digest, so updates
 * flow through Renovate's digest path. That path terminates naturally: once the
 * new digest is written back, `currentDigest === newDigest` and the update is
 * dropped.
 *
 * `packageName` is the asset's own download URL, which keeps the dependency
 * self-describing and lets callers pass through the URL they already have.
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

  /**
   * Reports the pinned tag as the sole version. Combined with `exact`
   * versioning this can never yield a version bump — it exists so the dep
   * resolves a currentVersion instead of being skipped as `invalid-value`,
   * leaving the digest path to carry the actual update.
   */
  getReleases(config: GetReleasesConfig): Promise<ReleaseResult | null> {
    const parsed = parseAssetUrl(config.packageName);
    if (!parsed) {
      logger.debug(
        { packageName: config.packageName },
        'github-release-asset: packageName is not a GitHub release asset URL',
      );
      return Promise.resolve(null);
    }
    return Promise.resolve({
      sourceUrl: getSourceUrl(parsed.repo, config.registryUrl),
      releases: [{ version: parsed.tag }],
    });
  }

  override getDigest(
    { packageName, registryUrl }: DigestConfig,
    _newValue?: string,
  ): Promise<string | null> {
    const parsed = parseAssetUrl(packageName);
    if (!parsed) {
      return Promise.resolve(null);
    }
    return withCache(
      {
        namespace: `datasource-${GithubReleaseAssetDatasource.id}`,
        key: `digest:${registryUrl}:${packageName}`,
      },
      () => this._getDigest(parsed, registryUrl),
    );
  }

  private async _getDigest(
    parsed: ParsedAssetUrl,
    registryUrl: string | undefined,
  ): Promise<string | null> {
    const apiBaseUrl = getApiBaseUrl(registryUrl);
    const url = `${apiBaseUrl}repos/${parsed.repo}/releases/tags/${parsed.tag}`;

    let release: GithubRelease;
    try {
      ({ body: release } =
        await this.http.getJsonUnchecked<GithubRelease>(url));
    } catch (err) {
      // Rolling releases are routinely deleted and recreated by CI, so a 404
      // is an expected transient state rather than a datasource failure.
      logger.debug(
        { err, tag: parsed.tag, repo: parsed.repo },
        'github-release-asset: could not fetch release',
      );
      return null;
    }

    const asset = release.assets?.find((a) => a.name === parsed.assetName);
    // `digest` is only populated for assets uploaded since GitHub began
    // recording it; without one there is nothing to compare against.
    if (!asset?.digest) {
      logger.debug(
        { tag: parsed.tag, asset: parsed.assetName },
        'github-release-asset: release asset has no digest',
      );
      return null;
    }
    return asset.digest;
  }
}
