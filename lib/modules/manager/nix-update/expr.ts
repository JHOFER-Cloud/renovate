// Builders for the nix expressions we feed to `nix-build --expr`.
// All output is one logical expression; we collapse newlines to spaces
// at the end so shell quoting stays sane.

import {
  isBoolean,
  isNullOrUndefined,
  isPlainObject,
  isString,
} from '@sindresorhus/is';
import { regEx } from '../../../util/regex.ts';
import type { FodTool } from './extract.ts';

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

const HASH_PLACEHOLDER = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// JSON-stringify a value so it's a valid nix literal.
// Strings: escape `${` so nix doesn't interpolate.
// Bools, numbers, lists: JSON happens to coincide with nix syntax for these.
export function nixVal(v: unknown): string {
  if (isNullOrUndefined(v)) {
    return 'null';
  }
  if (isBoolean(v)) {
    return v ? 'true' : 'false';
  }
  if (typeof v === 'number') {
    return JSON.stringify(v);
  }
  if (isString(v)) {
    return JSON.stringify(v).replace(regEx(/\$\{/g), '\\${');
  }
  if (Array.isArray(v)) {
    return `[ ${v.map(nixVal).join(' ')} ]`;
  }
  // isPlainObject, not isObject: isObject() counts functions as objects, but
  // functions must fall through to the throw below.
  if (isPlainObject(v)) {
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
  function set(k: string, v: unknown): void {
    if (v !== undefined) {
      out.push(`${k} = ${nixVal(v)};`);
    }
  }

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

// Several ecosystems bake a versioned toolchain into the vendor FOD, so a
// package pinning a non-default one (buildGo127Module, zig_0_16, php83,
// a beamPackages elixir, a non-default mvnJdk) is not reproduced by the plain
// builder. Depending on the ecosystem that shows up as a hard build failure
// (go refuses to upgrade past go.mod's directive under GOTOOLCHAIN=local) or
// as a wrong hash. `pinnedTool` below resolves the nixpkgs attr to pin to.
export function toolVersion(
  tools: FodTool[] | undefined,
  pname: string,
): string | null {
  return tools?.find((t) => t.pname === pname)?.version ?? null;
}

// Emit `runnerPkgs.<attr>` for the first candidate attr that is *exactly* the
// derivation the package used, falling back to `fallback` when none is.
//
// The guard matters: `jdk21` and `temurin-bin-21` carry the same version but
// are different derivations, and picking the wrong one moves the FOD's hash
// silently. Matching pname as well as version means a candidate we can't
// positively identify degrades to the default — i.e. today's behaviour — rather
// than to a confidently wrong pin. runnerPkgs is normally the same nixpkgs the
// package was evaluated from, so an exact match is the common case; it fails
// only when the flake names its nixpkgs differently and we fall back to the
// host channel, which is exactly when we should not be pinning.
function pinnedTool(
  candidates: string[],
  tool: { pname: string; version: string },
  fallback: string,
): string {
  return candidates.reduceRight(
    (acc, attr) =>
      `(if runnerPkgs ? ${attr} ` +
      `&& (runnerPkgs.${attr}.pname or "") == ${nixVal(tool.pname)} ` +
      `&& (runnerPkgs.${attr}.version or "") == ${nixVal(tool.version)} ` +
      `then runnerPkgs.${attr} else ${acc})`,
    fallback,
  );
}

// Candidate attrs for a tool pinned as `<prefix><major>_<minor>` (go_1_27,
// zig_0_16) — nixpkgs' canonical spelling for versioned compiler attrs.
function versionedAttr(prefix: string, version: string | null): string | null {
  const m = regEx(/^(\d+)\.(\d+)/).exec(version ?? '');
  return m ? `${prefix}_${m[1]}_${m[2]}` : null;
}

function goBuilder(tools: FodTool[] | undefined): string {
  const version = toolVersion(tools, 'go');
  const attr = versionedAttr('go', version);
  if (!attr || !version) {
    return 'runnerPkgs.buildGoModule';
  }
  const go = pinnedTool([attr], { pname: 'go', version }, 'null');
  return (
    `(let go = ${go}; in ` +
    `if go == null then runnerPkgs.buildGoModule ` +
    `else runnerPkgs.buildGoModule.override { inherit go; })`
  );
}

// (runnerPkgs.buildGoModule { ... vendorHash = ""; }).goModules
export function exprForGoModules(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  return `${preamble(flakePath)}
    (${goBuilder(v.tools)} {
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

// pnpm: fetchPnpmDeps. `pnpm.fetchDeps` is deprecated and, more importantly,
// force-overrides the `pnpm` argument with its own version — so a package
// pinning pnpm_11 could not be reproduced through it.
export function exprForPnpmDeps(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  const attrs: string[] = [];
  // No `or runnerPkgs.pnpm` fallback: a different pnpm major writes a
  // different store layout, so guessing here would mean a silently wrong hash.
  const major = regEx(/^(\d+)\./).exec(v.pnpmVersion ?? '')?.[1];
  if (major) {
    attrs.push(`pnpm = runnerPkgs.pnpm_${major};`);
  }
  if (v.fetcherVersion !== undefined) {
    attrs.push(`fetcherVersion = ${nixVal(v.fetcherVersion)};`);
  }
  if (v.pnpmWorkspaces?.length) {
    attrs.push(`pnpmWorkspaces = ${nixVal(v.pnpmWorkspaces)};`);
  }
  if (v.pnpmInstallFlags?.length) {
    attrs.push(`pnpmInstallFlags = ${nixVal(v.pnpmInstallFlags)};`);
  }
  if (v.prePnpmInstall) {
    attrs.push(`prePnpmInstall = ${nixVal(v.prePnpmInstall)};`);
  }
  return `${preamble(flakePath)}
    runnerPkgs.fetchPnpmDeps {
      pname = ${nixVal(v.pname)};
      version = ${nixVal(v.version)};
      src = ${v.srcExpr};
      ${attrs.join(' ')}
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
  attr: 'composerVendor' | 'composerRepository' = 'composerVendor',
): string {
  // nixpkgs ships two generations of the composer builder and they expose the
  // vendor FOD under different names: v1 `buildComposerProject` yields
  // `composerRepository`, v2 `buildComposerProject2` yields `composerVendor`.
  // The attribute extract.ts found tells us which generation the package uses,
  // so dispatch on it — calling the wrong one is an eval error, not a wrong
  // hash, because the attribute we then read simply isn't there.
  const v2 = attr === 'composerVendor';
  const builder = v2 ? 'buildComposerProject2' : 'buildComposerProject';
  // The FOD's php is a `php-with-extensions` wrapper, so its pname never
  // matches the `phpXX` attr we'd pin to; the version is the only usable
  // discriminator here.
  const version = toolVersion(v.tools, 'php-with-extensions');
  const m = regEx(/^(\d+)\.(\d+)/).exec(version ?? '');
  const php = m
    ? `(if runnerPkgs ? php${m[1]}${m[2]} then runnerPkgs.php${m[1]}${m[2]} else runnerPkgs.php)`
    : 'runnerPkgs.php';
  return `${preamble(flakePath)}
    (${php}.${builder} {
      pname = ${nixVal(v.pname)};
      version = ${nixVal(v.version)};
      src = ${v.srcExpr};
      ${hashPlaceholderAttr(algo, 'vendorHash')}
    }).${attr}`;
}

// Java/Maven: buildMavenPackage's fetchedMavenDeps.
export function exprForMavenDeps(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  // Maven itself isn't version-pinnable in nixpkgs (one `maven` attr), but the
  // JDK is, and it does move the deps FOD. Vendors spell their attrs
  // differently, so try the plausible ones and let the pname+version guard
  // decide — an unrecognised JDK just leaves the default in place.
  const jdk = ['temurin-bin', 'zulu-ca-jdk']
    .map((pname) => ({ pname, version: toolVersion(v.tools, pname) }))
    .find((t): t is { pname: string; version: string } => t.version !== null);
  const major = regEx(/^(\d+)/).exec(jdk?.version ?? '')?.[1];
  const mvnJdk =
    jdk && major
      ? pinnedTool(
          [`jdk${major}`, `temurin-bin-${major}`, `zulu${major}`],
          jdk,
          'null',
        )
      : 'null';
  return `${preamble(flakePath)}
    (runnerPkgs.maven.buildMavenPackage ({
      pname = ${nixVal(v.pname)};
      version = ${nixVal(v.version)};
      src = ${v.srcExpr};
      ${hashPlaceholderAttr(algo, 'mvnHash')}
    } // (let jdk = ${mvnJdk}; in if jdk == null then {} else { mvnJdk = jdk; }))
    ).fetchedMavenDeps`;
}

// Elixir/Mix: fetchMixDeps (BEAM ecosystem).
export function exprForMixFodDeps(
  flakePath: string,
  v: VendorInputs,
  algo: HashAlgo,
): string {
  // Elixir lives in the beam package set, and the top-level `elixir_1_18` alias
  // is deprecated in favour of `beamPackages.elixir_1_18` — so pin from within
  // the set, which also keeps elixir and its erlang compatible. (Overriding to
  // an elixir the default erlang doesn't support is an eval-time assertion
  // failure, not a wrong hash.)
  const version = toolVersion(v.tools, 'elixir');
  const attr = versionedAttr('elixir', version);
  const elixir =
    attr && version
      ? `(if runnerPkgs.beamPackages ? ${attr} ` +
        `&& (runnerPkgs.beamPackages.${attr}.version or "") == ${nixVal(version)} ` +
        `then runnerPkgs.beamPackages.${attr} else null)`
      : 'null';
  return `${preamble(flakePath)}
    (let
      elixir = ${elixir};
      fetcher =
        if elixir == null
        then runnerPkgs.beamPackages.fetchMixDeps
        else runnerPkgs.beamPackages.fetchMixDeps.override { inherit elixir; };
    in fetcher {
      pname = ${nixVal(`${v.pname}-deps`)};
      version = ${nixVal(v.version)};
      src = ${v.srcExpr};
      ${hashPlaceholderAttr(algo)}
    })`;
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
  // Each zig attr carries its own `fetchDeps` with that compiler bound in
  // (`passthru.nix`: `fetchDeps = callPackage ./fetcher.nix { inherit zig; }`),
  // so pinning the compiler and reaching the fetcher are the same step. Zig
  // makes breaking changes every 0.x, so the default is rarely the right one.
  const version = toolVersion(v.tools, 'zig');
  const attr = versionedAttr('zig', version);
  const zig =
    attr && version
      ? pinnedTool([attr], { pname: 'zig', version }, 'runnerPkgs.zig')
      : 'runnerPkgs.zig';
  return `${preamble(flakePath)}
    ${zig}.fetchDeps {
      pname = ${nixVal(v.pname)};
      version = ${nixVal(v.version)};
      src = ${v.srcExpr};
      ${v.fetchAll ? `fetchAll = true;` : ''}
      ${hashPlaceholderAttr(algo)}
    }`;
}

// Collapse the multi-line nix expression to a single line so it survives
// shell quoting cleanly. nix is whitespace-insensitive between tokens.
export function collapseExpr(expr: string): string {
  return expr.replace(regEx(/\s+/g), ' ').trim();
}
