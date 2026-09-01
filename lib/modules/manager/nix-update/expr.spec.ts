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
      expect(e).toContain('(runnerPkgs.go_1_27.pname or "") == "go"');
    });
    it('go: contains a throwing attr in the guard rather than exploding on it', () => {
      // nixpkgs keeps EOL toolchains as attrs that abort when forced, so
      // `? attr` is true while touching it raises. Only tryEval contains that.
      const e = exprForGoModules(
        FLAKE,
        { ...VEND, tools: [{ pname: 'go', version: '1.23.12' }] },
        'sha256',
      );
      expect(e).toContain('builtins.tryEval');
      expect(e).toContain('ok.success && ok.value');
    });
    it('go: falls back to the default builder rather than aborting', () => {
      // Unique to go: the module tree does not vary with the toolchain, and a
      // too-old go fails the build loudly instead of vendoring something else.
      const e = exprForGoModules(FLAKE, { ...VEND, tools: GO_127 }, 'sha256');
      expect(e).toContain('if go == null then runnerPkgs.buildGoModule');
      expect(e).not.toContain('throw');
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
    it('composer: pins the php minor on an exact pname+version match', () => {
      const e = exprForComposerVendor(
        FLAKE,
        // both the FOD's php and the phpXX attr are php-with-extensions
        // wrappers, so pname is a usable half of the guard
        {
          ...VEND,
          tools: [{ pname: 'php-with-extensions', version: '8.3.33' }],
        },
        'sha256',
      );
      expect(e).toContain('runnerPkgs.php83');
      expect(e).toContain(
        '(runnerPkgs.php83.pname or "") == "php-with-extensions"',
      );
      expect(e).toContain('(runnerPkgs.php83.version or "") == "8.3.33"');
      // composer resolves platform requirements against the php version, so a
      // substituted php can select different packages — abort, don't guess
      expect(e).toContain('throw "nix-update:');
    });
    it('maven: maven.buildMavenPackage with mvnHash', () => {
      const e = exprForMavenDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('maven.buildMavenPackage');
      expect(e).toContain('mvnHash');
    });
    it('maven: does not attempt to pin mvnJdk', () => {
      // buildMavenPackage passes mvnJdk through env.JAVA_HOME, never into
      // nativeBuildInputs, so there is nothing on the FOD to pin to. Even a
      // JDK that happens to show up among the tools must not be used.
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
      expect(e).not.toContain('mvnJdk');
      expect(e).not.toContain('temurin');
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
      // an elixir/erlang combination the runner can't build aborts at the
      // guard, which therefore has to be inside tryEval
      expect(e).toContain('builtins.tryEval');
      expect(e).toContain('throw "nix-update:');
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
    it('zig: aborts rather than vendoring with a different compiler', () => {
      // A wrong-major zig writes a different cache layout, so the fallback
      // would be a plausible but wrong hash — worse than a failed run.
      const e = exprForZigDeps(
        FLAKE,
        { ...VEND, tools: [{ pname: 'zig', version: '0.16.0' }] },
        'sha256',
      );
      expect(e).toContain('throw "nix-update:');
      // a regression to the old fallback renders `… else runnerPkgs.zig)`,
      // so that — not `else runnerPkgs.zig.fetchDeps` — is what to exclude
      expect(e).not.toContain('else runnerPkgs.zig)');
    });
    it('zig: falls back to the default compiler when the version is unknown', () => {
      // Nothing was extracted to pin to (a cache entry predating `tools`), so
      // there is no basis to abort on.
      const e = exprForZigDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('runnerPkgs.zig.fetchDeps');
      expect(e).not.toContain('throw');
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
