The `nix-update` manager creates per-package PRs for nixpkgs-style derivations that declare `passthru.updateScript = nix-update-script { ... }`.

### Requirements

- The repository must be a Nix flake (a `flake.nix` must exist at the repo root)
- The flake should expose `nixpkgs` as an input named `nixpkgs` (the manager re-uses it for runner-side hash computation)
- `nix` must be available, and its store dir must be `/nix/store`

containerbase's nix tool wraps nix with an unconditional `export NIX_STORE_DIR=<cache>/nix/store`, and binary caches only serve paths under `/nix/store`:

```text
warning: binary cache 'https://cache.nixos.org' is for Nix stores with prefix '/nix/store', not '/tmp/containerbase/cache/nix/store'
```

Such a nix substitutes nothing, so every hash prefetch rebuilds the full stdenv from source and exceeds the exec timeout. The fix belongs in containerbase; this fork's image patches `tools/v2/nix.sh` to point the wrapper at the canonical store, so an installed nix and the image's nix are interchangeable. Setting `NIX_STORE_DIR` in the environment does not help — the unpatched wrapper overrides it.

The manager probes `builtins.storeDir` once per package and reports an `artifactError` naming the store dir if this invariant is broken, rather than spending the exec timeout on a doomed source build.

### Binary caches

A repository can select binary caches for its own hash computation:

```json title="renovate.json"
{
  "nixSubstituters": ["https://nixkit.cachix.org"]
}
```

They are passed to `nix build` for that repository only, and must be plain `https` URLs — a Nix store URI can carry settings like `?trusted=true`, which would switch off signature checking. Signing keys are administrator-owned, in `nixTrustedPublicKeys`. Without a matching key nix still accepts _content-addressed_ paths from the cache — the FODs this manager builds — because those are verified against their hash rather than a signature. What a key unlocks is _input-addressed_ paths (stdenv, bash, curl), which is also why a repository cannot be allowed to supply one: those paths land in a store every repository shares. `cache.nixos.org` needs no configuration — it is nix's default.

### How it works

This manager does NOT call out to the upstream `nix-update` CLI. Instead, it computes hashes directly via runner-side `nix-build`, which lets it update darwin-only packages on a linux runner (and vice versa).

1. **Discovery**: scans matched `.nix` files for `passthru.updateScript = nix-update-script`. If any are found, runs one `nix eval .#packages` call to introspect all packages with an update script, across all supported systems. For each package it walks the attribute tree and collects every fixed-output derivation (FOD): the `src` plus any vendor FOD attributes (`goModules`, `cargoDeps`, `npmDeps`, `pnpmDeps`, `yarnOfflineCache`, `composerVendor`, `fetchedMavenDeps`, `mixFodDeps`, `zigDeps`, `nugetDeps`).
2. **Per-package PRs**: Renovate creates a separate branch and PR for each discovered package, driven by its source URL's datasource (`github-tags`, `pypi`, `crate`, etc.).
3. **Hash recomputation**: for each FOD, the manager constructs a small nix expression that re-instantiates the _same_ nixpkgs fetcher/builder against runner-side `pkgs`, with `outputHash = ""`. `nix-build` is invoked; the actual hash is parsed from the resulting "hash mismatch" error in stderr. Because every FOD's output is platform-deterministic (Go modules, cargo crates, npm packages, GitHub archives are byte-identical regardless of system), the runner's linux build produces the exact hash darwin would have produced.
4. **File rewriting**: hashes in the .nix file are replaced by attribute context — the manager finds each FOD's binding in the source and updates only that one, even when the same hash appears multiple times.

### Configuration

Add `nix-update` to your `enabledManagers` list:

```json
{
  "enabledManagers": ["nix-update"]
}
```

### Supported fetchers and FOD types

**Source fetchers** (the `src` attribute):

- `fetchurl`, `fetchTarball`, `fetchzip`
- `fetchFromGitHub`, `fetchFromGitea`, `fetchFromBitbucket`, `fetchFromSourcehut`
- `fetchFromGitLab` (classification only — URL parsing for vendored archive names is incomplete)
- `fetchgit`, `fetchhg`, `fetchsvn`, `fetchfossil`
- `fetchPypi`, `fetchCrate`, `fetchgem`

**Vendor / dependency FODs**:

- Go: `goModules` (via `buildGoModule`)
- Rust: `cargoDeps` (via `rustPlatform.buildRustPackage`)
- Node: `npmDeps` (via `fetchNpmDeps`)
- pnpm: `pnpmDeps` (via `pnpm.fetchDeps`)
- Yarn: `yarnOfflineCache` / `offlineCache` (via `fetchYarnDeps`)
- PHP: `composerVendor` (via `buildComposerProject2`) / `composerRepository` (via `buildComposerProject`)
- Java/Maven: `fetchedMavenDeps`
- Elixir: `mixFodDeps`
- Zig: `zigDeps` (via `zig.fetchDeps`)
- .NET: `nugetDeps`

A package may carry several of these — they're all updated in one PR.

### Overriding datasource detection (`passthru.renovate`)

When a package's `src` URL doesn't match any of the built-in URL patterns above (e.g. a vendor-hosted binary release served from a CDN), the manager has nowhere to look up new versions. As an escape hatch, a package may declare overrides on `passthru.renovate`:

```nix
{
  passthru = {
    updateScript = nix-update-script {};
    renovate = {
      datasource = "custom.raycast-beta";   # any Renovate datasource id
      # packageName = "raycast-beta";        # optional; defaults to pname
      # extractVersion = "(?<version>...)";  # optional; overrides --version-regex
    };
  };
}
```

`datasource` accepts any datasource Renovate knows about. The common case is `custom.<name>`, which dispatches to a `customDatasources.<name>` block in your `renovate.json` — letting you point Renovate at whatever version endpoint the upstream exposes:

```json
{
  "customDatasources": {
    "raycast-beta": {
      "defaultRegistryUrlTemplate": "https://api.raycast.app/v2/releases/beta/latest",
      "format": "json",
      "transformTemplates": ["{ \"releases\": [{ \"version\": $.version }] }"]
    }
  }
}
```

The override only affects version discovery — hash recomputation still goes through the package's existing fetcher unchanged. `passthru.updateScript` is left intact so `nix-update` CLI use locally is unaffected.

#### Rewriting the src URL via `downloadUrl`

Some upstreams stamp a per-release commit hash into the artifact filename (Raycast Beta, for example: `Raycast_Beta_0.61.0.0_e863712be6_arm64.dmg`). Simple `${version}` interpolation can't reconstruct the new URL — when the version bumps, the embedded commit hash also changes.

To handle this, the customDatasource transform may return a `downloadUrl` on each release:

```json
{
  "customDatasources": {
    "raycast-beta": {
      "defaultRegistryUrlTemplate": "https://x.raycast-releases.com/releases/latest?platform=macos&architecture=arm64&version=0.0.0.0",
      "format": "json",
      "transformTemplates": [
        "{ \"releases\": [{ \"version\": $.version, \"downloadUrl\": $.download_url }] }"
      ]
    }
  }
}
```

When `downloadUrl` is present on the chosen release, the nix-update manager rewrites the matching `url = "..."` literal inside the package's `src` block before running the hash prefetch. The .nix file should use a **literal** URL (no `${finalAttrs.version}` interpolation), since the manager replaces the whole string per release:

```nix
src = fetchurl {
  url = "https://x-r2.raycast-releases.com/Raycast_Beta_0.61.0.0_e863712be6_arm64.dmg";
  hash = "sha256-...";
};
```

This works alongside `passthru.renovate.datasource` — same opt-in surface; only the customDatasource transform changes.

#### Rolling artifacts (`--version=skip`)

Some packages pin a tag that never moves while the bytes behind it do — a `tip` or `nightly` release that is force-pushed on every upstream commit. `nix-update` models this as `--version=skip`: never touch the version, just re-fetch the hash.

Renovate needs _something_ to change before it will open a PR, and here the only thing that changes is the artifact's content. These packages are therefore modelled exactly like a Docker `:latest` pin: `currentValue` is the frozen **tag**, and `currentDigest` is the artifact's content hash — converted from nix's SRI encoding (`sha256-<base64>`) to the hex form GitHub reports (`sha256:<hex>`); they are the same 32 bytes. The update then travels Renovate's digest path, which terminates on its own: once `updateArtifacts` writes the new hash back, `currentDigest === newDigest` and nothing further is proposed.

Only a **flat** hash works — `fetchurl`, not `fetchzip`. A recursive (NAR) hash describes the unpacked tree and could never equal the digest GitHub reports for the file, so such packages are skipped with a warning rather than looping forever.

When the `src` is a GitHub release asset this needs **no configuration at all** — the manager selects the [`github-release-asset`](../../datasource/github-release-asset/index.md) datasource, which reports the asset's digest for a fixed tag:

```nix
stdenvNoCC.mkDerivation {
  pname = "ghostty-tip";
  version = "tip";

  src = fetchurl {
    url = "https://github.com/ghostty-org/ghostty/releases/download/tip/ghostty-macos-universal.zip";
    hash = "sha256-...";
  };

  passthru.updateScript = nix-update-script { extraArgs = [ "--version=skip" ]; };
}
```

Artifacts hosted elsewhere are **not** supported today: `passthru.renovate.datasource` is ignored for `--version=skip` packages. The manager selects `github-release-asset` unconditionally and skips any `src` that isn't a parseable GitHub release-asset URL. This is a wiring limitation rather than an architectural one — Renovate can drive digest updates from a customDatasource — so it could be extended if a non-GitHub case comes up.

The package's `version` attribute is never rewritten; only the hash moves.

### Limitations

- Non-flake repos are not supported
- Only packages with `passthru.updateScript = nix-update-script { ... }` are detected; other update scripts (e.g., `gitUpdater`) are ignored
- For branch-tracked packages (`--version=branch`), the branch name defaults to `main` when not explicitly specified via `--version=branch:<name>`. Repos using `master` or other default branches should set the explicit form in their `updateScript`
- For branch-tracked packages a nixpkgs-style `version = "<base>-unstable-YYYY-MM-DD"` date is bumped from the commit date, which the manager resolves through the datasource (`github-digest` derives its release timestamp from it). Digest updates carry no timestamp of their own, so this costs one extra — already cached — datasource lookup. When the date can't be established it is left untouched: the `rev` and hash still update, so the package builds either way. Note the date is derived in UTC, so it can differ by a day from what the `nix-update` CLI writes (which uses the committer's offset)
- `--version=skip` is supported only for GitHub release assets fetched with a flat hash (`fetchurl`); anything else is skipped with a warning, since there is no way to observe the content changing
- Custom out-of-nixpkgs fetchers (a `fetchMyThing` defined in your own flake) won't be recognised; the manager will emit an `artifactError` naming the FOD attribute path so you can either rename to a standard fetcher or open an issue
- The flake's `nixpkgs` input is reused for runner-side hash computation. If your flake names it differently, the manager falls back to the host's `<nixpkgs>` channel, which may diverge from your pinned nixpkgs and produce different vendor hashes for some ecosystems
- **Custom builder overrides** (e.g. a package that wraps `buildGoModule` to inject extra steps into the vendor build) are not faithfully reproduced. The manager calls plain `runnerPkgs.buildGoModule` / `runnerPkgs.rustPlatform.buildRustPackage` / etc., not the user's wrapper. If your `goModules`/`cargoDeps` build phase is non-standard, the computed hash may differ from what `nix build .#yourPkg` would produce. Open an issue if you hit this
- **Pinned toolchains are mirrored** where the FOD actually embeds one, since there the default would be wrong rather than merely different. The manager reads the toolchain off the package's own FOD (its `nativeBuildInputs`) and pins the rebuild to it: Go (`buildGo127Module` → `buildGoModule.override { go = go_1_27; }`), Zig (`zig_0_16.fetchDeps`), Elixir (`beamPackages.elixir_1_18`) and PHP (`php83.buildComposerProject2`). Pinning only happens on an exact `pname`+`version` match against the runner's nixpkgs, evaluated inside `builtins.tryEval` — nixpkgs keeps end-of-life toolchains as attributes that _abort when forced_, so `runnerPkgs ? go_1_23` is true while touching it raises, and `or ""` catches only a missing attribute, never a throwing one. When no exact match is found, Zig, Elixir and PHP **abort with a `nix-update:` message** rather than vendoring with a substitute: for those the toolchain changes what gets fetched, so guessing would mean writing a plausible but wrong hash into your repository. Go instead falls back to the runner's default, because the mismatch that matters announces itself: `GOTOOLCHAIN=local` makes a Go older than the package's `go` directive fail the build outright rather than vendor something different. That guarantee is one-directional — the default path of `buildGoModule` runs `go mod vendor` (not `go mod download`, which is only the `proxyVendor` path), and its output is not toolchain-invariant in general, so a package deliberately held on an _older_ Go than the runner's default could still vendor differently if the pin misses. That is pre-existing behaviour and it is narrow; aborting instead would fail every Go package whose exact patch release the runner's nixpkgs doesn't carry. A FOD with no toolchain recorded uses the default everywhere — there is nothing to pin to. That covers a cache entry predating this feature, and a build input whose evaluation aborts (they are read individually, so one bad input drops only itself rather than the whole list). `cargoDeps`, `npmDeps` and `yarnOfflineCache` need no pin: their FODs vendor via `fetch-cargo-vendor-util` / `prefetch-npm-deps` / `prefetch-yarn-deps` and never run the language toolchain at all
- **The Maven `mvnJdk` is not mirrored.** `buildMavenPackage` passes it through `env.JAVA_HOME` rather than into the FOD's `nativeBuildInputs`, so there is nothing on the derivation to read it back from. A package pinning a non-default `mvnJdk` gets its `mvnHash` computed under the runner's default JDK, which can differ. `nugetDeps` is likewise unverified — neither is exercised by any package we have to hand

### Troubleshooting

- **"Could not parse fetchFromGitLab URL"**: GitLab archive URLs aren't reliably reverse-parseable into owner/repo/rev. Workaround: switch to `fetchgit` or `fetchurl` directly until URL-parsing for GitLab archives is added.
- **`artifactError` mentioning a vendor FOD attribute**: typically means the runner-side rebuild needs an input we didn't extract (e.g., a non-standard `pnpm.fetcherVersion`). Open an issue with the package's nix expression.
- **`artifactError` starting "FOD build failed"**: the FOD's own builder failed before nix got as far as checking the hash, so the message carries the tail of the nix build log — read that, not the manager. Common cause: the vendor step can't run under the toolchain the rebuild selected.
- **`artifactError` containing "nix-update: this package builds with …"**: the package pins a Zig/Elixir/PHP toolchain that the runner's nixpkgs has no exact match for, so the rebuild refused to substitute a different one and compute a wrong hash. Two common causes. Most often the extract is stale: the recorded toolchain version is compared exactly, so bumping `flake.lock` to a nixpkgs with a newer patch release trips this until the package is re-extracted. Otherwise the runner resolved a different nixpkgs than the package did — check that your flake's nixpkgs input is named `nixpkgs`, since the manager falls back to the host channel when it isn't.
- **Hash unchanged but PR shows old hash**: indicates the prefetch returned the same hash already in the file — usually means renovate decided a version bump was needed but the source content didn't actually change. The PR is still created (with version-only metadata) but no hash diff.
