import { rewriteHash } from './rewrite.ts';

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
