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
    it('maven: maven.buildMavenPackage with mvnHash', () => {
      const e = exprForMavenDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('maven.buildMavenPackage');
      expect(e).toContain('mvnHash');
    });
    it('mix: beamPackages.fetchMixDeps with -deps suffix', () => {
      const e = exprForMixFodDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('beamPackages.fetchMixDeps');
      expect(e).toContain('foo-deps');
    });
    it('zig: callPackage with build-support path', () => {
      const e = exprForZigDeps(FLAKE, VEND, 'sha256');
      expect(e).toContain('zig/fetch-deps.nix');
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
