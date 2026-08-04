import type { FodInfo } from './extract.ts';
import { buildKnownSrcExpr, classifyFod } from './fetchers.ts';

const FLAKE = '/tmp/repo';

function makeFod(
  attrPath: string[],
  inputs: Partial<FodInfo['inputs']>,
): FodInfo {
  return {
    attrPath,
    inputs: {
      outputHash: 'sha256-OLD',
      outputHashAlgo: 'sha256',
      outputHashMode: 'flat',
      url: null,
      rev: null,
      fetchSubmodules: null,
      leaveDotGit: null,
      deepClone: null,
      forceFetchGit: null,
      sparseCheckout: null,
      name: null,
      ...inputs,
    },
  };
}

describe('modules/manager/nix-update/fetchers', () => {
  describe('classifyFod — src fetchers', () => {
    it('classifies fetchurl when url is present and mode flat', () => {
      const fod = makeFod(['src'], {
        url: 'https://example.com/foo.tar.gz',
        outputHashMode: 'flat',
      });
      const c = classifyFod(fod, 'foo', '1.0');
      expect(c.fetcherName).toBe('fetchurl');
      expect(c.isSrc).toBe(true);
      const expr = c.buildExpr(FLAKE, '');
      expect(expr).toContain('runnerPkgs.fetchurl');
      expect(expr).toContain('https://example.com/foo.tar.gz');
    });

    it('classifies fetchzip when mode is recursive', () => {
      const fod = makeFod(['src'], {
        url: 'https://example.com/foo.zip',
        outputHashMode: 'recursive',
      });
      const c = classifyFod(fod, 'foo', '1.0');
      expect(c.fetcherName).toBe('fetchzip');
    });

    it('classifies fetchFromGitHub from archive URL', () => {
      const fod = makeFod(['src'], {
        url: 'https://github.com/owner/repo/archive/v1.2.3.tar.gz',
        outputHashMode: 'recursive',
      });
      const c = classifyFod(fod, 'foo', '1.0');
      expect(c.fetcherName).toBe('fetchFromGitHub');
      const expr = c.buildExpr(FLAKE, '');
      expect(expr).toContain('runnerPkgs.fetchFromGitHub');
      expect(expr).toContain('owner = "owner"');
      expect(expr).toContain('repo = "repo"');
      expect(expr).toContain('rev = "v1.2.3"');
    });

    it('classifies fetchFromBitbucket from archive URL', () => {
      const fod = makeFod(['src'], {
        url: 'https://bitbucket.org/x/y/get/abc.tar.gz',
        outputHashMode: 'recursive',
      });
      const c = classifyFod(fod, 'foo', '1.0');
      expect(c.fetcherName).toBe('fetchFromBitbucket');
    });

    it('classifies fetchgit when URL ends in .git (rev alone is not a discriminator)', () => {
      const fod = makeFod(['src'], {
        url: 'https://github.com/owner/repo.git',
        rev: 'abc123',
        outputHashMode: 'recursive',
      });
      const c = classifyFod(fod, 'foo', '1.0');
      expect(c.fetcherName).toBe('fetchgit');
      const expr = c.buildExpr(FLAKE, '');
      expect(expr).toContain('runnerPkgs.fetchgit');
      expect(expr).toContain('rev = "abc123"');
    });

    it('classifies fetchFromGitHub even when rev is set as passthrough', () => {
      // fetchFromGitHub's resulting derivation passes `rev` through as a
      // top-level attr. Don't be fooled into routing to fetchgit.
      const fod = makeFod(['src'], {
        url: 'https://github.com/owner/repo/archive/v1.tar.gz',
        rev: 'v1',
        outputHashMode: 'recursive',
      });
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('fetchFromGitHub');
    });

    it('classifies fetchPypi from URL', () => {
      const fod = makeFod(['src'], {
        url: 'https://files.pythonhosted.org/packages/source/f/foo/foo-1.2.3.tar.gz',
        outputHashMode: 'flat',
      });
      const c = classifyFod(fod, 'foo', '1.2.3');
      expect(c.fetcherName).toBe('fetchPypi');
      const expr = c.buildExpr(FLAKE, '');
      expect(expr).toContain('pname = "foo"');
      expect(expr).toContain('version = "1.2.3"');
    });

    it('classifies fetchCrate', () => {
      const fod = makeFod(['src'], {
        url: 'https://crates.io/api/v1/crates/foo/1.2.3/download',
        outputHashMode: 'recursive',
      });
      const c = classifyFod(fod, 'foo', '1.2.3');
      expect(c.fetcherName).toBe('fetchCrate');
    });

    it('preserves sha512 algorithm', () => {
      const fod = makeFod(['src'], {
        url: 'https://example.com/x.tar.gz',
        outputHashAlgo: 'sha512',
      });
      const c = classifyFod(fod, 'foo', '1');
      expect(c.algo).toBe('sha512');
      const expr = c.buildExpr(FLAKE, '');
      expect(expr).toContain('sha512-');
    });
  });

  describe('classifyFod — vendor FODs', () => {
    it('classifies goModules', () => {
      const fod = makeFod(['goModules'], {});
      const c = classifyFod(fod, 'foo', '1.0');
      expect(c.fetcherName).toBe('goModules');
      expect(c.isSrc).toBe(false);
      const expr = c.buildExpr(FLAKE, '<srcExpr>');
      expect(expr).toContain('runnerPkgs.buildGoModule');
      expect(expr).toContain('<srcExpr>');
      expect(expr).toContain('vendorHash');
      expect(expr).toContain('.goModules');
    });

    it('classifies cargoDeps', () => {
      const fod = makeFod(['cargoDeps'], {});
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('cargoDeps');
      const expr = c.buildExpr(FLAKE, '<src>');
      expect(expr).toContain('runnerPkgs.rustPlatform.buildRustPackage');
      expect(expr).toContain('cargoHash');
      expect(expr).toContain('.cargoDeps');
    });

    it('classifies npmDeps', () => {
      const fod = makeFod(['npmDeps'], {});
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('npmDeps');
      const expr = c.buildExpr(FLAKE, '<src>');
      expect(expr).toContain('runnerPkgs.fetchNpmDeps');
    });

    it('classifies pnpmDeps', () => {
      const fod = makeFod(['pnpmDeps'], {});
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('pnpmDeps');
      const expr = c.buildExpr(FLAKE, '<src>');
      expect(expr).toContain('runnerPkgs.pnpm.fetchDeps');
    });

    it('classifies yarnOfflineCache', () => {
      const fod = makeFod(['yarnOfflineCache'], {});
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('yarnOfflineCache');
      const expr = c.buildExpr(FLAKE, '<src>');
      expect(expr).toContain('runnerPkgs.fetchYarnDeps');
    });

    it('classifies composerVendor', () => {
      const fod = makeFod(['composerVendor'], {});
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('composerVendor');
      const expr = c.buildExpr(FLAKE, '<src>');
      expect(expr).toContain('php.buildComposerProject');
    });

    it('classifies fetchedMavenDeps', () => {
      const fod = makeFod(['fetchedMavenDeps'], {});
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('fetchedMavenDeps');
      const expr = c.buildExpr(FLAKE, '<src>');
      expect(expr).toContain('maven.buildMavenPackage');
    });

    it('classifies mixFodDeps', () => {
      const fod = makeFod(['mixFodDeps'], {});
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('mixFodDeps');
      const expr = c.buildExpr(FLAKE, '<src>');
      expect(expr).toContain('beamPackages.fetchMixDeps');
    });

    it('classifies zigDeps', () => {
      const fod = makeFod(['zigDeps'], {});
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('zigDeps');
      const expr = c.buildExpr(FLAKE, '<src>');
      expect(expr).toContain('zig/fetch-deps.nix');
    });

    it('classifies nugetDeps', () => {
      const fod = makeFod(['nugetDeps'], {});
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('nugetDeps');
      const expr = c.buildExpr(FLAKE, '<src>');
      expect(expr).toContain('runnerPkgs.fetchNuGetDeps');
    });

    it('throws on unrecognized vendor FOD attribute', () => {
      const fod = makeFod(['someUnknownDeps'], {});
      expect(() => classifyFod(fod, 'foo', '1')).toThrow(
        /Unsupported vendor FOD/,
      );
    });
  });

  describe('classifyFod — additional src fetchers', () => {
    it('classifies fetchhg from hg+ URL prefix', () => {
      const fod = makeFod(['src'], {
        url: 'hg+https://hg.example.com/repo',
        rev: 'abc',
        outputHashMode: 'recursive',
      });
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('fetchhg');
    });

    it('classifies fetchsvn from svn+ URL prefix', () => {
      const fod = makeFod(['src'], {
        url: 'svn+https://svn.example.com/repo',
        rev: 'abc',
        outputHashMode: 'recursive',
      });
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('fetchsvn');
    });

    it('classifies fetchgem from URL', () => {
      const fod = makeFod(['src'], {
        url: 'https://rubygems.org/gems/rails-7.0.0.gem',
        outputHashMode: 'flat',
      });
      const c = classifyFod(fod, 'rails', '7.0.0');
      expect(c.fetcherName).toBe('fetchgem');
    });

    it('classifies fetchFromGitea', () => {
      const fod = makeFod(['src'], {
        url: 'https://gitea.example/owner/repo/archive/v1.tar.gz',
        outputHashMode: 'recursive',
      });
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('fetchFromGitea');
    });

    it('classifies fetchFromSourcehut', () => {
      const fod = makeFod(['src'], {
        url: 'https://git.sr.ht/~user/repo/archive/v1.tar.gz',
        outputHashMode: 'recursive',
      });
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('fetchFromSourcehut');
    });

    it('passes git fetch options through to fetchgit', () => {
      const fod = makeFod(['src'], {
        url: 'https://gitlab.com/owner/repo.git',
        rev: 'abc123',
        fetchSubmodules: true,
        leaveDotGit: true,
        deepClone: true,
        sparseCheckout: ['path1', 'path2'],
      });
      const c = classifyFod(fod, 'foo', '1');
      expect(c.fetcherName).toBe('fetchgit');
      const expr = c.buildExpr(FLAKE, '');
      expect(expr).toContain('fetchSubmodules = true');
      expect(expr).toContain('leaveDotGit = true');
      expect(expr).toContain('deepClone = true');
      expect(expr).toContain('sparseCheckout = [ "path1" "path2" ]');
    });

    it('passes fetchSubmodules to fetchFromGitHub', () => {
      const fod = makeFod(['src'], {
        url: 'https://github.com/o/r/archive/v1.tar.gz',
        outputHashMode: 'recursive',
        fetchSubmodules: true,
      });
      const c = classifyFod(fod, 'foo', '1');
      const expr = c.buildExpr(FLAKE, '');
      expect(expr).toContain('fetchSubmodules = true');
    });

    it('classifies fetchFromGitLab (then throws because URL parsing is unsupported for gitlab)', () => {
      const fod = makeFod(['src'], {
        url: 'https://gitlab.com/owner/repo/-/archive/v1/repo-v1.tar.gz',
        outputHashMode: 'recursive',
      });
      // Classification reaches the gitlab branch; immediate construction
      // fails because GitLab archive URLs aren't reliably parseable.
      expect(() => classifyFod(fod, 'foo', '1')).toThrow(
        /Could not parse fetchFromGitLab/,
      );
    });

    it('throws when fetchPypi URL is unparseable', () => {
      const fod = makeFod(['src'], {
        url: 'https://files.pythonhosted.org/wat',
        outputHashMode: 'flat',
      });
      expect(() => classifyFod(fod, 'foo', '1')).toThrow(/parse fetchPypi/);
    });
  });

  describe('buildKnownSrcExpr', () => {
    it('inlines a known hash into the src fetcher expression', () => {
      const fod = makeFod(['src'], {
        url: 'https://example.com/x.tar.gz',
        outputHashMode: 'flat',
      });
      const known = 'sha256-KNOWNKNOWNKNOWNKNOWNKNOWNKNOWNKNOWNKNOWNKNW=';
      const expr = buildKnownSrcExpr(fod, known, FLAKE);
      expect(expr).toContain(`hash = "${known}"`);
      expect(expr).not.toContain(
        'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      );
    });
  });
});
