import { isObject, isString } from '@sindresorhus/is';
import { logger } from '../../../logger/index.ts';
import { exec } from '../../../util/exec/index.ts';
import type { ExecOptions } from '../../../util/exec/types.ts';
import { regEx } from '../../../util/regex.ts';
import type { HashAlgo } from './expr.ts';
import { collapseExpr } from './expr.ts';

// nix-build emits a "got: <hash>" line on hash mismatch. Newer nix uses SRI
// (sha256-<base64>=); older versions emit base32 (52 chars [a-z0-9]).
// We accept either and convert base32 → SRI for downstream consistency.
const sriRegex = regEx(/got:\s+(sha(?:256|512|1)-[A-Za-z0-9+/=]+)/);
const base32Regex = regEx(/got:\s+([a-z0-9]{52})/);

export interface PrefetchOptions {
  // raw nix expression (multi-line OK — we collapse before shell-quoting)
  expr: string;
  // package's declared system. Not passed to nix-build (see comment in
  // `prefetch` on why) — used purely to namespace the prefetch cache so
  // entries from packages declaring different systems don't collide.
  pkgSystem: string;
  // algo of the FOD we're prefetching; used to validate the parsed result.
  algo: HashAlgo;
  // env to pass to nix-build (e.g. GITHUB_TOKEN for private fetches)
  extraEnv?: Record<string, string | undefined>;
  // nix tool constraint from manager config
  nixConstraint?: string;
  // extra binary caches, already filtered against the admin allowlist, plus
  // the admin's signing keys.
  substituters?: string[];
  trustedPublicKeys?: string[];
  // Optional cache fingerprint. Two prefetches with the same expr+system+algo
  // but a different fingerprint won't share a cache entry. Caller should pass
  // a hash of `flake.lock` contents — `runnerPkgs` is resolved from
  // `flake.inputs.nixpkgs`, so changing the lock changes what fetchers/builders
  // we end up using.
  flakeLockFingerprint?: string;
}

// Parse a hash from nix-build's stderr produced by an empty-hash FOD.
// Returns SRI-formatted hash. Throws if no parseable hash found.
export async function parseHashFromStderr(
  stderr: string,
  algo: HashAlgo,
  nixConstraint?: string,
): Promise<string> {
  const sriMatch = sriRegex.exec(stderr);
  if (sriMatch) {
    const found = sriMatch[1];
    if (!found.startsWith(`${algo}-`)) {
      // nix produced a different algorithm than expected — surface clearly
      throw new Error(
        `Hash algorithm mismatch: expected ${algo}, got ${found.split('-')[0]}`,
      );
    }
    return found;
  }

  const b32Match = base32Regex.exec(stderr);
  if (b32Match) {
    // Convert base32 → SRI via `nix hash to-sri`.
    const raw = b32Match[1];
    const cmd = `nix --extra-experimental-features 'nix-command' hash to-sri --type ${algo} ${raw}`;
    const result = await exec(cmd, {
      toolConstraints: [{ toolName: 'nix', constraint: nixConstraint }],
      docker: {},
    });
    const sri = result.stdout.trim();
    if (!sri.startsWith(`${algo}-`)) {
      throw new Error(`nix hash to-sri produced unexpected output: ${sri}`);
    }
    return sri;
  }

  throw new Error(
    `Could not extract hash from nix-build output. stderr:\n${truncate(stderr, 4000)}`,
  );
}

// Per-process cache of resolved hashes. Renovate often runs updateArtifacts
// twice for the same branch (once with reuseExistingBranch=true, then again
// with reuseExistingBranch=false after deciding to rebase). Both invocations
// reach the same expression — caching avoids re-running expensive vendor
// builds (go mod download, cargo vendor, etc.).
//
// Key: collapsed expression + system + algo (everything that affects output).
// Value: resolved hash (only successes are cached; failures retry next time).
const prefetchCache = new Map<string, string>();

// For tests — drops every cached entry.
export function _resetPrefetchCacheForTesting(): void {
  prefetchCache.clear();
}

// Binary caches only serve paths under /nix/store — the prefix is part of what
// they sign — so a nix whose store lives elsewhere substitutes nothing and has
// to build the whole stdenv bootstrap from source.
const CANONICAL_STORE_DIR = '/nix/store';

// Deliberately not memoized: the resolved nix can change within a process when
// another manager triggers a containerbase install.
export async function assertSubstitutableStore(
  nixConstraint?: string,
): Promise<void> {
  const res = await exec(
    `nix --extra-experimental-features 'nix-command' eval --impure --raw --expr 'builtins.storeDir'`,
    {
      toolConstraints: [{ toolName: 'nix', constraint: nixConstraint }],
      docker: {},
    },
  );
  const storeDir = res.stdout.trim();
  if (storeDir !== CANONICAL_STORE_DIR) {
    throw new Error(
      `nix store dir is '${storeDir}', but binary caches only serve '${CANONICAL_STORE_DIR}', ` +
        `so every prefetch would build the full stdenv from source. This is what containerbase's ` +
        `nix wrapper does when it is not patched (it exports NIX_STORE_DIR into its ` +
        `cache dir) — the image must provide a nix whose store is ${CANONICAL_STORE_DIR}.`,
    );
  }
}

// Run `nix build --expr <expr>` and parse the hash from stderr.
// On success, the FOD output is also realised in the runner's nix store
// as a side effect (so subsequent vendor builds can reference it).
export async function prefetch(opts: PrefetchOptions): Promise<string> {
  const {
    expr,
    pkgSystem,
    algo,
    extraEnv,
    substituters,
    trustedPublicKeys,
    nixConstraint,
    flakeLockFingerprint,
  } = opts;

  const oneLine = collapseExpr(expr);
  const cacheKey = `${flakeLockFingerprint ?? ''}|${pkgSystem}|${algo}|${oneLine}`;
  const cached = prefetchCache.get(cacheKey);
  if (cached !== undefined) {
    logger.debug(
      { pkgSystem, algo, hash: cached },
      'nix-update: prefetch cache hit, skipping nix build',
    );
    return cached;
  }

  // --no-link: don't pollute cwd with a result symlink.
  // --impure:  required because we use `builtins.getFlake "<localPath>"`
  //            (impure) and may fall back to `import <nixpkgs>`. Doesn't
  //            affect the FOD hash — the output is purely a function of the
  //            fetcher inputs (URL/rev/etc.).
  //
  // We deliberately do *not* pass `--eval-system <pkgSystem>`. Doing so
  // sets `builtins.currentSystem` to the package's system (e.g.
  // `x86_64-darwin`), which then makes the expression's
  // `flake.inputs.nixpkgs.legacyPackages.${builtins.currentSystem}` resolve
  // to the *package's* pkgs — and re-instantiating the fetcher there
  // produces a darwin derivation that the linux runner refuses to build
  // ("platform mismatch"). Without `--eval-system`, `currentSystem`
  // correctly reports the runner's actual system, runnerPkgs is the
  // runner's pkgs, and the fetcher runs natively. The FOD hash is platform-
  // agnostic regardless.
  // Substituters go on the CLI rather than into nix.conf so a repo's cache is
  // used for that repo only.
  const cmd =
    `nix build --no-link ` +
    `--extra-experimental-features 'nix-command flakes' ` +
    `--impure ` +
    `${substituterArgs(substituters, trustedPublicKeys)}` +
    `--expr ${shellQuote(oneLine)}`;

  const execOptions: ExecOptions = {
    toolConstraints: [{ toolName: 'nix', constraint: nixConstraint }],
    extraEnv: extraEnv ?? {},
    docker: {},
  };

  let stderr = '';
  try {
    const result = await exec(cmd, execOptions);
    // If nix-build succeeded, our placeholder hash matched the actual hash —
    // statistically impossible, so something is off (likely a content-addressed
    // build that ignored outputHash). Treat as failure.
    stderr = result.stderr ?? '';
    throw new Error(
      `nix-build unexpectedly succeeded with placeholder hash; cannot determine actual hash. stderr: ${truncate(stderr, 1000)}`,
    );
  } catch (err) {
    // Expected case: nix-build fails with hash mismatch. Recover.
    const errObj = isObject(err) ? (err as { stderr?: unknown }) : null;
    const errStderr = errObj && isString(errObj.stderr) ? errObj.stderr : '';
    stderr = errStderr || stderr;

    if (!stderr) {
      // Re-throw the original error if there's nothing to parse
      logger.debug({ err }, 'nix-build failed with no stderr');
      throw err;
    }

    warnOnUntrustedSubstitutes(stderr);
    const hash = await parseHashFromStderr(stderr, algo, nixConstraint);
    prefetchCache.set(cacheKey, hash);
    return hash;
  }
}

// nix only warns about this on stderr and then builds from source, which
// otherwise looks like an unexplained slow run.
const unsignedRegex = regEx(
  /ignoring substitute for '[^']+' from '([^']+)', as it's not signed/g,
);

function warnOnUntrustedSubstitutes(stderr: string): void {
  const substituters = new Set(
    [...stderr.matchAll(unsignedRegex)].map((m) => m[1]),
  );
  if (substituters.size) {
    logger.warn(
      { substituters: [...substituters] },
      'nix-update: substituters ignored, no matching key in nixTrustedPublicKeys',
    );
  }
}

// Keys are optional: nix accepts content-addressed paths (the FODs this
// manager builds) unsigned, verifying them against their hash, and requires a
// trusted signature only for input-addressed ones.
function substituterArgs(
  substituters: string[] | undefined,
  trustedPublicKeys: string[] | undefined,
): string {
  if (!substituters?.length) {
    return '';
  }
  let args = `--option extra-substituters ${shellQuote(substituters.join(' '))} `;
  if (trustedPublicKeys?.length) {
    args += `--option extra-trusted-public-keys ${shellQuote(trustedPublicKeys.join(' '))} `;
  }
  return args;
}

function shellQuote(s: string): string {
  return `'${s.replace(regEx(/'/g), `'\\''`)}'`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  // Keep both ends: nix prints setup diagnostics (e.g. an unusable binary
  // cache) before the derivation list and the actual failure after it.
  const head = Math.floor(max / 4);
  const tail = max - head;
  return `${s.slice(0, head)}\n…(${s.length - max} more chars truncated)\n${s.slice(-tail)}`;
}
