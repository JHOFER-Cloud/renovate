import { createHash } from 'node:crypto';
import { GlobalConfig } from '../../../config/global.ts';
import { logger } from '../../../logger/index.ts';
import { findGithubToken } from '../../../util/check-token.ts';
import { readLocalFile, writeLocalFile } from '../../../util/fs/index.ts';
import { getGitEnvironmentVariables } from '../../../util/git/auth.ts';
import { getRepoStatus } from '../../../util/git/index.ts';
import * as hostRules from '../../../util/host-rules.ts';
import type {
  ArtifactError,
  UpdateArtifact,
  UpdateArtifactsResult,
} from '../types.ts';
import type { FodInfo } from './extract.ts';
import { buildKnownSrcExpr, classifyFod } from './fetchers.ts';
import { prefetch } from './prefetch.ts';
import { rewriteHash } from './rewrite.ts';

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
        fods?: FodInfo[];
      }
    | undefined;

  const attrName = md?.attrName;
  const pkgSystem = md?.system;
  const pname = md?.pname ?? null;
  const fods = md?.fods ?? [];

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

  // Write the version-bumped content first (renovate's auto-replace already
  // produced this — we just need it on disk so any same-package eval reads
  // the new version).
  await writeLocalFile(packageFileName, newPackageFileContent);

  // Auth: pass GitHub/GitLab tokens through env so private fetchers work.
  const extraEnv = buildExtraEnv();

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

  // Classify all FODs. Hard-fail surface area is the classifier — anything
  // unsupported throws here, before any nix-build runs.
  const classified = bumpedFods.map((fod) =>
    classifyFod(fod, pname, newVersion),
  );
  // Run src first; vendor builders need src already in the runner's store.
  classified.sort((a, b) => Number(b.isSrc) - Number(a.isSrc));

  let content = newPackageFileContent;
  const errors: ArtifactError[] = [];
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
      // admin) knows what to fix. Keep the message specific — package name
      // and FOD attribute path — so multiple failures don't dedupe to one
      // generic line.
      logger.warn(
        { err, attrPath: fod.attrPath, fetcher: fod.fetcherName },
        `nix-update: failed to prefetch ${attrName} ${fod.attrPath.join('.')} (${fod.fetcherName})`,
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
    return [
      {
        artifactError: {
          fileName: packageFileName,
          stderr: errors.map((e) => e.stderr).join('\n'),
        },
      },
    ];
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
  const swap = (
    s: string | null,
    from: string | null | undefined,
    to: string | null | undefined,
  ): string | null => {
    if (s === null || !from || !to || from === to) {
      return s;
    }
    return s.split(from).join(to);
  };
  const stripV = (s: string): string =>
    s.length > 1 && (s.startsWith('v') || s.startsWith('V')) && /\d/.test(s[1])
      ? s.slice(1)
      : s;
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

function pickSrcExprFor(
  allFods: FodInfo[],
  srcHashes: Map<string, string>,
  flakePath: string,
): string {
  const srcFod = allFods.find(
    (f) => f.attrPath[f.attrPath.length - 1] === 'src',
  );
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
  /* v8 ignore next 3 -- defensive; src always has outputHash by construction */
  if (!knownHash) {
    throw new Error('vendor FOD: src hash unavailable');
  }
  return buildKnownSrcExpr(srcFod, knownHash, flakePath);
}

// Build the env we pass to every nix-build invocation. Token names follow
// what nix's built-in fetchers honor: GITHUB_TOKEN, GITLAB_TOKEN, etc.
function buildExtraEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...getGitEnvironmentVariables(),
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
