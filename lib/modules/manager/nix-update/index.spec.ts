import { getConfig } from '../../../config/defaults.ts';
import type { RenovateConfig } from '../../../config/types.ts';
import { flattenUpdates } from '../../../workers/repository/updates/flatten.ts';
import { generateBranchConfig } from '../../../workers/repository/updates/generate.ts';
import type { PackageFile } from '../types.ts';

async function titleFor(dep: any): Promise<string | undefined> {
  const config: RenovateConfig = {
    ...getConfig(),
    enabledManagers: ['nix-update'],
    semanticCommits: 'disabled',
  };
  const packageFiles = {
    'nix-update': [
      { packageFile: 'packages/foo/default.nix', deps: [dep] },
    ] as PackageFile[],
  };
  const flattened = await flattenUpdates(config, packageFiles);
  return generateBranchConfig(flattened).prTitle;
}

describe('modules/manager/nix-update/index', () => {
  it('names both digests in the title of a digest update', async () => {
    // Without the `digest` override this renders as `ghostty-tip: tip ->` for
    // every digest bump, which trips `prAlreadyExisted()` (branchName +
    // prTitle) and permanently disables automerge from the second PR on.
    const prTitle = await titleFor({
      depName: 'ghostty-tip',
      datasource: 'github-release-asset',
      currentValue: 'tip',
      currentDigest: 'sha256:13d14b6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      updates: [
        {
          updateType: 'digest',
          newValue: 'tip',
          newDigest: 'sha256:0063049bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
    });
    expect(prTitle).toBe('ghostty-tip: 13d14b6 -> 0063049');
  });

  it('keeps the nixpkgs-style title for version updates', async () => {
    const prTitle = await titleFor({
      depName: 'skhd_zig',
      datasource: 'github-tags',
      currentValue: '0.1.8',
      currentVersion: '0.1.8',
      updates: [
        { updateType: 'minor', newValue: '0.1.10', newVersion: '0.1.10' },
      ],
    });
    expect(prTitle).toBe('skhd_zig: 0.1.8 -> 0.1.10');
  });
});
