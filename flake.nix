{
  description = "Renovate development environment";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/JHOFER-Cloud/NixOS-nixpkgs/0.1.tar.gz";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            git
            gh
            jq
            tsx
            nodejs_25
            pnpm
          ];

          shellHook = ''
            # Set environment variables
            export NODE_ENV="development"
            export LOG_LEVEL="debug"

            # Create shell aliases for convenience
            alias d-build="pnpm run build"
            alias d-test="pnpm test"
            alias d-lint="pnpm run lint"
            alias d-lint-fix="pnpm run lint-fix"
            alias d-dev="pnpm start"
            alias d-clean="pnpm run clean"
            alias d-type-check="pnpm run type-check"
            alias d-prettier="pnpm run prettier-fix"
            alias d-docs="pnpm run build:docs"
            alias d-prepare="pnpm run prepare"

            # Run automated tasks
            echo "Installing dependencies..."
            pnpm install

            echo "Running generate..."
            pnpm run generate
          '';
        };
      }
    );
}
