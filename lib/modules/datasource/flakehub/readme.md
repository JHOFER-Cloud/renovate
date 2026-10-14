This datasource fetches version information from
[FlakeHub](https://flakehub.com), a discovery service and registry for Nix
flakes.

## How It Works

The datasource queries the FlakeHub API using version constraints to find
matching releases. Unlike traditional package registries that return all
available versions, FlakeHub's API returns a single version matching the
specified constraint.

- **API endpoint**:
  `https://api.flakehub.com/version/{packageName}/{constraint}`
- **Default registryUrl**: `https://api.flakehub.com`
- **packageName format**: `{owner}/{project}`, for example:
  - `edolstra/flake-compat`
  - `NixOS/nixpkgs`
  - `nix-community/home-manager`

## Version Constraints

The datasource queries with a version constraint (or `*` for the latest) and
returns the matching version. This is primarily used by the
[Nix manager](../../manager/nix/index.md) to update FlakeHub-based dependencies
in `flake.lock` files.

When a Nix flake input uses a FlakeHub URL like:

```nix
{
  inputs = {
    flake-compat.url = "https://flakehub.com/f/edolstra/flake-compat/1.tar.gz";
  };
}
```

Renovate will query for versions matching the `1` constraint to check for
updates within that major version.

## Versioning

FlakeHub uses semantic versioning. The datasource returns the simplified version
number (e.g. `1.1.0`) and the corresponding Git commit revision for pinning.

## Deprecated Releases

Releases that have been yanked on FlakeHub are returned with
`isDeprecated: true`.
