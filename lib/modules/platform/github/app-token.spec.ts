import { createSign } from 'node:crypto';
import * as httpMock from '~test/http-mock.ts';
import {
  fetchInstallationToken,
  generateJWT,
  listInstallations,
} from './app-token.ts';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, createSign: vi.fn() };
});

const githubApiHost = 'https://api.github.com';

describe('modules/platform/github/app-token', () => {
  describe('generateJWT()', () => {
    it('generates a valid RS256 JWT structure', () => {
      const mockSigner = {
        update: vi.fn().mockReturnThis(),
        sign: vi.fn().mockReturnValue('mock-signature'),
      };
      vi.mocked(createSign).mockReturnValue(mockSigner as any);

      const jwt = generateJWT('12345', 'fake-pem-key');
      const parts = jwt.split('.');
      expect(parts).toHaveLength(3);

      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      expect(payload.iss).toBe('12345');
      // exp = iat + 660 (iat is now-60, exp is now+600, so diff is 660)
      expect(payload.exp - payload.iat).toBe(660);

      expect(parts[2]).toBe('mock-signature');
      expect(createSign).toHaveBeenCalledWith('RSA-SHA256');
      expect(mockSigner.update).toHaveBeenCalledWith(`${parts[0]}.${parts[1]}`);
      expect(mockSigner.sign).toHaveBeenCalledWith('fake-pem-key', 'base64url');
    });
  });

  describe('listInstallations()', () => {
    it('returns list of installations', async () => {
      httpMock
        .scope(githubApiHost, {
          reqheaders: { authorization: 'Bearer test-jwt' },
        })
        .get('/app/installations?per_page=100')
        .reply(200, [
          { id: 1, account: { login: 'org1', type: 'Organization' } },
          { id: 2, account: { login: 'org2', type: 'Organization' } },
        ]);

      const result = await listInstallations('test-jwt');

      expect(result).toEqual([
        { id: 1, account: { login: 'org1', type: 'Organization' } },
        { id: 2, account: { login: 'org2', type: 'Organization' } },
      ]);
    });

    it('returns empty array when no installations', async () => {
      httpMock
        .scope(githubApiHost, {
          reqheaders: { authorization: 'Bearer test-jwt' },
        })
        .get('/app/installations?per_page=100')
        .reply(200, []);

      const result = await listInstallations('test-jwt');
      expect(result).toEqual([]);
    });
  });

  describe('fetchInstallationToken()', () => {
    it('returns token and parsed expiresAt', async () => {
      const expiresAt = '2024-06-01T12:00:00Z';
      httpMock
        .scope(githubApiHost, {
          reqheaders: { authorization: 'Bearer test-jwt' },
        })
        .post('/app/installations/42/access_tokens')
        .reply(201, { token: 'ghs_testtoken', expires_at: expiresAt });

      const result = await fetchInstallationToken('test-jwt', 42);

      expect(result.token).toBe('ghs_testtoken');
      expect(result.expiresAt).toEqual(new Date(expiresAt));
    });

    it('handles API errors', async () => {
      httpMock
        .scope(githubApiHost, {
          reqheaders: { authorization: 'Bearer test-jwt' },
        })
        .post('/app/installations/99/access_tokens')
        .reply(404, { message: 'Not Found' });

      await expect(fetchInstallationToken('test-jwt', 99)).rejects.toThrow();
    });
  });
});
