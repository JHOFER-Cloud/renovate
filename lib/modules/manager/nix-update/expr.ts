// Builders for the nix expressions we feed to `nix-build --expr`.
// All output is one logical expression; we collapse newlines to spaces
// at the end so shell quoting stays sane.

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

  // pnpm
  fetcherVersion?: number;

  // For vendor FODs that need an externally-built src
  srcExpr?: string; // raw nix expression, e.g. a runner-side src fetcher call

  // Generic
  name?: string;
}

const HASH_PLACEHOLDER = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// JSON-stringify a value so it's a valid nix literal.
// Strings: escape `${` so nix doesn't interpolate.
// Bools, numbers, lists: JSON happens to coincide with nix syntax for these.
export function nixVal(v: unknown): string {
  if (v === null || v === undefined) {
    return 'null';
  }
  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }
  if (typeof v === 'number') {
    return JSON.stringify(v);
  }
  if (typeof v === 'string') {
    return JSON.stringify(v).replace(/\$\{/g, '\\${');
  }
  if (Array.isArray(v)) {
    return `[ ${v.map(nixVal).join(' ')} ]`;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .map(([k, val]) => `${k} = ${nixVal(val)};`);
    return `{ ${entries.join(' ')} }`;
  }
  throw new Error(`Cannot serialize ${typeof v} to nix`);
}

// Common preamble: define `flake` and `runnerPkgs`.
// runnerPkgs is the flake's pinned nixpkgs at the runner's system.
// Use `legacyPackages.<sys>` (canonical flakes API) — `import flake.inputs.nixpkgs`
// returns the flake's outputs attrset, not pkgs, so e.g. .fetchurl is undefined.
// Falls back to <nixpkgs> channel if the flake doesn't expose nixpkgs as input.
function preamble(flakePath: string): string {
  return `
    let
      flake = builtins.getFlake ${nixVal(flakePath)};
      runnerPkgs =
        if flake ? inputs && flake.inputs ? nixpkgs
        then flake.inputs.nixpkgs.legacyPackages.\${builtins.currentSystem}
        else import <nixpkgs> { system = builtins.currentSystem; };
    in
  `;
}

// Build a hash placeholder attrset: { hash = "sha256-AAAA..."; } (or sha512 etc.)
// We pick a known-invalid hash so nix-build deterministically produces a
// "hash mismatch" error from which we parse the actual hash.
function hashPlaceholderAttr(algo: HashAlgo, attrName = 'hash'): string {
  if (algo === 'sha256') {
    return `${attrName} = ${nixVal(HASH_PLACEHOLDER)};`;
  }
  if (algo === 'sha512') {
    return `${attrName} = ${nixVal(
      'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    )};`;
  }
  return `${attrName} = ${nixVal('sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=')};`;
}

// ---------- Source fetcher expressions ----------

// runnerPkgs.<fetcher> { ...inputs; hash = ""; }
export function exprForSrcFetcher(
  flakePath: string,
  fetcherName: string,
  inputs: FetcherInputs,
  algo: HashAlgo,
): string {
  const args = buildSrcFetcherArgs(fetcherName, inputs);
  return `${preamble(flakePath)} runnerPkgs.${fetcherName} { ${args} ${hashPlaceholderAttr(algo)} }`;
}

function buildSrcFetcherArgs(name: string, inp: FetcherInputs): string {
  const out: string[] = [];
  const set = (k: string, v: unknown): void => {
    if (v !== undefined) {
      out.push(`${k} = ${nixVal(v)};`);
    }
  };

  switch (name) {
    case 'fetchurl':
    case 'fetchTarball':
    case 'builtins.fetchurl':
    case 'builtins.fetchTarball':
      // fetchurl accepts url OR urls
      if (inp.urls?.length) {
        set('urls', inp.urls);
      } else {
        set('url', inp.url);
      }
      set('name', inp.name);
      break;
    case 'fetchzip':
      set('url', inp.url);
      set('name', inp.name);
      break;
    case 'fetchFromGitHub':
    case 'fetchFromGitLab':
    case 'fetchFromGitea':
    case 'fetchFromBitbucket':
    case 'fetchFromSourcehut':
    case 'fetchFromRepoOrCz':
      set('owner', inp.owner);
      set('repo', inp.repo);
      set('rev', inp.rev);
      set('domain', inp.domain);
      set('group', inp.group);
      set('fetchSubmodules', inp.fetchSubmodules);
      set('leaveDotGit', inp.leaveDotGit);
      set('forceFetchGit', inp.forceFetchGit);
      set('sparseCheckout', inp.sparseCheckout);
      break;
    case 'fetchgit':
    case 'fetchhg':
    case 'fetchsvn':
    case 'fetchfossil':
      set('url', inp.url);
      set('rev', inp.rev);
      set('fetchSubmodules', inp.fetchSubmodules);
      set('leaveDotGit', inp.leaveDotGit);
      set('deepClone', inp.deepClone);
      set('sparseCheckout', inp.sparseCheckout);
      break;
    case 'fetchPypi':
    case 'fetchCrate':
    case 'fetchgem':
      set('pname', inp.pname);
      set('version', inp.version);
      set('format', inp.format);
      set('extension', inp.extension);
      break;
    default:
      throw new Error(`Unsupported source fetcher: ${name}`);
  }
  return out.join(' ');
}

// ---------- Vendor / dep FOD expressions ----------

export interface VendorInputs {
  pname: string;
  version: string;
  // raw nix expression for src — usually a runner-side fetcher call with a known hash
  srcExpr: string;
  // optional, fetcher-specific
  fetcherVersion?: number;
}

// (runnerPkgs.buildGoModule { ... vendorHash = ""; }).goModules
export function exprForGoModules(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  return `${preamble(flakePath)}
    (runnerPkgs.buildGoModule {
      pname = ${nixVal(v.pname)};
      version = ${nixVal(v.version)};
      src = ${v.srcExpr};
      ${hashPlaceholderAttr(algo, 'vendorHash')}
    }).goModules`;
}

// Rust: cargoDeps via fetchCargoVendor (modern) — same hash placeholder pattern.
// nixpkgs exposes the cargoDeps attribute on rustPlatform.buildRustPackage results.
export function exprForCargoDeps(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  return `${preamble(flakePath)}
    (runnerPkgs.rustPlatform.buildRustPackage {
      pname = ${nixVal(v.pname)};
      version = ${nixVal(v.version)};
      src = ${v.srcExpr};
      ${hashPlaceholderAttr(algo, 'cargoHash')}
    }).cargoDeps`;
}

// Node npm: fetchNpmDeps takes src + hash.
export function exprForNpmDeps(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  return `${preamble(flakePath)}
    runnerPkgs.fetchNpmDeps {
      name = ${nixVal(`${v.pname}-${v.version}-npm-deps`)};
      src = ${v.srcExpr};
      ${hashPlaceholderAttr(algo)}
    }`;
}

// pnpm: pnpm.fetchDeps. fetcherVersion controls store layout (>= 8 vs older).
export function exprForPnpmDeps(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  const fv =
    v.fetcherVersion === undefined
      ? ''
      : `fetcherVersion = ${nixVal(v.fetcherVersion)};`;
  return `${preamble(flakePath)}
    runnerPkgs.pnpm.fetchDeps {
      pname = ${nixVal(v.pname)};
      version = ${nixVal(v.version)};
      src = ${v.srcExpr};
      ${fv}
      ${hashPlaceholderAttr(algo)}
    }`;
}

// Yarn: fetchYarnDeps takes a yarn.lock (we point at the prefetched src).
export function exprForYarnDeps(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  return `${preamble(flakePath)}
    runnerPkgs.fetchYarnDeps {
      name = ${nixVal(`${v.pname}-${v.version}-yarn-deps`)};
      yarnLock = (${v.srcExpr}) + "/yarn.lock";
      ${hashPlaceholderAttr(algo)}
    }`;
}

// PHP composer: buildComposerProject's vendor.
export function exprForComposerVendor(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  return `${preamble(flakePath)}
    (runnerPkgs.php.buildComposerProject {
      pname = ${nixVal(v.pname)};
      version = ${nixVal(v.version)};
      src = ${v.srcExpr};
      ${hashPlaceholderAttr(algo, 'vendorHash')}
    }).composerVendor`;
}

// Java/Maven: buildMavenPackage's fetchedMavenDeps.
export function exprForMavenDeps(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  return `${preamble(flakePath)}
    (runnerPkgs.maven.buildMavenPackage {
      pname = ${nixVal(v.pname)};
      version = ${nixVal(v.version)};
      src = ${v.srcExpr};
      ${hashPlaceholderAttr(algo, 'mvnHash')}
    }).fetchedMavenDeps`;
}

// Elixir/Mix: fetchMixDeps (BEAM ecosystem).
export function exprForMixFodDeps(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  return `${preamble(flakePath)}
    runnerPkgs.beamPackages.fetchMixDeps {
      pname = ${nixVal(`${v.pname}-deps`)};
      version = ${nixVal(v.version)};
      src = ${v.srcExpr};
      ${hashPlaceholderAttr(algo)}
    }`;
}

// .NET: fetchNuGetDeps via dotnetCorePackages helpers.
export function exprForNuGetDeps(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  return `${preamble(flakePath)}
    runnerPkgs.fetchNuGetDeps {
      name = ${nixVal(`${v.pname}-${v.version}-nuget-deps`)};
      src = ${v.srcExpr};
      ${hashPlaceholderAttr(algo)}
    }`;
}

// Zig: zon.fetchDeps via the build-support helper.
export function exprForZigDeps(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  return `${preamble(flakePath)}
    runnerPkgs.callPackage (runnerPkgs.path + "/pkgs/build-support/zig/fetch-deps.nix") {
      pname = ${nixVal(v.pname)};
      version = ${nixVal(v.version)};
      src = ${v.srcExpr};
      ${hashPlaceholderAttr(algo)}
    }`;
}

// Collapse the multi-line nix expression to a single line so it survives
// shell quoting cleanly. nix is whitespace-insensitive between tokens.
export function collapseExpr(expr: string): string {
  return expr.replace(/\s+/g, ' ').trim();
}
