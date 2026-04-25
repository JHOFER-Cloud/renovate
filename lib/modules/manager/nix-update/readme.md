The `nix-update` manager creates per-package PRs for nixpkgs-style derivations that declare `passthru.updateScript = nix-update-script { ... }`.

### Requirements

- The repository must be a Nix flake (a `flake.nix` must exist at the repo root)
- `nix` must be available — when using the full Renovate image with `RENOVATE_BINARY_SOURCE=install`, this is handled automatically by containerbase

`nix-update` is invoked via `nix run nixpkgs#nix-update`, so no separate installation is needed beyond `nix` itself.

### How it works

1. **Discovery**: Scans matched `.nix` files for `passthru.updateScript = nix-update-script`. If any are found, runs one `nix eval .#packages` call to introspect all packages with an update script, across all supported systems. The source URL (`src.url`) is used to determine the appropriate Renovate datasource (e.g., `github-tags`, `pypi`, `crate`).
2. **Per-package PRs**: Renovate creates a separate branch and PR for each discovered package.
3. **Updating**: Runs `nix-update --flake <attrName>` with the version resolved by Renovate's datasource. Any extra arguments from `passthru.updateScript.command` (e.g., `--version=branch`) are forwarded to nix-update. The tool updates the version and hashes in the package file.

### Configuration

Add `nix-update` to your `enabledManagers` list:

```json
{
  "enabledManagers": ["nix-update"]
}
```

#### Build verification

To run `nix build` after each update (to verify it builds), add `nixUpdateBuild` to `postUpdateOptions`:

```json
{
  "postUpdateOptions": ["nixUpdateBuild"]
}
```

Note: `--build` is only passed when the package's system matches the runner's system (currently `x86_64-linux`, `x86_64-darwin`, `aarch64-linux`, or `aarch64-darwin`). Cross-platform builds are skipped.

### Limitations

- Non-flake repos are not supported
- Only packages with `passthru.updateScript = nix-update-script { ... }` are detected; other update scripts (e.g., `gitUpdater`) are ignored
- For branch-tracked packages (`--version=branch`), the branch name defaults to `main` when not explicitly specified via `--version=branch:<name>`. Repos using `master` or other default branches should set the explicit form in their `updateScript`
- Supported source URL mappings: GitHub, GitLab, Bitbucket, Codeberg, Gitea, SourceHut, Savannah, crates.io, PyPI, RubyGems, and generic HTTPS git repos. Packages with unmappable source URLs are skipped with a warning
