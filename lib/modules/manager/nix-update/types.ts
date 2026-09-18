export type HashAlgo = 'sha256' | 'sha512' | 'sha1';

export interface FetcherInputs {
  // URL-based fetchers
  url?: string;
  urls?: string[];

  // GitHub-style fetchers
  owner?: string;
  repo?: string;
  rev?: string;
  domain?: string;
  group?: string;
  fetchSubmodules?: boolean;
  leaveDotGit?: boolean;
  forceFetchGit?: boolean;
  deepClone?: boolean;
  sparseCheckout?: string[];

  // Pypi / Crate / Gem
  pname?: string;
  version?: string;
  format?: string;
  extension?: string;

  // For vendor FODs that need an externally-built src
  srcExpr?: string; // raw nix expression, e.g. a runner-side src fetcher call

  // Generic
  name?: string;
}

export interface VendorInputs {
  pname: string;
  version: string;
  // raw nix expression for src — usually a runner-side fetcher call with a known hash
  srcExpr: string;
  // toolchains read off the package's own FOD by extract.ts, used to pin the
  // rebuild to the same ones
  tools?: FodTool[];
  // zig.fetchDeps arg, read off the package's own zigDeps derivation
  fetchAll?: boolean | null;
  // fetchPnpmDeps args, read off the package's own pnpmDeps derivation
  fetcherVersion?: number;
  pnpmVersion?: string;
  pnpmWorkspaces?: string[];
  pnpmInstallFlags?: string[];
  prePnpmInstall?: string;
}

export interface FodInputs {
  outputHash: string;
  outputHashAlgo: string;
  outputHashMode: string;
  url: string | null;
  rev: string | null;
  fetchSubmodules: boolean | null;
  leaveDotGit: boolean | null;
  deepClone: boolean | null;
  forceFetchGit: boolean | null;
  sparseCheckout: string[] | null;
  name: string | null;
  // fetchPnpmDeps args. Optional, not `| null`: package files extracted by an
  // older Renovate can still be in the repository cache without them.
  fetcherVersion?: number | null;
  pnpmVersion?: string | null;
  pnpmWorkspaces?: string[] | null;
  pnpmInstallFlags?: string[] | null;
  prePnpmInstall?: string | null;
  // zig.fetchDeps arg, read off the package's own zigDeps derivation.
  fetchAll?: boolean | null;
  // Toolchains found in the FOD's nativeBuildInputs, e.g.
  // `[{ pname: "go", version: "1.27.0" }]`. Optional for the same reason as the
  // pnpm args: older extracts in the repository cache predate it.
  tools?: FodTool[];
}

export interface FodTool {
  pname: string;
  version: string | null;
}

export interface FodInfo {
  // Path inside the package attrset, e.g. ["src"], ["goModules"], ["cargoDeps"]
  attrPath: string[];
  inputs: FodInputs;
}

export interface RenovateOverrides {
  datasource: string | null;
  packageName: string | null;
  extractVersion: string | null;
}

export interface ClassifiedFod {
  // attrPath inside the package, used by rewrite.ts to locate the hash
  attrPath: string[];
  // hash currently in the file (so rewrite can find/replace it; null = lib.fakeHash)
  currentHash: string | null;
  // hash algorithm — preserved through the rebuild
  algo: HashAlgo;
  // for ordering: src fetchers run first, vendor builders second
  isSrc: boolean;
  // a function that, given the runner-side srcExpr (used by vendor builders)
  // and the package's flake path, returns the nix expression to nix-build.
  // For src fetchers, srcExpr is unused.
  buildExpr: (flakePath: string, srcExpr: string) => string;
  // detected fetcher name (debug/error messaging only)
  fetcherName: string;
}

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

export interface RewriteContext {
  // Path of attributes from the package root down to the FOD.
  // E.g. ["src"], ["goModules"], ["passthru", "cargoDeps"].
  attrPath: string[];
  // Old hash currently in the file. Used as a sanity check + fallback.
  // Can be `null` for `lib.fakeHash` placeholders.
  oldHash: string | null;
  // New hash (SRI form, e.g. "sha256-...=").
  newHash: string;
}

export interface UrlRewriteContext {
  // Path to the FOD whose url should be replaced (e.g. ["src"]).
  attrPath: string[];
  // URL currently in the file. Used for the unique-string fast path.
  oldUrl: string;
  // New URL to write.
  newUrl: string;
}

export interface RevRewriteContext {
  // Path to the FOD whose rev should be replaced (e.g. ["src"]).
  attrPath: string[];
  // Commit currently pinned in the file.
  oldRev: string;
  // Commit to pin instead.
  newRev: string;
}
