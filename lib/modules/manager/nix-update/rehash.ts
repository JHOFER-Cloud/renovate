import { createHash } from 'node:crypto';
import { GlobalConfig } from '../../../config/global.ts';
import { logger } from '../../../logger/index.ts';
import { coerceArray } from '../../../util/array.ts';
import { readLocalFile } from '../../../util/fs/index.ts';
import type {
  ArtifactError,
  UpdateArtifactsConfig,
  UpdateArtifactsResult,
} from '../types.ts';
import { resolveToolConstraint } from '../util.ts';
import {
  buildExtraEnv,
  pickSrcExprFor,
  usableSubstituters,
} from './artifacts.ts';
import { evalPackageInfos, packageFileFromPosition } from './extract.ts';
import { classifyFod } from './fetchers.ts';
import { assertSubstitutableStore, prefetch } from './prefetch.ts';
import { rewriteHash } from './rewrite.ts';
import type { FodInfo, PackageInfo } from './types.ts';

interface RehashContext {
  flakePath: string;
  nixConstraint?: string;
  extraEnv: Record<string, string | undefined>;
  substituters: string[];
  trustedPublicKeys: string[];
  flakeLockFingerprint: string;
}

// Recompute the vendor FOD hashes (pnpmDeps, goModules, cargoDeps, ...) of
// every nix-update package against the flake.lock currently on disk. A
// nixpkgs bump changes the toolchains those FODs are produced with — a new
// pnpm major lays out its store differently — so their hashes can go stale
// without the package itself changing. `src` is skipped: what a fetcher
// downloads does not depend on nixpkgs.
export async function updateVendorHashes(
  config: UpdateArtifactsConfig,
): Promise<UpdateArtifactsResult[]> {
  const flakePath = GlobalConfig.get('localDir');
  /* v8 ignore next -- defensive; Renovate always sets localDir before updating artifacts */
  if (!flakePath) {
    return [];
  }

  const packageInfos = await evalPackageInfos();
  if (!packageInfos) {
    return [
      {
        artifactError: {
          fileName: 'flake.lock',
          stderr:
            'nix-update: could not evaluate the flake packages to update their vendor hashes',
        },
      },
    ];
  }

  const nixConstraint = await resolveToolConstraint(config, 'nix');
  try {
    await assertSubstitutableStore(nixConstraint);
  } catch (err) {
    logger.warn({ err }, 'nix-update: unusable nix store');
    return [
      {
        artifactError: {
          fileName: 'flake.lock',
          stderr: err instanceof Error ? err.message : String(err),
        },
      },
    ];
  }

  const lockContent = await readLocalFile('flake.lock', 'utf8');
  const ctx: RehashContext = {
    flakePath,
    nixConstraint,
    extraEnv: buildExtraEnv(),
    substituters: usableSubstituters(config.nixSubstituters),
    trustedPublicKeys: coerceArray(GlobalConfig.get('nixTrustedPublicKeys')),
    flakeLockFingerprint: createHash('sha256')
      .update(lockContent ?? '')
      .digest('hex'),
  };

  const contents = new Map<string, string>();
  const errors: ArtifactError[] = [];
  for (const [attrName, info] of Object.entries(packageInfos)) {
    const vendorFods = info.fods.filter((fod) => fod.attrPath.at(-1) !== 'src');
    const file = packageFileFromPosition(info.position) ?? 'flake.nix';
    for (const fod of vendorFods) {
      try {
        await rehashFod(ctx, info, fod, file, contents);
      } catch (err) {
        logger.warn(
          { err, attrName, attrPath: fod.attrPath },
          'nix-update: failed to update vendor hash',
        );
        errors.push({
          fileName: file,
          stderr: `${attrName} (${fod.attrPath.join('.')}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }
  }

  const results: UpdateArtifactsResult[] = [];
  for (const [path, newContent] of contents) {
    results.push({ file: { type: 'addition', path, contents: newContent } });
  }
  for (const artifactError of errors) {
    results.push({ artifactError });
  }
  return results;
}

async function rehashFod(
  ctx: RehashContext,
  info: PackageInfo,
  fod: FodInfo,
  file: string,
  contents: Map<string, string>,
): Promise<void> {
  const classified = classifyFod(fod, info.pname, info.version);
  const srcExpr = pickSrcExprFor(info.fods, new Map(), ctx.flakePath);
  const newHash = await prefetch({
    expr: classified.buildExpr(ctx.flakePath, srcExpr),
    pkgSystem: info.system,
    algo: classified.algo,
    extraEnv: ctx.extraEnv,
    substituters: ctx.substituters,
    trustedPublicKeys: ctx.trustedPublicKeys,
    nixConstraint: ctx.nixConstraint,
    flakeLockFingerprint: ctx.flakeLockFingerprint,
  });
  if (newHash === classified.currentHash) {
    return;
  }

  let content = contents.get(file);
  content ??= (await readLocalFile(file, 'utf8')) ?? '';
  // Two flake attributes can share one definition (an alias, a variant) and
  // so the same hash — the first one already rewrote it.
  if (content.includes(newHash)) {
    return;
  }
  logger.debug(
    `nix-update: ${fod.attrPath.join('.')} hash in ${file} changed to ${newHash}`,
  );
  contents.set(
    file,
    rewriteHash(content, {
      attrPath: fod.attrPath,
      oldHash: classified.currentHash,
      newHash,
    }),
  );
}
