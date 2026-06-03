The `nix-update` manager creates per-package PRs for nixpkgs-style derivations that declare `passthru.updateScript = nix-update-script { ... }`.

### Requirements

- The repository must be a Nix flake (a `flake.nix` must exist at the repo root)
- The flake should expose `nixpkgs` as an input named `nixpkgs` (the manager re-uses it for runner-side hash computation)
- `nix` must be available — when using the full Renovate image with `RENOVATE_BINARY_SOURCE=install`, this is handled automatically by containerbase

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
- PHP: `composerVendor` / `composerRepository`
- Java/Maven: `fetchedMavenDeps`
- Elixir: `mixFodDeps`
- Zig: `zigDeps`
- .NET: `nugetDeps`

A package may carry several of these — they're all updated in one PR.

### Limitations

- Non-flake repos are not supported
- Only packages with `passthru.updateScript = nix-update-script { ... }` are detected; other update scripts (e.g., `gitUpdater`) are ignored
- For branch-tracked packages (`--version=branch`), the branch name defaults to `main` when not explicitly specified via `--version=branch:<name>`. Repos using `master` or other default branches should set the explicit form in their `updateScript`
- Custom out-of-nixpkgs fetchers (a `fetchMyThing` defined in your own flake) won't be recognised; the manager will emit an `artifactError` naming the FOD attribute path so you can either rename to a standard fetcher or open an issue
- The flake's `nixpkgs` input is reused for runner-side hash computation. If your flake names it differently, the manager falls back to the host's `<nixpkgs>` channel, which may diverge from your pinned nixpkgs and produce different vendor hashes for some ecosystems
- **Custom builder overrides** (e.g. a package that wraps `buildGoModule` to inject extra steps into the vendor build) are not faithfully reproduced. The manager calls plain `runnerPkgs.buildGoModule` / `runnerPkgs.rustPlatform.buildRustPackage` / etc., not the user's wrapper. If your `goModules`/`cargoDeps` build phase is non-standard, the computed hash may differ from what `nix build .#yourPkg` would produce. Open an issue if you hit this

### Troubleshooting

- **"Could not parse fetchFromGitLab URL"**: GitLab archive URLs aren't reliably reverse-parseable into owner/repo/rev. Workaround: switch to `fetchgit` or `fetchurl` directly until URL-parsing for GitLab archives is added.
- **`artifactError` mentioning a vendor FOD attribute**: typically means the runner-side rebuild needs an input we didn't extract (e.g., a non-standard `pnpm.fetcherVersion`). Open an issue with the package's nix expression.
- **Hash unchanged but PR shows old hash**: indicates the prefetch returned the same hash already in the file — usually means renovate decided a version bump was needed but the source content didn't actually change. The PR is still created (with version-only metadata) but no hash diff.
