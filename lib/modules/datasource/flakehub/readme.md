# FlakeHub Datasource

Fetches package information from [FlakeHub](https://flakehub.com), a discovery service and registry for Nix flakes.

## Usage

This datasource is primarily used by the [Nix manager](../../manager/nix/index.md) to update FlakeHub-based dependencies in `flake.lock` files.

When a Nix flake input uses a FlakeHub URL like:

```nix
{
  inputs = {
    flake-compat.url = "https://flakehub.com/f/edolstra/flake-compat/1.tar.gz";
  };
}
```

The datasource will query the FlakeHub API to discover available versions and update the dependency accordingly.

## API

The datasource queries `https://api.flakehub.com/f/{owner}/{project}/releases` to fetch all available releases for a flake.

## Package Names

Package names follow the format `{owner}/{project}`, for example:

- `edolstra/flake-compat`
- `NixOS/nixpkgs`
- `nix-community/home-manager`

## Versioning

FlakeHub uses semantic versioning. The datasource returns releases with their full semantic version numbers along with the corresponding Git commit SHA.

## Deprecated Releases

Releases that have been yanked (marked as deprecated on FlakeHub) are returned with `isDeprecated: true`.
