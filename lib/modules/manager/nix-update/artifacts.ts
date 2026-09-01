import { createHash } from 'node:crypto';
import { GlobalConfig } from '../../../config/global.ts';
import { logger } from '../../../logger/index.ts';
import { coerceArray } from '../../../util/array.ts';
import { findGithubToken } from '../../../util/check-token.ts';
import { readLocalFile, writeLocalFile } from '../../../util/fs/index.ts';
import { getGitEnvironmentVariables } from '../../../util/git/auth.ts';
import { getRepoStatus } from '../../../util/git/index.ts';
import * as hostRules from '../../../util/host-rules.ts';
import { regEx } from '../../../util/regex.ts';
import { parseUrl } from '../../../util/url.ts';
import { getPkgReleases } from '../../datasource/index.ts';
import type {
  ArtifactError,
  UpdateArtifact,
  UpdateArtifactsResult,
  Upgrade,
} from '../types.ts';
import type { FodInfo } from './types.ts';
import { buildKnownSrcExpr, classifyFod } from './fetchers.ts';
import { assertSubstitutableStore, prefetch } from './prefetch.ts';
import {
  rewriteHash,
  rewriteRev,
  rewriteUnstableDate,
  rewriteUrl,
} from './rewrite.ts';

export async function updateArtifacts({
  packageFileName,
  updatedDeps,
  newPackageFileContent,
  config,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  const dep = updatedDeps[0];
  const md = dep?.managerData as
    | {
        attrName?: string;
        system?: string;
        pname?: string | null;
        isBranchTracked?: boolean;
        fods?: FodInfo[];
      }
    | undefined;

  const attrName = md?.attrName;
  const pkgSystem = md?.system;
  const pname = md?.pname ?? null;
  const isBranchTracked = md?.isBranchTracked === true;
  const fods = coerceArray(md?.fods);

  if (!attrName || !pkgSystem || !fods.length) {
    return null;
  }

  // Resolve flake path. Renovate sets localDir to the cloned repo root,
  // which is where flake.nix lives.
  const flakePath = GlobalConfig.get('localDir');
  if (!flakePath) {
    logger.warn(
      'nix-update: no localDir configured, cannot resolve flake path',
    );
    return null;
  }

  // Captured before we touch the file: what the package file looked like
  // going into this update (base branch, or the existing PR branch on reuse).
  // `abandon` below hands it back to revert a half-finished update.
  const originalContent = await readLocalFile(packageFileName, 'utf8');

  // The version bump lands in the commit whether or not this function
  // succeeds — Renovate already has it in `updatedPackageFiles`. Bailing out
  // with only an artifactError therefore ships a package whose `version` moved
  // while its `src` url/hash did not: a derivation that builds green and
  // fetches the *old* artifact. Returning the pre-update content as an
  // artifact file undoes that — artifacts are written after package files in
  // `commitFilesToBranch`, so the bump is overwritten and the branch ends up
  // with no diff, to be retried on the next run.
  function abandon(stderr: string): UpdateArtifactsResult[] {
    const results: UpdateArtifactsResult[] = [];
    if (originalContent && originalContent !== newPackageFileContent) {
      results.push({
        file: {
          type: 'addition',
          path: packageFileName,
          contents: originalContent,
        },
      });
    }
    results.push({
      artifactError: { fileName: packageFileName, stderr },
    });
    return results;
  }

  // Write the version-bumped content first (renovate's auto-replace already
  // produced this — we just need it on disk so any same-package eval reads
  // the new version).
  await writeLocalFile(packageFileName, newPackageFileContent);

  // Auth: pass GitHub/GitLab tokens through env so private fetchers work.
  const extraEnv = buildExtraEnv();

  const substituters = usableSubstituters(config.nixSubstituters);
  // Keys are admin-owned: a repo supplying its own would let a cache it
  // controls serve signed, input-addressed paths (stdenv, bash) into a store
  // every repo shares. Content-addressed paths need no signature — they are
  // verified against their hash instead — so a keyless cache is not inert.
  const trustedPublicKeys = coerceArray(
    GlobalConfig.get('nixTrustedPublicKeys'),
  );
  if (substituters.length && !trustedPublicKeys.length) {
    logger.warn(
      { substituters },
      'nix-update: nixSubstituters configured but the bot has no nixTrustedPublicKeys, so nix will reject their signed paths',
    );
  }

  // Fingerprint flake.lock so the prefetch cache invalidates if Renovate's
  // double-eval rebases the working tree onto a flake.lock with a different
  // `nixpkgs` revision (which changes runner-side fetcher/builder semantics).
  // Empty string when the file isn't present — cache still works, just keyed
  // uniformly across this run.
  const lockContent = await readLocalFile('flake.lock', 'utf8');
  const flakeLockFingerprint = lockContent
    ? createHash('sha256').update(lockContent).digest('hex')
    : '';

  // Splice the bumped version into url/rev/name. Without this, every prefetch
  // would just confirm the existing hash for the OLD version. Renovate has
  // already bumped the version in newPackageFileContent; we mirror that into
  // the fetcher inputs we pass to nix-build.
  const newVersion = dep.newVersion ?? dep.newValue ?? null;
  const newDigest = dep.newDigest ?? null;
  const bumpedFods = fods.map((fod) =>
    bumpFodToNewVersion(
      fod,
      dep.currentValue,
      newVersion,
      dep.currentDigest,
      newDigest,
    ),
  );

  let content = newPackageFileContent;

  // If the lookup surfaced an explicit downloadUrl (custom datasources can
  // return one), the src URL's shape may have changed in ways simple version
  // substitution can't reconstruct — e.g. Raycast embeds a per-release commit
  // hash in the DMG filename. Override the src FOD's url before classify so
  // the prefetch hits the right artifact, and rewrite the .nix file to keep
  // the literal url in sync.
  const errors: ArtifactError[] = [];

  // These rewrites run before the prefetch loop so a failure aborts before we
  // spend nix-build time — but they must not throw out of updateArtifacts, or
  // getUpdatedPackageFiles() fails for the whole branch instead of surfacing a
  // per-package problem. Collect failures the same way the FOD loop does.
  try {
    const downloadUrl = dep.downloadUrl;
    if (downloadUrl) {
      for (const fod of bumpedFods) {
        if (fod.attrPath.length === 1 && fod.attrPath[0] === 'src') {
          const oldUrl = fod.inputs.url;
          if (oldUrl && oldUrl !== downloadUrl) {
            content = rewriteUrl(content, {
              attrPath: fod.attrPath,
              oldUrl,
              newUrl: downloadUrl,
            });
            fod.inputs.name = retargetFetcherName(
              fod.inputs.name,
              oldUrl,
              downloadUrl,
            );
            fod.inputs.url = downloadUrl;
          }
          break;
        }
      }
    }

    // Branch-tracked packages pin a literal commit in `rev`. Renovate's
    // auto-replace is skipped for managers that define `updateDependency`, and
    // ours intentionally does nothing when currentValue === newValue (both are
    // the branch name), so this is the only place the new commit can reach the
    // file.
    //
    // Gate on isBranchTracked, NOT on currentDigest alone: `--version=skip`
    // deps also carry a digest (the artifact's content hash), but their src is
    // a plain fetchurl with no `rev` to rewrite — for those the hash rewrite in
    // the FOD loop below is the whole update.
    if (
      isBranchTracked &&
      dep.currentDigest &&
      newDigest &&
      dep.currentDigest !== newDigest
    ) {
      const srcFod = bumpedFods.find((fod) => fod.attrPath.at(-1) === 'src');
      if (srcFod) {
        content = rewriteRev(content, {
          attrPath: srcFod.attrPath,
          oldRev: dep.currentDigest,
          newRev: newDigest,
        });
      }
      content = await bumpUnstableDate(content, dep);
    }
  } catch (err) {
    logger.warn(
      { err, attrName },
      'nix-update: failed to rewrite package metadata',
    );
    errors.push({
      fileName: packageFileName,
      stderr: err instanceof Error ? err.message : String(err),
    });
  }

  // Bail before the prefetch loop: the rewrites above failed, so whatever the
  // nix-build produced would be discarded by the early return at the end
  // anyway. Vendor prefetches cost minutes of runner time.
  if (errors.length) {
    return abandon(errors.map((e) => e.stderr).join('\n'));
  }

  // Checked once per package rather than per FOD: it is an infrastructure
  // fault, so repeating it for every hash would just multiply the noise.
  try {
    await assertSubstitutableStore(config.constraints?.nix);
  } catch (err) {
    logger.warn({ err, attrName }, 'nix-update: unusable nix store');
    return abandon(err instanceof Error ? err.message : String(err));
  }

  // Classify all FODs. Hard-fail surface area is the classifier — anything
  // unsupported throws here, before any nix-build runs.
  const classifiedFods = bumpedFods.map((fod) =>
    classifyFod(fod, pname, newVersion),
  );
  // Run src first; vendor builders need src already in the runner's store.
  const classified = [
    ...classifiedFods.filter((fod) => fod.isSrc),
    ...classifiedFods.filter((fod) => !fod.isSrc),
  ];
  // Map src fods (by attrPath joined) → known new hash, for vendor srcExpr.
  const srcHashes = new Map<string, string>();

  for (const fod of classified) {
    try {
      // For vendor FODs, splice the *now-known* src hash into the srcExpr.
      // We expect exactly one src FOD per package; pick the first known.
      const srcExpr = fod.isSrc
        ? ''
        : pickSrcExprFor(bumpedFods, srcHashes, flakePath);

      const expr = fod.buildExpr(flakePath, srcExpr);
      const newHash = await prefetch({
        expr,
        pkgSystem,
        algo: fod.algo,
        extraEnv,
        substituters,
        trustedPublicKeys,
        nixConstraint: config.constraints?.nix,
        flakeLockFingerprint,
      });

      // Skip rewrite if the file already has the new hash. Two cases:
      //   1) The package's hash didn't actually change (newHash equals the
      //      hash captured at extract time).
      //   2) Renovate is reusing an existing PR branch whose file already
      //      had the hash updated by a prior run; `newPackageFileContent` is
      //      branch content, not main, so `currentHash` from extract no
      //      longer matches what's in the file. Detecting via
      //      `content.includes(newHash)` covers both.
      if (
        (fod.currentHash && newHash === fod.currentHash) ||
        content.includes(newHash)
      ) {
        logger.trace(
          { attrPath: fod.attrPath, hash: newHash },
          'nix-update: file already has the target hash, skipping rewrite',
        );
      } else {
        content = rewriteHash(content, {
          attrPath: fod.attrPath,
          oldHash: fod.currentHash,
          newHash,
        });
      }

      if (fod.isSrc) {
        srcHashes.set(fod.attrPath.join('.'), newHash);
      }
    } catch (err) {
      // Per-package, per-FOD warning. Renovate posts this in the dependency
      // dashboard's "Repository Problems" so the *user* (not the renovate
      // admin) knows what to fix. The specifics — package name and FOD
      // attribute path — live in the metadata so each failure stays
      // distinguishable while the message can still be grouped in metrics.
      logger.warn(
        {
          err,
          attrName,
          attrPath: fod.attrPath,
          fetcher: fod.fetcherName,
        },
        'nix-update: failed to prefetch FOD',
      );
      errors.push({
        fileName: packageFileName,
        stderr: `${fod.fetcherName} (${fod.attrPath.join('.')}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  if (errors.length) {
    // One artifactError summarises all per-FOD failures for this package.
    return abandon(errors.map((e) => e.stderr).join('\n'));
  }

  // Success: write the rewritten file (if changed), pick up any side-effect
  // file changes via git status.
  if (content !== newPackageFileContent) {
    await writeLocalFile(packageFileName, content);
  }

  const status = await getRepoStatus();
  const changedFiles = new Set<string>([
    ...status.modified,
    ...status.not_added,
  ]);
  // Always include the package file we wrote — git status may not report it
  // as modified yet (write happened just above; not committed).
  if (content !== newPackageFileContent) {
    changedFiles.add(packageFileName);
  }

  if (!changedFiles.size) {
    return null;
  }

  return Promise.all(
    [...changedFiles].map(async (filePath) => ({
      file: {
        type: 'addition' as const,
        path: filePath,
        contents: await readLocalFile(filePath),
      },
    })),
  );
}

// nixpkgs encodes the pinned commit's date in the version of branch-tracked
// packages (`<base>-unstable-YYYY-MM-DD`).
//
// The date can't come off the upgrade: branch-tracked packages only ever
// produce a *digest* update, and Renovate builds those as a bare
// `{ updateType, newValue, newDigest }` — `releaseTimestamp` is set in
// `generateUpdate()`, which digest updates never reach. So resolve it through
// the datasource layer instead, which is also where the commit date legitimately
// lives (`github-digest` derives its release timestamp from it). The result is
// already cached — the same lookup ran for this dep earlier in the run.
//
// Returns content unchanged whenever the date can't be established; a stale
// date is cosmetic, a wrong one is not.
async function bumpUnstableDate(
  content: string,
  dep: Upgrade,
): Promise<string> {
  const { datasource, packageName, currentValue } = dep;
  if (!datasource || !packageName || !currentValue) {
    return content;
  }
  let timestamp: string | null | undefined;
  try {
    const releases = await getPkgReleases({
      datasource,
      packageName,
      currentValue,
      versioning: dep.versioning,
    });
    timestamp = releases?.releases.find(
      (r) => r.version === currentValue,
    )?.releaseTimestamp;
  } catch (err) {
    // getPkgReleases re-throws ExternalHostError, rate limiting and 5xx. The
    // date is cosmetic — never let a transient lookup failure discard an
    // otherwise-complete rev + hash update.
    logger.debug(
      { err, packageName },
      'nix-update: could not resolve commit date, leaving unstable date as-is',
    );
    return content;
  }
  const newDate = regEx(/^(\d{4}-\d{2}-\d{2})/).exec(timestamp ?? '');
  return newDate ? rewriteUnstableDate(content, newDate[1]) : content;
}

// Replace the OLD version (and/or digest) with the NEW one across the fetcher
// inputs. Most packages encode version into the URL or rev (e.g.
// `archive/v0.0.60.tar.gz` or `rev = "v0.0.60"`); renovate-side string-replace
// covers ~all real-world cases without re-evaluating the package.
//
// We normalise a leading "v" out of currentValue/newVersion before swapping,
// because Renovate's github-tags datasource may report the version as
// `v0.0.61` (matching the tag) while the package's nix `version` attribute
// is bare `0.0.60`. Without normalisation a naive replace would yield
// `vv0.0.61` in URLs and revs.
//
// Branch-tracked packages use currentDigest/newDigest instead of version.
function bumpFodToNewVersion(
  fod: FodInfo,
  oldVersion: string | undefined | null,
  newVersion: string | undefined | null,
  oldDigest: string | undefined | null,
  newDigest: string | undefined | null,
): FodInfo {
  function swap(
    s: string | null,
    from: string | null | undefined,
    to: string | null | undefined,
  ): string | null {
    if (s === null || !from || !to || from === to) {
      return s;
    }
    return s.split(from).join(to);
  }

  function stripV(s: string): string {
    return s.length > 1 &&
      (s.startsWith('v') || s.startsWith('V')) &&
      regEx(/\d/).test(s[1])
      ? s.slice(1)
      : s;
  }
  let { url, rev, name } = fod.inputs;
  if (oldVersion && newVersion) {
    // Replace the bare-number form. Any leading `v` in url/rev sticks; the
    // bare version inside it gets bumped.
    const oldBare = stripV(oldVersion);
    const newBare = stripV(newVersion);
    url = swap(url, oldBare, newBare);
    rev = swap(rev, oldBare, newBare);
    name = swap(name, oldBare, newBare);
  }
  if (oldDigest && newDigest) {
    url = swap(url, oldDigest, newDigest);
    rev = swap(rev, oldDigest, newDigest);
    name = swap(name, oldDigest, newDigest);
  }
  return { ...fod, inputs: { ...fod.inputs, url, rev, name } };
}

// `fetchurl` defaults its derivation name to `baseNameOf url`, so the name
// captured at extract time is usually the *old* URL's basename — and
// `bumpFodToNewVersion` swapped the version into both. A downloadUrl replaces
// the URL wholesale, which leaves that derived name stale. It is not merely
// cosmetic: a fixed-output path is `<outputHash>-<name>`, so prefetching under
// the stale name realises the artifact somewhere real evaluation never looks,
// costing the substituter hit — and the build log then names a file that was
// never fetched, which is exactly how a prefetch failure reads as the wrong URL.
//
// Re-derive only when the name demonstrably came from the URL. An explicit
// `name = "..."` in the package belongs to the package, not the URL, and its
// basename won't match — leave those untouched.
function retargetFetcherName(
  name: string | null,
  oldUrl: string,
  newUrl: string,
): string | null {
  if (!name || name !== urlBaseName(oldUrl)) {
    return name;
  }
  return urlBaseName(newUrl);
}

// Mirrors nix's `baseNameOf`: everything after the last slash, query string
// included — nix does no URL parsing here, and neither does fetchurl.
function urlBaseName(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

function pickSrcExprFor(
  allFods: FodInfo[],
  srcHashes: Map<string, string>,
  flakePath: string,
): string {
  const srcFod = allFods.find((f) => f.attrPath.at(-1) === 'src');
  if (!srcFod) {
    throw new Error(
      'vendor FOD requires a src to rebuild on the runner side, but package has no src FOD',
    );
  }
  const knownHash =
    srcHashes.get(srcFod.attrPath.join('.')) ??
    // Fallback: use the original hash — assumes src didn't change. Happens
    // when src wasn't recomputed this run (shouldn't normally — src always
    // runs first).
    srcFod.inputs.outputHash;
  /* v8 ignore next -- defensive; src always has outputHash by construction */
  if (!knownHash) {
    throw new Error('vendor FOD: src hash unavailable');
  }
  return buildKnownSrcExpr(srcFod, knownHash, flakePath);
}

// Nix store URIs carry settings as query parameters — `?trusted=true` disables
// signature checking outright — so repo-provided values are restricted to plain
// https URLs. Paths fetched here land in a store shared with every other repo.
function usableSubstituters(configured: string[] | undefined): string[] {
  const ok: string[] = [];
  const rejected: string[] = [];
  for (const entry of coerceArray(configured)) {
    // Whitespace would split one entry into several substituters, and the
    // normalised href is what we forward — the raw string can differ.
    const url = regEx(/\s/).test(entry) ? null : parseUrl(entry);
    if (
      url?.protocol === 'https:' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    ) {
      ok.push(url.href);
    } else {
      rejected.push(entry);
    }
  }
  if (rejected.length) {
    logger.warn(
      { rejected },
      'nix-update: ignoring substituters that are not plain https URLs',
    );
  }
  return ok;
}

// Build the env we pass to every nix-build invocation. Token names follow
// what nix's built-in fetchers honor: GITHUB_TOKEN, GITLAB_TOKEN, etc.
function buildExtraEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...getGitEnvironmentVariables({}),
  };
  const ghToken = findGithubToken(
    hostRules.find({
      hostType: 'github',
      url: 'https://api.github.com/',
    }),
  );
  if (ghToken) {
    env.GITHUB_TOKEN = ghToken;
  }
  const glToken = hostRules.find({
    hostType: 'gitlab',
    url: 'https://gitlab.com/api/v4/',
  })?.token;
  if (glToken) {
    env.GITLAB_TOKEN = glToken;
  }
  return env;
}
