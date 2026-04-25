import { updateDependency } from './update.ts';

describe('modules/manager/nix-update/update', () => {
  it('returns file content unchanged', () => {
    const fileContent = 'some nix file content\nwith multiple lines\n';
    const result = updateDependency({
      fileContent,
      packageFile: 'flake.nix',
      upgrade: { depName: 'foo', currentValue: '0', newValue: '1' },
    });
    expect(result).toBe(fileContent);
  });

  it('returns empty string unchanged', () => {
    const result = updateDependency({
      fileContent: '',
      packageFile: 'flake.nix',
      upgrade: { depName: 'foo' },
    });
    expect(result).toBe('');
  });
});
