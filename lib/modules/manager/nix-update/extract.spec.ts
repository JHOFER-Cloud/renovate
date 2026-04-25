import { mockExecAll } from '~test/exec-util.ts';
import { fs } from '~test/util.ts';
import { datasourceFromSrc, extractAllPackageFiles } from './extract.ts';

vi.mock('../../../util/fs/index.ts');
vi.mock('../../../util/exec/index.ts');

describe('modules/manager/nix-update/extract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null if no file contains nix-update-script', async () => {
    fs.readLocalFile.mockResolvedValue('{ pname = "foo"; version = "1.0.0"; }');
    const execSnapshots = mockExecAll();

    const result = await extractAllPackageFiles({}, [
      'packages/foo/default.nix',
    ]);

    expect(result).toBeNull();
    expect(execSnapshots).toEqual([]);
  });

  it('returns null if passthru.updateScript is set but not nix-update-script', async () => {
    fs.readLocalFile.mockResolvedValue(
      'passthru.updateScript = gitUpdater {};',
    );
    const execSnapshots = mockExecAll();

    const result = await extractAllPackageFiles({}, [
      'packages/foo/default.nix',
    ]);

    expect(result).toBeNull();
    expect(execSnapshots).toEqual([]);
  });

  it('returns null if flake.nix does not exist', async () => {
    fs.readLocalFile
      .mockResolvedValueOnce('passthru.updateScript = nix-update-script {};')
      .mockResolvedValueOnce(null); // flake.nix missing
    const execSnapshots = mockExecAll();

    const result = await extractAllPackageFiles({}, [
      'packages/foo/default.nix',
    ]);

    expect(result).toBeNull();
    expect(execSnapshots).toEqual([]);
  });

  it('returns null if nix eval throws', async () => {
    fs.readLocalFile
      .mockResolvedValueOnce('passthru.updateScript = nix-update-script {};')
      .mockResolvedValueOnce('{ outputs = ...; }');

    const { exec } = await import('../../../util/exec/index.ts');
    vi.mocked(exec).mockRejectedValueOnce(new Error('nix not found'));

    const result = await extractAllPackageFiles({}, [
      'packages/foo/default.nix',
    ]);

    expect(result).toBeNull();
  });

  it('returns null if nix eval returns empty object', async () => {
    fs.readLocalFile
      .mockResolvedValueOnce('passthru.updateScript = nix-update-script {};')
      .mockResolvedValueOnce('{ outputs = ...; }');

    const { exec } = await import('../../../util/exec/index.ts');
    vi.mocked(exec).mockResolvedValueOnce({ stdout: '{}', stderr: '' });

    const result = await extractAllPackageFiles({}, [
      'packages/foo/default.nix',
    ]);

    expect(result).toBeNull();
  });

  it('returns null if all packages are skipped (no srcUrl, no srcRev)', async () => {
    fs.readLocalFile
      .mockResolvedValueOnce('passthru.updateScript = nix-update-script {};')
      .mockResolvedValueOnce('{ outputs = ...; }');

    const { exec } = await import('../../../util/exec/index.ts');
    vi.mocked(exec).mockResolvedValueOnce({
      stdout: JSON.stringify({
        opsops: {
          system: 'aarch64-darwin',
          version: null,
          pname: 'opsops',
          srcUrl: null,
          srcRev: null,
          updateScriptArgs: ['--version=branch'],
        },
      }),
      stderr: '',
    });

    const result = await extractAllPackageFiles({}, [
      'packages/opsops/default.nix',
    ]);

    expect(result).toBeNull();
  });

  it('skips packages with no version and includes those with one', async () => {
    fs.readLocalFile
      .mockResolvedValueOnce('passthru.updateScript = nix-update-script {};')
      .mockResolvedValueOnce('{ outputs = ...; }');

    const { exec } = await import('../../../util/exec/index.ts');
    vi.mocked(exec).mockResolvedValueOnce({
      stdout: JSON.stringify({
        'kubernetes-mcp-server': {
          system: 'x86_64-linux',
          version: '0.0.60',
          pname: 'kubernetes-mcp-server',
          srcUrl: 'https://github.com/punkpeye/kubernetes-mcp-server',
          srcRev: 'abc123',
          updateScriptArgs: [],
        },
        'no-version-pkg': {
          system: 'x86_64-linux',
          version: null,
          pname: 'no-version-pkg',
          srcUrl: 'https://github.com/owner/no-version-pkg',
          srcRev: 'def456',
          updateScriptArgs: [],
        },
      }),
      stderr: '',
    });

    const result = await extractAllPackageFiles({}, [
      'packages/foo/default.nix',
    ]);

    expect(result).toEqual([
      {
        packageFile: 'flake.nix',
        deps: [
          {
            depName: 'kubernetes-mcp-server',
            datasource: 'github-tags',
            packageName: 'punkpeye/kubernetes-mcp-server',
            currentValue: '0.0.60',
            versioning: 'loose',
            managerData: {
              attrName: 'kubernetes-mcp-server',
              system: 'x86_64-linux',
              updateScriptArgs: [],
              isBranchTracked: false,
            },
          },
        ],
      },
    ]);
  });

  it('skips packages with no srcUrl and includes those with one', async () => {
    fs.readLocalFile
      .mockResolvedValueOnce('passthru.updateScript = nix-update-script {};')
      .mockResolvedValueOnce('{ outputs = ...; }');

    const { exec } = await import('../../../util/exec/index.ts');
    vi.mocked(exec).mockResolvedValueOnce({
      stdout: JSON.stringify({
        'kubernetes-mcp-server': {
          system: 'x86_64-linux',
          version: '0.0.60',
          pname: 'kubernetes-mcp-server',
          srcUrl: 'https://github.com/punkpeye/kubernetes-mcp-server',
          srcRev: 'abc123',
          updateScriptArgs: [],
        },
        'no-src-pkg': {
          system: 'x86_64-linux',
          version: '1.0.0',
          pname: 'no-src-pkg',
          srcUrl: null,
          srcRev: null,
          updateScriptArgs: [],
        },
      }),
      stderr: '',
    });

    const result = await extractAllPackageFiles({}, [
      'packages/foo/default.nix',
    ]);

    expect(result?.[0].deps).toHaveLength(1);
    expect(result?.[0].deps[0].depName).toBe('kubernetes-mcp-server');
  });

  it('returns deps with real datasource and version from nix eval', async () => {
    fs.readLocalFile
      .mockResolvedValueOnce('passthru.updateScript = nix-update-script {};')
      .mockResolvedValueOnce('{ outputs = ...; }');

    const { exec } = await import('../../../util/exec/index.ts');
    vi.mocked(exec).mockResolvedValueOnce({
      stdout: JSON.stringify({
        'kubernetes-mcp-server': {
          system: 'x86_64-linux',
          version: '0.0.60',
          pname: 'kubernetes-mcp-server',
          srcUrl: 'https://github.com/punkpeye/kubernetes-mcp-server',
          srcRev: 'abc123deadbeef',
          updateScriptArgs: [],
        },
        opsops: {
          system: 'aarch64-darwin',
          version: 'unstable-2024-01-15',
          pname: 'opsops',
          srcUrl: 'https://github.com/owner/opsops',
          srcRev: 'deadbeefcafe01',
          updateScriptArgs: ['--version=branch'],
        },
      }),
      stderr: '',
    });

    const result = await extractAllPackageFiles({}, [
      'packages/foo/default.nix',
    ]);

    expect(result).toEqual([
      {
        packageFile: 'flake.nix',
        deps: [
          {
            depName: 'kubernetes-mcp-server',
            datasource: 'github-tags',
            packageName: 'punkpeye/kubernetes-mcp-server',
            currentValue: '0.0.60',
            versioning: 'loose',
            managerData: {
              attrName: 'kubernetes-mcp-server',
              system: 'x86_64-linux',
              updateScriptArgs: [],
              isBranchTracked: false,
            },
          },
          {
            depName: 'opsops',
            datasource: 'github-digest',
            packageName: 'owner/opsops',
            currentValue: 'main',
            currentDigest: 'deadbeefcafe01',
            versioning: 'exact',
            managerData: {
              attrName: 'opsops',
              system: 'aarch64-darwin',
              updateScriptArgs: ['--version=branch'],
              isBranchTracked: true,
            },
          },
        ],
      },
    ]);
  });

  it('skips branch-tracked package with no srcRev and returns null', async () => {
    fs.readLocalFile
      .mockResolvedValueOnce('passthru.updateScript = nix-update-script {};')
      .mockResolvedValueOnce('{ outputs = ...; }');

    const { exec } = await import('../../../util/exec/index.ts');
    vi.mocked(exec).mockResolvedValueOnce({
      stdout: JSON.stringify({
        opsops: {
          system: 'aarch64-darwin',
          version: 'unstable-2024-01-15',
          pname: 'opsops',
          srcUrl: 'https://github.com/owner/opsops',
          srcRev: null,
          updateScriptArgs: ['--version=branch'],
        },
      }),
      stderr: '',
    });

    const result = await extractAllPackageFiles({}, [
      'packages/opsops/default.nix',
    ]);

    expect(result).toBeNull();
  });

  it('uses explicit branch name from --version=branch:<name>', async () => {
    fs.readLocalFile
      .mockResolvedValueOnce('passthru.updateScript = nix-update-script {};')
      .mockResolvedValueOnce('{ outputs = ...; }');

    const { exec } = await import('../../../util/exec/index.ts');
    vi.mocked(exec).mockResolvedValueOnce({
      stdout: JSON.stringify({
        opsops: {
          system: 'aarch64-darwin',
          version: 'unstable-2024-01-15',
          pname: 'opsops',
          srcUrl: 'https://github.com/owner/opsops',
          srcRev: 'deadbeefcafe01',
          updateScriptArgs: ['--version=branch:develop'],
        },
      }),
      stderr: '',
    });

    const result = await extractAllPackageFiles({}, [
      'packages/opsops/default.nix',
    ]);

    expect(result?.[0].deps[0]).toMatchObject({
      currentValue: 'develop',
      currentDigest: 'deadbeefcafe01',
    });
  });

  it('defaults currentValue to main when --version=branch has no explicit name', async () => {
    fs.readLocalFile
      .mockResolvedValueOnce('passthru.updateScript = nix-update-script {};')
      .mockResolvedValueOnce('{ outputs = ...; }');

    const { exec } = await import('../../../util/exec/index.ts');
    vi.mocked(exec).mockResolvedValueOnce({
      stdout: JSON.stringify({
        opsops: {
          system: 'aarch64-darwin',
          version: null,
          pname: 'opsops',
          srcUrl: 'https://github.com/owner/opsops',
          srcRev: 'deadbeefcafe01',
          updateScriptArgs: ['--version=branch'],
        },
      }),
      stderr: '',
    });

    const result = await extractAllPackageFiles({}, [
      'packages/opsops/default.nix',
    ]);

    expect(result?.[0].deps[0]).toMatchObject({
      currentValue: 'main',
      currentDigest: 'deadbeefcafe01',
    });
  });
});

describe('modules/manager/nix-update/extract', () => {
  it('returns null for null srcUrl', () => {
    expect(datasourceFromSrc(null, 'pkg', [])).toBeNull();
  });

  describe('GitHub', () => {
    it('maps github.com to github-tags', () => {
      expect(
        datasourceFromSrc('https://github.com/owner/repo', 'pkg', []),
      ).toEqual({ datasource: 'github-tags', packageName: 'owner/repo' });
    });

    it('strips .git suffix', () => {
      expect(
        datasourceFromSrc('https://github.com/owner/repo.git', 'pkg', []),
      ).toEqual({ datasource: 'github-tags', packageName: 'owner/repo' });
    });

    it('handles archive URLs', () => {
      expect(
        datasourceFromSrc(
          'https://github.com/owner/repo/archive/v1.0.0.tar.gz',
          'pkg',
          [],
        ),
      ).toEqual({ datasource: 'github-tags', packageName: 'owner/repo' });
    });

    it('maps github.com with --version=branch to github-digest', () => {
      expect(
        datasourceFromSrc('https://github.com/owner/repo', 'pkg', [
          '--version=branch',
        ]),
      ).toEqual({ datasource: 'github-digest', packageName: 'owner/repo' });
    });
  });

  describe('GitLab', () => {
    it('maps gitlab.com to gitlab-tags', () => {
      expect(
        datasourceFromSrc('https://gitlab.com/owner/repo', 'pkg', []),
      ).toEqual({ datasource: 'gitlab-tags', packageName: 'owner/repo' });
    });

    it('strips .git suffix', () => {
      expect(
        datasourceFromSrc('https://gitlab.com/owner/repo.git', 'pkg', []),
      ).toEqual({ datasource: 'gitlab-tags', packageName: 'owner/repo' });
    });

    it('uses gitlab-tags even with --version=branch', () => {
      expect(
        datasourceFromSrc('https://gitlab.com/owner/repo', 'pkg', [
          '--version=branch',
        ]),
      ).toEqual({ datasource: 'gitlab-tags', packageName: 'owner/repo' });
    });
  });

  describe('Bitbucket', () => {
    it('maps bitbucket.org to bitbucket-tags', () => {
      expect(
        datasourceFromSrc('https://bitbucket.org/owner/repo', 'pkg', []),
      ).toEqual({ datasource: 'bitbucket-tags', packageName: 'owner/repo' });
    });

    it('strips .git suffix', () => {
      expect(
        datasourceFromSrc('https://bitbucket.org/owner/repo.git', 'pkg', []),
      ).toEqual({ datasource: 'bitbucket-tags', packageName: 'owner/repo' });
    });
  });

  describe('Codeberg', () => {
    it('maps codeberg.org to forgejo-tags', () => {
      expect(
        datasourceFromSrc('https://codeberg.org/owner/repo', 'pkg', []),
      ).toEqual({ datasource: 'forgejo-tags', packageName: 'owner/repo' });
    });

    it('strips .git suffix', () => {
      expect(
        datasourceFromSrc('https://codeberg.org/owner/repo.git', 'pkg', []),
      ).toEqual({ datasource: 'forgejo-tags', packageName: 'owner/repo' });
    });
  });

  describe('Gitea', () => {
    it('maps gitea.com to gitea-tags', () => {
      expect(
        datasourceFromSrc('https://gitea.com/owner/repo', 'pkg', []),
      ).toEqual({ datasource: 'gitea-tags', packageName: 'owner/repo' });
    });
  });

  describe('SourceHut', () => {
    it('maps git.sr.ht to git-tags with full URL as packageName', () => {
      expect(
        datasourceFromSrc('https://git.sr.ht/~user/repo', 'pkg', []),
      ).toEqual({
        datasource: 'git-tags',
        packageName: 'https://git.sr.ht/~user/repo',
      });
    });

    it('handles archive URLs for SourceHut', () => {
      expect(
        datasourceFromSrc(
          'https://git.sr.ht/~user/repo/archive/1.0.0.tar.gz',
          'pkg',
          [],
        ),
      ).toEqual({
        datasource: 'git-tags',
        packageName: 'https://git.sr.ht/~user/repo',
      });
    });
  });

  describe('Savannah', () => {
    it('maps savannah.gnu.org to git-tags', () => {
      expect(
        datasourceFromSrc(
          'https://savannah.gnu.org/git/mypkg/archive/1.0.0.tar.gz',
          'pkg',
          [],
        ),
      ).toEqual({
        datasource: 'git-tags',
        packageName: 'https://savannah.gnu.org/git/mypkg',
      });
    });

    it('maps savannah.nongnu.org to git-tags', () => {
      expect(
        datasourceFromSrc(
          'https://savannah.nongnu.org/git/mypkg/archive/1.0.0.tar.gz',
          'pkg',
          [],
        ),
      ).toEqual({
        datasource: 'git-tags',
        packageName: 'https://savannah.nongnu.org/git/mypkg',
      });
    });
  });

  describe('crates.io', () => {
    it('maps crates.io URL to crate datasource with pname', () => {
      expect(
        datasourceFromSrc(
          'https://static.crates.io/crates/ripgrep/ripgrep-14.0.0.crate',
          'ripgrep',
          [],
        ),
      ).toEqual({ datasource: 'crate', packageName: 'ripgrep' });
    });

    it('uses empty string packageName when pname is null', () => {
      expect(
        datasourceFromSrc(
          'https://static.crates.io/crates/ripgrep/ripgrep-14.0.0.crate',
          null,
          [],
        ),
      ).toEqual({ datasource: 'crate', packageName: '' });
    });
  });

  describe('PyPI', () => {
    it('maps mirror://pypi/ to pypi datasource', () => {
      expect(
        datasourceFromSrc(
          'mirror://pypi/r/requests/requests-2.31.0.tar.gz',
          'requests',
          [],
        ),
      ).toEqual({ datasource: 'pypi', packageName: 'requests' });
    });

    it('maps files.pythonhosted.org to pypi datasource', () => {
      expect(
        datasourceFromSrc(
          'https://files.pythonhosted.org/packages/requests-2.31.0.tar.gz',
          'requests',
          [],
        ),
      ).toEqual({ datasource: 'pypi', packageName: 'requests' });
    });

    it('maps pypi.io to pypi datasource', () => {
      expect(
        datasourceFromSrc(
          'https://pypi.io/packages/source/r/requests/requests-2.31.0.tar.gz',
          'requests',
          [],
        ),
      ).toEqual({ datasource: 'pypi', packageName: 'requests' });
    });
  });

  describe('RubyGems', () => {
    it('maps rubygems.org to rubygems datasource', () => {
      expect(
        datasourceFromSrc(
          'https://rubygems.org/gems/rails-7.0.0.gem',
          'rails',
          [],
        ),
      ).toEqual({ datasource: 'rubygems', packageName: 'rails' });
    });
  });

  describe('generic git fallback', () => {
    it('maps unknown HTTPS host to git-tags using base URL', () => {
      expect(
        datasourceFromSrc(
          'https://git.example.com/owner/repo/archive/v1.0.0.tar.gz',
          'pkg',
          [],
        ),
      ).toEqual({
        datasource: 'git-tags',
        packageName: 'https://git.example.com/owner/repo',
      });
    });

    it('strips .git suffix from generic URLs', () => {
      expect(
        datasourceFromSrc('https://git.example.com/owner/repo.git', 'pkg', []),
      ).toEqual({
        datasource: 'git-tags',
        packageName: 'https://git.example.com/owner/repo',
      });
    });

    it('returns null for URLs with no owner/repo path', () => {
      expect(
        datasourceFromSrc('https://example.com/tarball.tar.gz', 'pkg', []),
      ).toBeNull();
    });
  });
});
