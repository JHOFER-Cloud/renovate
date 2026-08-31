import {
  collapseExpr,
  exprForCargoDeps,
  exprForComposerVendor,
  exprForGoModules,
  exprForMavenDeps,
  exprForMixFodDeps,
  exprForNpmDeps,
  exprForNuGetDeps,
  exprForPnpmDeps,
  exprForSrcFetcher,
  exprForYarnDeps,
  exprForZigDeps,
  nixVal,
} from './expr.ts';

const FLAKE = '/tmp/repo';
const VEND = { pname: 'foo', version: '1.0', srcExpr: '<src>' };
const GO_127 = [
  { pname: 'go', version: '1.27.0' },
  { pname: 'git-minimal', version: '2.55.0' },
];

describe('modules/manager/nix-update/expr', () => {
  describe('nixVal', () => {
    it('serializes null and undefined', () => {
      expect(nixVal(null)).toBe('null');
      expect(nixVal(undefined)).toBe('null');
    });
    it('serializes booleans', () => {
      expect(nixVal(true)).toBe('true');
      expect(nixVal(false)).toBe('false');
    });
    it('serializes numbers', () => {
      expect(nixVal(42)).toBe('42');
      expect(nixVal(3.14)).toBe('3.14');
    });
    it('escapes ${} in strings to prevent nix interpolation', () => {
      expect(nixVal('hello ${foo}')).toBe('"hello \\${foo}"');
    });
    it('serializes arrays as nix lists', () => {
      expect(nixVal(['a', 'b'])).toBe('[ "a" "b" ]');
    });
    it('serializes objects as nix attrsets', () => {
      expect(nixVal({ a: 1, b: 'two' })).toBe('{ a = 1; b = "two"; }');
    });
    it('omits undefined attrs in objects', () => {
      expect(nixVal({ a: 1, b: undefined })).toBe('{ a = 1; }');
    });
    it('throws on unsupported types (e.g. function)', () => {
      expect(() => nixVal(() => 1)).toThrow(/Cannot serialize/);
    });
  });

  describe('exprForSrcFetcher', () => {
    it('emits fetchurl with urls list when urls provided', () => {
      const e = exprForSrcFetcher(
        FLAKE,
        'fetchurl',
        { urls: ['https://a/x', 'https://b/x'] },
        'sha256',
      );
      expect(e).toContain('urls = [ "https://a/x" "https://b/x" ]');
    });
    it('emits fetchzip', () => {
      const e = exprForSrcFetcher(
        FLAKE,
        'fetchzip',
        { url: 'https://x' },
        'sha256',
      );
      expect(e).toContain('runnerPkgs.fetchzip');
    });
    it('emits fetchhg', () => {
      const e = exprForSrcFetcher(
        FLAKE,
        'fetchhg',
        { url: 'https://h', rev: 'r' },
        'sha256',
      );
      expect(e).toContain('runnerPkgs.fetchhg');
      expect(e).toContain('rev = "r"');
    });
    it('emits fetchgem', () => {
      const e = exprForSrcFetcher(
        FLAKE,
        'fetchgem',
        { pname: 'rails', version: '7.0.0' },
        'sha256',
      );
      expect(e).toContain('runnerPkgs.fetchgem');
      expect(e).toContain('pname = "rails"');
    });
    it('emits sha512 placeholder for sha512 algo', () => {
      const e = exprForSrcFetcher(
        FLAKE,
        'fetchurl',
        { url: 'https://x' },
        'sha512',
      );
      expect(e).toContain('hash = "sha512-');
    });
    it('emits sha1 placeholder for sha1 algo', () => {
      const e = exprForSrcFetcher(
        FLAKE,
        'fetchurl',
        { url: 'https://x' },
        'sha1',
      );
      expect(e).toContain('hash = "sha1-');
    });
    it('throws on unsupported fetcher name', () => {
      expect(() =>
        exprForSrcFetcher(FLAKE, 'fetchUnknown', {}, 'sha256'),
      ).toThrow(/Unsupported source fetcher/);
    });
  });

  describe('vendor expression builders', () => {
    it('go: includes pname/version/src/vendorHash and .goModules', () => {
      const e = exprForGoModules(FLAKE, VEND, 'sha256');
      expect(e).toContain('pname = "foo"');
      expect(e).toContain('vendorHash');
      expect(e).toContain('.goModules');
    });
    it('go: pins the package’s go toolchain when known', () => {
      const e = exprForGoModules(FLAKE, { ...VEND, tools: GO_127 }, 'sha256');
      // Vendoring under the default (older) go fails outright — GOTOOLCHAIN=local
      // means go won't upgrade itself to satisfy go.mod.
      expect(e).toContain('runnerPkgs ? go_1_27');
      expect(e).toContain('runnerPkgs.buildGoModule.override { inherit go; }');
    });
    it('go: only pins on an exact version match, never a same-major guess', () => {
      const e = exprForGoModules(FLAKE, { ...VEND, tools: GO_127 }, 'sha256');
      expect(e).toContain('(runnerPkgs.go_1_27.version or "") == "1.27.0"');
    });
    it('go: falls back to the default builder when the go version is unknown', () => {
      expect(exprForGoModules(FLAKE, VEND, 'sha256')).not.toContain('override');
      expect(
        exprForGoModules(
          FLAKE,
          { ...VEND, tools: [{ pname: 'go', version: 'unstable' }] },
          'sha256',
        ),
      ).not.toContain('override');
      expect(
        exprForGoModules(
          FLAKE,
          { ...VEND, tools: [{ pname: 'go', version: null }] },
          'sha256',
        ),
      ).not.toContain('override');
      // a FOD with no go in it at all (every non-go ecosystem)
      expect(
        exprForGoModules(
          FLAKE,
          { ...VEND, tools: [{ pname: 'git-minimal', version: '2.55.0' }] },
          'sha256',
        ),
      ).not.toContain('override');
    });
    it('cargo: rustPlatform.buildRustPackage with cargoHash', () => {
      const e = exprForCargoDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('rustPlatform.buildRustPackage');
      expect(e).toContain('cargoHash');
    });
    it('npm: fetchNpmDeps with name', () => {
      const e = exprForNpmDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('fetchNpmDeps');
      expect(e).toContain('name = "foo-1.0-npm-deps"');
    });
    it('pnpm: uses fetchPnpmDeps, not the deprecated pnpm.fetchDeps', () => {
      const e = exprForPnpmDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('runnerPkgs.fetchPnpmDeps');
      // pnpm.fetchDeps force-overrides the pnpm argument with its own version.
      expect(e).not.toContain('pnpm.fetchDeps');
    });
    it('pnpm: includes fetcherVersion when set', () => {
      const e = exprForPnpmDeps(
        FLAKE,
        { ...VEND, fetcherVersion: 3 },
        'sha256',
      );
      expect(e).toContain('fetcherVersion = 3');
    });
    it('pnpm: omits fetcherVersion when not set', () => {
      const e = exprForPnpmDeps(FLAKE, VEND, 'sha256');
      expect(e).not.toContain('fetcherVersion');
    });
    it('pnpm: pins the package’s pnpm major', () => {
      const e = exprForPnpmDeps(
        FLAKE,
        { ...VEND, pnpmVersion: '11.20.0' },
        'sha256',
      );
      expect(e).toContain('pnpm = runnerPkgs.pnpm_11;');
      // A fallback to the default pnpm would silently produce a wrong hash.
      expect(e).not.toContain('or runnerPkgs.pnpm');
    });
    it('pnpm: omits the pnpm pin when the version is unusable', () => {
      const e = exprForPnpmDeps(
        FLAKE,
        { ...VEND, pnpmVersion: 'unstable' },
        'sha256',
      );
      expect(e).not.toContain('runnerPkgs.pnpm_');
    });
    it('pnpm: forwards workspaces, install flags and prePnpmInstall', () => {
      const e = exprForPnpmDeps(
        FLAKE,
        {
          ...VEND,
          pnpmWorkspaces: ['a', 'b'],
          pnpmInstallFlags: ['--foo'],
          prePnpmInstall: 'pnpm config set x y',
        },
        'sha256',
      );
      expect(e).toContain('pnpmWorkspaces = [ "a" "b" ];');
      expect(e).toContain('pnpmInstallFlags = [ "--foo" ];');
      expect(e).toContain('prePnpmInstall = "pnpm config set x y";');
    });
    it('pnpm: omits empty lists rather than passing them explicitly', () => {
      const e = exprForPnpmDeps(
        FLAKE,
        { ...VEND, pnpmWorkspaces: [], pnpmInstallFlags: [] },
        'sha256',
      );
      expect(e).not.toContain('pnpmWorkspaces');
      expect(e).not.toContain('pnpmInstallFlags');
    });
    it('yarn: fetchYarnDeps with yarnLock path', () => {
      const e = exprForYarnDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('fetchYarnDeps');
      expect(e).toContain('yarn.lock');
    });
    it('composer: php.buildComposerProject with vendorHash', () => {
      const e = exprForComposerVendor(FLAKE, VEND, 'sha256');
      expect(e).toContain('php.buildComposerProject');
      expect(e).toContain('.composerVendor');
    });
    it('composer: v2 builder for composerVendor, v1 for composerRepository', () => {
      // The two generations expose the FOD under different names; calling the
      // wrong builder means reading an attribute that isn't there.
      const v2 = exprForComposerVendor(FLAKE, VEND, 'sha256', 'composerVendor');
      expect(v2).toContain('buildComposerProject2');
      expect(v2).toContain('.composerVendor');
      const v1 = exprForComposerVendor(
        FLAKE,
        VEND,
        'sha256',
        'composerRepository',
      );
      expect(v1).toContain('.buildComposerProject ');
      expect(v1).not.toContain('buildComposerProject2');
      expect(v1).toContain('.composerRepository');
    });
    it('composer: pins the php minor the package built against', () => {
      const e = exprForComposerVendor(
        FLAKE,
        // the FOD's php is a wrapper, so pname is php-with-extensions
        {
          ...VEND,
          tools: [{ pname: 'php-with-extensions', version: '8.3.33' }],
        },
        'sha256',
      );
      expect(e).toContain('runnerPkgs.php83');
    });
    it('maven: maven.buildMavenPackage with mvnHash', () => {
      const e = exprForMavenDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('maven.buildMavenPackage');
      expect(e).toContain('mvnHash');
    });
    it('maven: pins mvnJdk on an exact pname+version match', () => {
      const e = exprForMavenDeps(
        FLAKE,
        {
          ...VEND,
          tools: [
            { pname: 'maven', version: '3.9.16' },
            { pname: 'temurin-bin', version: '21.0.11' },
          ],
        },
        'sha256',
      );
      expect(e).toContain('mvnJdk');
      // jdk21 and temurin-bin-21 share a version but are different
      // derivations, so pname has to be part of the guard.
      expect(e).toContain('(runnerPkgs.jdk21.pname or "") == "temurin-bin"');
      expect(e).toContain('runnerPkgs.temurin-bin-21');
    });
    it('maven: recognises a zulu JDK too', () => {
      const e = exprForMavenDeps(
        FLAKE,
        { ...VEND, tools: [{ pname: 'zulu-ca-jdk', version: '17.0.19' }] },
        'sha256',
      );
      expect(e).toContain('(runnerPkgs.jdk17.pname or "") == "zulu-ca-jdk"');
    });
    it('maven: passes no mvnJdk at all when the JDK is unrecognised', () => {
      const e = exprForMavenDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('if jdk == null then {}');
    });
    it('mix: beamPackages.fetchMixDeps with -deps suffix', () => {
      const e = exprForMixFodDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('beamPackages.fetchMixDeps');
      expect(e).toContain('foo-deps');
    });
    it('mix: pins elixir from within the beam set, not the deprecated alias', () => {
      const e = exprForMixFodDeps(
        FLAKE,
        { ...VEND, tools: [{ pname: 'elixir', version: '1.18.4' }] },
        'sha256',
      );
      expect(e).toContain('runnerPkgs.beamPackages.elixir_1_18');
      expect(e).toContain('fetchMixDeps.override { inherit elixir; }');
      // the top-level elixir_1_18 alias is deprecated and can pair an elixir
      // with an erlang it doesn't support
      expect(e).not.toContain('runnerPkgs.elixir_1_18');
    });
    it('zig: uses the compiler’s own fetchDeps, pinned to its version', () => {
      const e = exprForZigDeps(
        FLAKE,
        { ...VEND, tools: [{ pname: 'zig', version: '0.16.0' }] },
        'sha256',
      );
      // Each zig attr carries a fetchDeps with that compiler bound in.
      expect(e).toContain('runnerPkgs.zig_0_16');
      expect(e).toContain('.fetchDeps');
      // The old build-support path no longer exists in nixpkgs.
      expect(e).not.toContain('fetch-deps.nix');
    });
    it('zig: falls back to the default compiler when the version is unknown', () => {
      const e = exprForZigDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('runnerPkgs.zig.fetchDeps');
    });
    it('zig: mirrors fetchAll, which changes what lands in the store', () => {
      expect(
        exprForZigDeps(FLAKE, { ...VEND, fetchAll: true }, 'sha256'),
      ).toContain('fetchAll = true;');
      expect(exprForZigDeps(FLAKE, VEND, 'sha256')).not.toContain('fetchAll');
    });
    it('nuget: fetchNuGetDeps', () => {
      const e = exprForNuGetDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('fetchNuGetDeps');
    });
  });

  describe('collapseExpr', () => {
    it('collapses whitespace to single space', () => {
      expect(collapseExpr('  a\n  b\n   c  ')).toBe('a b c');
    });
  });
});
