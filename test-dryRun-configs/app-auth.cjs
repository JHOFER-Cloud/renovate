// Local dry-run config for testing GitHub App auth.
// This file is gitignored — never commit secrets here.
//
// Usage:
//   nix develop --command env \
//     RENOVATE_CONFIG_FILE=test-dryRun-configs/app-auth.cjs \
//     GITHUB_APP_ID=<id> \
//     GITHUB_APP_KEY_FILE=/path/to/private-key.pem \
//     pnpm start

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');

const appId = process.env.GITHUB_APP_ID;
const keyFile = process.env.GITHUB_APP_KEY_FILE;

if (!appId) {
  throw new Error('GITHUB_APP_ID env var is required');
}
if (!keyFile) {
  throw new Error('GITHUB_APP_KEY_FILE env var is required');
}

module.exports = {
  platform: 'github',
  githubAppId: appId,
  githubAppKey: fs.readFileSync(keyFile, 'utf8'),
  autodiscover: true,
  dryRun: 'full',
  logLevel: 'debug',
};
