import { createSign } from 'node:crypto';
import { logger } from '../../../logger/index.ts';
import { githubApi } from './common.ts';

export interface GhAppInstallation {
  id: number;
  account: { login: string; type: string };
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

export function generateJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60, // issued 60s ago to account for clock skew
      exp: now + 600, // valid for 10 minutes
      iss: appId,
    }),
  ).toString('base64url');
  const data = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(data);
  const signature = sign.sign(privateKey, 'base64url');
  return `${data}.${signature}`;
}

export async function listInstallations(
  jwt: string,
): Promise<GhAppInstallation[]> {
  logger.debug('Listing GitHub App installations');
  // The GitHub API returns a flat array for this endpoint; the HTTP client
  // concatenates pages via Link-header pagination when paginate:'all' is set
  // and the body is an array, so >100 installations are handled correctly.
  const res = await githubApi.getJsonUnchecked<GhAppInstallation[]>(
    'app/installations?per_page=100',
    {
      headers: { authorization: `Bearer ${jwt}` },
      noAuth: true,
      paginate: 'all',
    },
  );
  return res.body;
}

export async function fetchInstallationToken(
  jwt: string,
  installationId: number,
): Promise<InstallationToken> {
  logger.debug({ installationId }, 'Fetching GitHub App installation token');
  const res = await githubApi.postJson<{ token: string; expires_at: string }>(
    `app/installations/${installationId}/access_tokens`,
    {
      headers: { authorization: `Bearer ${jwt}` },
      noAuth: true,
    },
  );
  return {
    token: res.body.token,
    expiresAt: new Date(res.body.expires_at),
  };
}
