export { updateArtifacts } from './artifacts.ts';
export { extractAllPackageFiles } from './extract.ts';
export { updateDependency } from './update.ts';

export const supportedDatasources = [
  'bitbucket-tags',
  'crate',
  'forgejo-tags',
  'git-tags',
  'gitea-tags',
  'github-digest',
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
};
