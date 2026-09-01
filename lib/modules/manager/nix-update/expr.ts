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
// package pinning a non-default one (buildGo127Module, zig_0_16, php83, a
// beamPackages elixir) is not reproduced by the plain builder. The helpers
// below resolve the nixpkgs attr to pin to.
function toolVersion(
  tools: FodTool[] | undefined,
  pname: string,
): string | null {
  return tools?.find((t) => t.pname === pname)?.version ?? null;
}

// A nix boolean that is true only when `<set>.<attr>` is *exactly* the
// derivation the package used, and that is safe to evaluate even when it
// isn't.
//
// Both halves matter. Matching pname as well as version is what stops a
// same-version-different-derivation mix-up. And the whole comparison has to
// sit inside `builtins.tryEval`: nixpkgs keeps EOL toolchains as attributes
// that *abort when forced* (`runnerPkgs ? go_1_23` is true, touching it
// raises "Go 1.23 is end-of-life and 'go_1_23' has been removed"), and `or ""`
// only ever catches a missing attribute, never a throwing one. Without the
// tryEval the guard that exists to avoid pinning is itself what explodes.
function toolMatches(
  set: string,
  attr: string,
  pname: string,
  version: string,
): string {
  return (
    `builtins.tryEval (${set} ? ${attr} ` +
    `&& (${set}.${attr}.pname or "") == ${nixVal(pname)} ` +
    `&& (${set}.${attr}.version or "") == ${nixVal(version)})`
  );
}

// Pin to `<set>.<attr>`, or evaluate to `orElse` when it isn't an exact match.
function pinnedTool(
  set: string,
  attr: string,
  pname: string,
  version: string,
  orElse: string,
): string {
  return (
    `(let ok = ${toolMatches(set, attr, pname, version)}; in ` +
    `if ok.success && ok.value then ${set}.${attr} else ${orElse})`
  );
}

// For toolchains whose version changes what gets *vendored*: refuse to guess.
// Substituting the runner's default would fetch different content under a
// hash the bot then writes into the user's repo, and a plausible wrong hash is
// the one outcome worse than a failed run. (Go is the exception — see
// `goBuilder`.) This mirrors the reasoning already applied to pnpm below.
function pinnedToolOrAbort(
  set: string,
  attr: string,
  pname: string,
  version: string,
  ecosystem: string,
): string {
  return pinnedTool(
    set,
    attr,
    pname,
    version,
    `throw ${nixVal(
      `nix-update: this package builds with ${pname} ${version}, but the runner's nixpkgs has no matching ${set}.${attr}, ` +
        `so the ${ecosystem} dependencies would be fetched with a different toolchain and the resulting hash would be wrong.`,
    )}`,
  );
}

// Canonical nixpkgs spelling for versioned compiler attrs (go_1_27, zig_0_16).
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
  // Unlike the others, go falls back to the runner's default rather than
  // aborting, because the mismatch that matters announces itself: nixpkgs sets
  // GOTOOLCHAIN=local, so a go older than the package's `go` directive fails
  // the build outright instead of vendoring something different.
  //
  // That guarantee is one-directional. The default branch of nixpkgs'
  // buildGoModule runs `go mod vendor` (not `go mod download` — that is only
  // the proxyVendor path), whose output is not toolchain-invariant in general:
  // `vendor/modules.txt` is written by the toolchain, and go 1.24 changed which
  // dependencies get vendored. So a package deliberately held on an *older* go
  // than the runner's default could still vendor differently and yield a wrong
  // hash if the pin misses. That is the pre-existing behaviour and it is narrow;
  // aborting instead would fail every go package whose exact patch release the
  // runner's nixpkgs doesn't carry.
  const go = pinnedTool('runnerPkgs', attr, 'go', version, 'null');
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
  // The FOD's php is a `php-with-extensions` wrapper, and so is the `phpXX`
  // attr we pin to, so the pname half of the guard matches — but it carries no
  // discriminating power here, since every php attr and every withExtensions
  // wrapper shares that pname. The version is what actually decides, which is
  // the right key: composer resolves platform requirements against the php
  // version, so a different php can select different package versions. Pin
  // exactly or abort.
  const version = toolVersion(v.tools, 'php-with-extensions');
  const m = regEx(/^(\d+)\.(\d+)/).exec(version ?? '');
  const php =
    m && version
      ? pinnedToolOrAbort(
          'runnerPkgs',
          `php${m[1]}${m[2]}`,
          'php-with-extensions',
          version,
          'composer',
        )
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
  // The JDK moves this FOD, but it can't be recovered from it: buildMavenPackage
  // passes `mvnJdk` through `env.JAVA_HOME`, never into nativeBuildInputs, so
  // there is nothing here to pin to. A package on a non-default `mvnJdk`
  // therefore still gets its hash computed under the runner's default JDK.
  // Documented as a limitation in readme.md rather than guessed at.
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
  // Elixir lives in the beam package set, and the top-level `elixir_1_18` alias
  // is deprecated in favour of `beamPackages.elixir_1_18` — so pin from within
  // the set, which also keeps elixir and its erlang compatible. (Overriding to
  // an elixir the default erlang doesn't support is an eval-time assertion
  // failure, not a wrong hash.)
  const version = toolVersion(v.tools, 'elixir');
  const attr = versionedAttr('elixir', version);
  const elixir =
    attr && version
      ? pinnedToolOrAbort(
          'runnerPkgs.beamPackages',
          attr,
          'elixir',
          version,
          'mix',
        )
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
  // Zig makes breaking changes every 0.x and `zig build --fetch` writes a
  // cache layout that is not stable across them, so falling back to the
  // runner's default compiler would fetch a different tree — abort instead.
  const version = toolVersion(v.tools, 'zig');
  const attr = versionedAttr('zig', version);
  const zig =
    attr && version
      ? pinnedToolOrAbort('runnerPkgs', attr, 'zig', version, 'zig')
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
