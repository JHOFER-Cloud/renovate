import {
  rewriteHash,
  rewriteRev,
  rewriteUnstableDate,
  rewriteUrl,
} from './rewrite.ts';

describe('modules/manager/nix-update/rewrite', () => {
  const oldHash = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const newHash = 'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';

  it('replaces a single src hash via fast-path literal swap', () => {
    const content = `
      {
        src = fetchurl {
          url = "https://example.com/foo.tar.gz";
          hash = "${oldHash}";
        };
      }
    `;
    const out = rewriteHash(content, {
      attrPath: ['src'],
      oldHash,
      newHash,
    });
    expect(out).toContain(`hash = "${newHash}"`);
    expect(out).not.toContain(oldHash);
  });

  it('rewrites the right hash when src and goModules both have hashes (different values)', () => {
    const goOldHash = 'sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=';
    const content = `
      buildGoModule {
        pname = "x"; version = "1";
        src = fetchurl { url = "..."; hash = "${oldHash}"; };
        vendorHash = "${goOldHash}";
      }
    `;
    // Rewrite goModules' hash, leaving src alone.
    const out = rewriteHash(content, {
      attrPath: ['vendorHash'],
      oldHash: goOldHash,
      newHash,
    });
    expect(out).toContain(oldHash);
    expect(out).toContain(`vendorHash = "${newHash}"`);
    expect(out).not.toContain(goOldHash);
  });

  it('falls back to single-literal replacement when only one hash exists', () => {
    const content = `{ src = fetchurl { hash = "${oldHash}"; }; }`;
    // Different attrPath than the binding name, so contextual lookup fails;
    // single-literal fallback should still succeed.
    const out = rewriteHash(content, {
      attrPath: ['unknownAttr'],
      oldHash: null,
      newHash,
    });
    expect(out).toContain(`"${newHash}"`);
  });

  it('replaces lib.fakeHash placeholder when only one occurs', () => {
    const content = `
      buildGoModule {
        src = ./.;
        vendorHash = lib.fakeHash;
      }
    `;
    const out = rewriteHash(content, {
      attrPath: ['vendorHash'],
      oldHash: null,
      newHash,
    });
    expect(out).toContain(`vendorHash = "${newHash}";`);
    expect(out).not.toContain('lib.fakeHash');
  });

  it('throws when neither contextual nor literal lookup finds the hash', () => {
    const content = `{ unrelated = "no hash here"; }`;
    expect(() =>
      rewriteHash(content, {
        attrPath: ['src'],
        oldHash: 'sha256-some-old-hash=',
        newHash,
      }),
    ).toThrow(/Could not locate hash/);
  });

  it('uses contextual lookup when multiple hashes share oldHash value', () => {
    // Two FODs with the same starting hash (rare but possible during init).
    const content = `
      {
        src = fetchurl { hash = "${oldHash}"; };
        npmDeps = fetchNpmDeps { hash = "${oldHash}"; };
      }
    `;
    // Without unique-literal fast path, contextual lookup must pick npmDeps.
    const out = rewriteHash(content, {
      attrPath: ['npmDeps'],
      oldHash,
      newHash,
    });
    // npmDeps is now newHash, src is still oldHash
    expect(out).toMatch(/src\s*=\s*fetchurl\s*\{\s*hash\s*=\s*"sha256-A/);
    expect(out).toMatch(
      /npmDeps\s*=\s*fetchNpmDeps\s*\{\s*hash\s*=\s*"sha256-B/,
    );
  });

  it('preserves sha512 algorithm in contextual rewrite', () => {
    const sha512Old =
      'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
    const sha512New =
      'sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==';
    const content = `{ src = fetchurl { hash = "${sha512Old}"; }; }`;
    const out = rewriteHash(content, {
      attrPath: ['src'],
      oldHash: sha512Old,
      newHash: sha512New,
    });
    expect(out).toContain(sha512New);
  });

  it('throws on empty attrPath', () => {
    expect(() =>
      rewriteHash('{}', { attrPath: [], oldHash: null, newHash }),
    ).toThrow(/empty attrPath/);
  });

  it('handles indented strings without confusion', () => {
    // ''...'' is nix's indented-string syntax. The walker must not exit the
    // src binding's scope on the apostrophes inside the indented string.
    const content = `
      {
        src = fetchurl {
          url = "https://example.com/foo.tar.gz";
          hash = "${oldHash}";
          curlOptsList = ''-A "test"'';
        };
      }
    `;
    const out = rewriteHash(content, {
      attrPath: ['src'],
      oldHash,
      newHash,
    });
    expect(out).toContain(newHash);
  });

  it('walker traverses indented strings when contextual path is needed', () => {
    // Same hash appears in two FODs → forces contextual lookup, which
    // exercises the brace-walker including its indent-string-aware logic.
    const content = `
      {
        src = fetchurl {
          url = "https://example.com/foo.tar.gz";
          extraConfig = ''
            some text with ; and { } chars
          '';
          hash = "${oldHash}";
        };
        npmDeps = fetchNpmDeps {
          hash = "${oldHash}";
        };
      }
    `;
    const out = rewriteHash(content, {
      attrPath: ['src'],
      oldHash,
      newHash,
    });
    expect(out).toContain(newHash);
    // The src binding's hash got rewritten; npmDeps' hash is still oldHash
    expect(out.match(new RegExp(oldHash, 'g'))?.length).toBe(1);
  });

  it('walker handles escaped quotes inside strings', () => {
    const content = `
      {
        src = fetchurl {
          description = "say \\"hi\\"; more";
          hash = "${oldHash}";
        };
        vendorHash = "${oldHash}";
      }
    `;
    const out = rewriteHash(content, {
      attrPath: ['src'],
      oldHash,
      newHash,
    });
    expect(out).toContain(newHash);
    // vendorHash retains old (different binding context)
    expect(out.match(new RegExp(oldHash, 'g'))?.length).toBe(1);
  });

  it('walker treats triple-apostrophe as escape inside indent string', () => {
    const content = `
      {
        src = fetchurl {
          extraConfig = '' '''escaped''' '';
          hash = "${oldHash}";
        };
        vendorHash = "${oldHash}";
      }
    `;
    const out = rewriteHash(content, {
      attrPath: ['src'],
      oldHash,
      newHash,
    });
    expect(out).toContain(newHash);
    expect(out.match(new RegExp(oldHash, 'g'))?.length).toBe(1);
  });

  it('walker returns null when binding has no terminating semicolon (depth never closes)', () => {
    // Same hash twice + missing closing brace → walker hits EOF, returns null
    // → falls back to single-literal path. With duplicates, fallback also fails
    // → throws.
    const content = `{ src = fetchurl { hash = "${oldHash}"; vendorHash = "${oldHash}";`;
    expect(() =>
      rewriteHash(content, { attrPath: ['src'], oldHash, newHash }),
    ).toThrow(/Could not locate hash/);
  });

  it('returns null from locator when binding has no terminating semicolon', () => {
    // Walker hits end of file without finding `;` at depth 0 → fallback paths
    const otherHash = 'sha256-WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW=';
    const content = `{ src = "${oldHash}"; vendorHash = "${otherHash}"`;
    // attrPath src binding has `;`, vendorHash binding doesn't.
    expect(
      () =>
        rewriteHash(content, {
          attrPath: ['vendorHash'],
          oldHash: otherHash,
          newHash,
        }),
      // fast path will swap (otherHash is unique) — should succeed
    ).not.toThrow();
  });
});

describe('modules/manager/nix-update/rewrite', () => {
  const oldUrl =
    'https://x-r2.raycast-releases.com/Raycast_Beta_0.61.0.0_aaa_arm64.dmg';
  const newUrl =
    'https://x-r2.raycast-releases.com/Raycast_Beta_0.62.0.0_bbb_arm64.dmg';

  it('fast-path: replaces the literal when oldUrl is unique', () => {
    const content = `
      {
        src = fetchurl {
          url = "${oldUrl}";
          hash = "sha256-aaa=";
        };
      }
    `;
    const out = rewriteUrl(content, { attrPath: ['src'], oldUrl, newUrl });
    expect(out).toContain(newUrl);
    expect(out).not.toContain(oldUrl);
  });

  it('contextual: rewrites url inside the src block when same URL appears twice', () => {
    // Same URL appears twice (in src and in a comment) — fast-path bails,
    // contextual locator anchors on `src` and rewrites only the binding's url line.
    const content = `
      {
        # historical: ${oldUrl}
        src = fetchurl {
          url = "${oldUrl}";
          hash = "sha256-aaa=";
        };
      }
    `;
    const out = rewriteUrl(content, { attrPath: ['src'], oldUrl, newUrl });
    // Comment-side reference must survive; only src's url is bumped.
    expect(out).toContain(`# historical: ${oldUrl}`);
    expect(out).toContain(`url = "${newUrl}"`);
  });

  it('contextual: replaces only the binding matching oldUrl when range has multiple url attrs', () => {
    // Two url attrs inside the src range — only the one whose value is
    // exactly oldUrl may be rewritten; the unrelated one must survive.
    const content = `
      {
        # historical: ${oldUrl}
        src = fetchzip {
          passthru = { url = "https://example.com/homepage"; };
          url = "${oldUrl}";
          hash = "sha256-aaa=";
        };
      }
    `;
    const out = rewriteUrl(content, { attrPath: ['src'], oldUrl, newUrl });
    expect(out).toContain(`url = "https://example.com/homepage"`);
    expect(out).toContain(`url = "${newUrl}"`);
    expect(out).toContain(`# historical: ${oldUrl}`);
  });

  it('contextual: falls back to the first url attr when the value is interpolated', () => {
    // Interpolated url never literally matches the eval-resolved oldUrl —
    // the first url binding in the range is rewritten to the new literal.
    const content = `
      {
        src = fetchurl {
          url = "https://x-r2.raycast-releases.com/Raycast_Beta_\${version}_arm64.dmg";
          hash = "sha256-aaa=";
        };
      }
    `;
    const out = rewriteUrl(content, { attrPath: ['src'], oldUrl, newUrl });
    expect(out).toContain(`url = "${newUrl}"`);
    expect(out).not.toContain('Raycast_Beta_${version}_arm64.dmg');
  });

  it('is a no-op when oldUrl equals newUrl', () => {
    const content = `src = fetchurl { url = "${oldUrl}"; };`;
    expect(
      rewriteUrl(content, { attrPath: ['src'], oldUrl, newUrl: oldUrl }),
    ).toBe(content);
  });

  it('throws on empty attrPath', () => {
    expect(() => rewriteUrl('x', { attrPath: [], oldUrl, newUrl })).toThrow(
      /empty attrPath/,
    );
  });

  it('throws when no matching url binding can be found', () => {
    const content = `{ other = "x"; }`;
    expect(() =>
      rewriteUrl(content, { attrPath: ['src'], oldUrl, newUrl }),
    ).toThrow(/Could not locate url/);
  });
});

describe('modules/manager/nix-update/rewrite', () => {
  const oldRev = 'fc3db8757558956e8fe1496cff3e6a9a1b1748ac';
  const newRev = '976c3107f6ed9859149bdc130e3f8928f2ab6852';

  it('fast-path: replaces the literal when oldRev is unique', () => {
    const content = `
      {
        src = fetchFromGitHub {
          owner = "acsandmann";
          repo = "aerospace-swipe";
          hash = "sha256-aaa=";
          rev = "${oldRev}";
        };
      }
    `;
    const out = rewriteRev(content, { attrPath: ['src'], oldRev, newRev });
    expect(out).toContain(`rev = "${newRev}"`);
    expect(out).not.toContain(oldRev);
  });

  it('rewrites a rev bound in a let block and pulled in via `inherit rev`', () => {
    // The prlsp shape: the binding sits outside the src block, so the
    // contextual scan anchored on `src` would never see it — the fast path
    // is what makes this work.
    const content = `
      let
        rev = "${oldRev}";
        src = fetchFromGitHub {
          owner = "toziegler";
          repo = "prlsp";
          inherit rev;
          hash = "sha256-aaa=";
        };
      in { }
    `;
    const out = rewriteRev(content, { attrPath: ['src'], oldRev, newRev });
    expect(out).toContain(`rev = "${newRev}"`);
    expect(out).not.toContain(oldRev);
  });

  it('contextual: rewrites rev inside the src block when the sha appears twice', () => {
    const content = `
      {
        # pinned at ${oldRev}
        src = fetchgit {
          url = "https://example.com/x.git";
          rev = "${oldRev}";
          hash = "sha256-aaa=";
        };
      }
    `;
    const out = rewriteRev(content, { attrPath: ['src'], oldRev, newRev });
    expect(out).toContain(`rev = "${newRev}"`);
    // the comment mention is left alone
    expect(out).toContain(`# pinned at ${oldRev}`);
  });

  it('contextual: falls back to the first rev binding for an interpolated rev', () => {
    const content = `
      {
        src = fetchFromGitHub {
          rev = "v\${version}";
          hash = "sha256-aaa=";
        };
      }
    `;
    const out = rewriteRev(content, { attrPath: ['src'], oldRev, newRev });
    expect(out).toContain(`rev = "${newRev}"`);
  });

  it('is a no-op when oldRev equals newRev', () => {
    const content = `src = fetchgit { rev = "${oldRev}"; };`;
    expect(
      rewriteRev(content, { attrPath: ['src'], oldRev, newRev: oldRev }),
    ).toBe(content);
  });

  it('throws on empty attrPath', () => {
    expect(() => rewriteRev('x', { attrPath: [], oldRev, newRev })).toThrow(
      /empty attrPath/,
    );
  });

  it('throws when no matching rev binding can be found', () => {
    const content = `{ other = "x"; }`;
    expect(() =>
      rewriteRev(content, { attrPath: ['src'], oldRev, newRev }),
    ).toThrow(/Could not locate rev/);
  });
});

describe('modules/manager/nix-update/rewrite', () => {
  it('bumps the date in an unstable version string', () => {
    const content = `
      {
        pname = "aerospace-swipe";
        version = "0-unstable-2025-11-17";
      }
    `;
    const out = rewriteUnstableDate(content, '2026-06-30');
    expect(out).toContain('version = "0-unstable-2026-06-30"');
    expect(out).not.toContain('2025-11-17');
  });

  it('bumps the date when the version has a numeric base', () => {
    const content = `version = "0.1.0-unstable-2026-03-09";`;
    const out = rewriteUnstableDate(content, '2026-08-01');
    expect(out).toBe(`version = "0.1.0-unstable-2026-08-01";`);
  });

  it('is a no-op when the date already matches', () => {
    const content = `version = "0-unstable-2026-06-30";`;
    expect(rewriteUnstableDate(content, '2026-06-30')).toBe(content);
  });

  it('is a no-op when there is no unstable version string', () => {
    const content = `version = "1.2.3";`;
    expect(rewriteUnstableDate(content, '2026-06-30')).toBe(content);
  });
});
