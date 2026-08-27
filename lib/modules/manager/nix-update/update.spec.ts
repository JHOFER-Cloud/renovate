import { updateDependency } from './update.ts';

describe('modules/manager/nix-update/update', () => {
  it('bumps `version = "X"` to the new value', () => {
    const fileContent = `
      buildGoModule rec {
        pname = "foo";
        version = "0.0.60";
        src = fetchFromGitHub { rev = "v\${version}"; hash = "..."; };
      }
    `;
    const result = updateDependency({
      fileContent,
      packageFile: 'packages/foo/default.nix',
      upgrade: {
        depName: 'foo',
        currentValue: '0.0.60',
        newValue: '0.0.61',
      },
    });
    expect(result).toContain('version = "0.0.61";');
    expect(result).not.toContain('version = "0.0.60";');
  });

  it('falls back to newVersion when newValue is missing', () => {
    const result = updateDependency({
      fileContent: 'version = "1.0";\n',
      packageFile: 'packages/foo/default.nix',
      upgrade: {
        depName: 'foo',
        currentValue: '1.0',
        newVersion: '1.1',
      },
    });
    expect(result).toBe('version = "1.1";\n');
  });

  it('returns content unchanged when currentValue equals newValue (branch-tracked)', () => {
    const fileContent = 'version = "0-unstable-2025-11-17";\n';
    const result = updateDependency({
      fileContent,
      packageFile: 'packages/foo/default.nix',
      upgrade: {
        depName: 'foo',
        currentValue: 'main',
        newValue: 'main',
        currentDigest: 'oldsha',
        newDigest: 'newsha',
      },
    });
    expect(result).toBe(fileContent);
  });

  it('returns content unchanged when neither newValue nor newVersion is set', () => {
    const fileContent = 'version = "1.0";\n';
    const result = updateDependency({
      fileContent,
      packageFile: 'packages/foo/default.nix',
      upgrade: { depName: 'foo', currentValue: '1.0' },
    });
    expect(result).toBe(fileContent);
  });

  it('returns content unchanged when version line is not present (already-bumped branch)', () => {
    // Re-run scenario: branch already has version="0.0.61", currentValue from
    // extract is still "0.0.60". We don't try to be clever, just no-op.
    const fileContent = 'version = "0.0.61";\n';
    const result = updateDependency({
      fileContent,
      packageFile: 'packages/foo/default.nix',
      upgrade: {
        depName: 'foo',
        currentValue: '0.0.60',
        newValue: '0.0.61',
      },
    });
    expect(result).toBe(fileContent);
  });

  it('does not match `vendorVersion` or other *Version attrs', () => {
    const fileContent = `
      version = "1.0";
      vendorVersion = "1.0";
    `;
    const result = updateDependency({
      fileContent,
      packageFile: 'packages/foo/default.nix',
      upgrade: { depName: 'foo', currentValue: '1.0', newValue: '1.1' },
    });
    expect(result).toContain('version = "1.1";');
    expect(result).toContain('vendorVersion = "1.0";');
  });

  it('handles multi-whitespace version assignment', () => {
    const fileContent = 'version    =   "0.0.60" ;\n';
    const result = updateDependency({
      fileContent,
      packageFile: 'packages/foo/default.nix',
      upgrade: { depName: 'foo', currentValue: '0.0.60', newValue: '0.0.61' },
    });
    expect(result).toContain('"0.0.61"');
  });

  it('returns empty string unchanged', () => {
    const result = updateDependency({
      fileContent: '',
      packageFile: 'packages/foo/default.nix',
      upgrade: { depName: 'foo', currentValue: '1.0', newValue: '1.1' },
    });
    expect(result).toBe('');
  });
});
