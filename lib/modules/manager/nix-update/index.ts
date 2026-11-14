export { updateArtifacts } from './artifacts.ts';
export { extractAllPackageFiles } from './extract.ts';
export { updateDependency } from './update.ts';

export const supportedDatasources = [
  'bitbucket-tags',
  'crate',
  'custom',
  'forgejo-tags',
  'git-tags',
  'gitea-tags',
  'github-digest',
  'github-release-asset',
  'github-tags',
  'gitlab-tags',
  'pypi',
  'rubygems',
];

export const url = 'https://github.com/Mic92/nix-update';

export const defaultConfig = {
  managerFilePatterns: ['**/*.nix'],
  enabled: true,
  versioning: 'loose',
  commitMessage: '{{depName}}: {{currentVersion}} -> {{newVersion}}',
  // Digest updates (`--version=skip`, `--version=branch`) carry no newVersion,
  // so the nixpkgs-style message above would render as `<pname>: <ref> ->` for
  // every single one. Beyond being unreadable, an unchanging title is load
  // bearing: `prAlreadyExisted()` matches closed PRs on branchName + prTitle,
  // and digest updates reuse one branch name — so the second digest bump looks
  // like the first one coming back and Renovate permanently disables automerge
  // ("a matching PR was automerged previously"). Naming the digests keeps each
  // PR title unique.
  digest: {
    commitMessage: '{{depName}}: {{currentDigestShort}} -> {{newDigestShort}}',
  },
};
