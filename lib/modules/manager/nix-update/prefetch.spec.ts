import { mockExecSequence } from '~test/exec-util.ts';
import { env } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import {
  _resetPrefetchCacheForTesting,
  parseHashFromStderr,
  prefetch,
} from './prefetch.ts';

vi.mock('../../../util/exec/env.ts');

describe('modules/manager/nix-update/prefetch', () => {
  beforeEach(() => {
    env.getChildProcessEnv.mockReturnValue({});
    GlobalConfig.set({
      localDir: '/tmp/repo',
      cacheDir: '/tmp/cache',
      containerbaseDir: '/tmp/cache/containerbase',
    });
    _resetPrefetchCacheForTesting();
  });

  function makeMismatchError(stderr: string): Error {
    const err = new Error('nix-build failed (expected)') as Error & {
      stderr?: string;
    };
    err.stderr = stderr;
    return err;
  }

  describe('parseHashFromStderr', () => {
    it('extracts SRI sha256 from "got:" line', async () => {
      const stderr = `
        error: hash mismatch in fixed-output derivation '/nix/store/xxx-foo':
          specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
          got:       sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
      `;
      const out = await parseHashFromStderr(stderr, 'sha256');
      expect(out).toBe('sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    });

    it('extracts SRI sha512 when algo is sha512', async () => {
      const stderr =
        '  got:    sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
      const out = await parseHashFromStderr(stderr, 'sha512');
      expect(out.startsWith('sha512-')).toBe(true);
    });

    it('throws on algorithm mismatch (expected sha256, got sha512)', async () => {
      const stderr =
        '  got:    sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
      await expect(parseHashFromStderr(stderr, 'sha256')).rejects.toThrow(
        /algorithm mismatch/i,
      );
    });

    it('converts legacy base32 to SRI via nix hash to-sri', async () => {
      mockExecSequence([
        {
          stdout: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n',
          stderr: '',
        },
      ]);
      const stderr =
        'error: hash mismatch...\n  got: 0qcrxsswbjjy0nbk7gpqkdyy0pgvvqlpgnsywqnnbg47cyx9p7vk';
      const out = await parseHashFromStderr(stderr, 'sha256');
      expect(out).toBe('sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    });

    it('throws when stderr has no "got:" line', async () => {
      await expect(
        parseHashFromStderr('something else broke', 'sha256'),
      ).rejects.toThrow(/Could not extract hash/);
    });

    it('truncates very long stderr but keeps the tail (real error at the end)', async () => {
      const longStderr =
        'x'.repeat(5000) + '\nactual error: the thing that actually broke';
      await expect(parseHashFromStderr(longStderr, 'sha256')).rejects.toThrow(
        /more chars truncated/,
      );
      await expect(parseHashFromStderr(longStderr, 'sha256')).rejects.toThrow(
        /actual error: the thing that actually broke/,
      );
    });

    it('throws when nix hash to-sri returns malformed output', async () => {
      mockExecSequence([{ stdout: 'not-a-real-sri\n', stderr: '' }]);
      const stderr =
        'got: 0qcrxsswbjjy0nbk7gpqkdyy0pgvvqlpgnsywqnnbg47cyx9p7vk';
      await expect(parseHashFromStderr(stderr, 'sha256')).rejects.toThrow(
        /unexpected output/,
      );
    });
  });

  describe('prefetch', () => {
    it('parses hash from a hash-mismatch failure', async () => {
      const stderr = `
        error: hash mismatch in fixed-output derivation:
          got:    sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
      `;
      mockExecSequence([makeMismatchError(stderr)]);
      const out = await prefetch({
        expr: 'runnerPkgs.fetchurl { url = "x"; hash = ""; }',
        pkgSystem: 'x86_64-darwin',
        algo: 'sha256',
      });
      expect(out).toBe('sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    });

    it('throws when nix-build unexpectedly succeeds', async () => {
      mockExecSequence([{ stdout: '', stderr: '' }]);
      await expect(
        prefetch({
          expr: 'runnerPkgs.fetchurl { url = "x"; hash = ""; }',
          pkgSystem: 'x86_64-darwin',
          algo: 'sha256',
        }),
      ).rejects.toThrow(/unexpectedly succeeded/);
    });

    it('passes --eval-system and the expression to nix-build', async () => {
      const stderr =
        '  got: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      const snapshots = mockExecSequence([makeMismatchError(stderr)]);
      await prefetch({
        expr: 'runnerPkgs.fetchurl\n  { url = "x"; hash = ""; }',
        pkgSystem: 'x86_64-darwin',
        algo: 'sha256',
      });
      const cmd = snapshots[0].cmd;
      expect(cmd).toContain('nix build');
      expect(cmd).toContain('--eval-system x86_64-darwin');
      expect(cmd).toContain('--no-link');
      expect(cmd).toContain('--impure');
      // Multiline expr should have been collapsed.
      expect(cmd).not.toContain('\n');
    });

    it('rethrows when the inner error has no stderr', async () => {
      const err = new Error('exec died');
      mockExecSequence([err]);
      await expect(
        prefetch({
          expr: 'x',
          pkgSystem: 'x86_64-linux',
          algo: 'sha256',
        }),
      ).rejects.toThrow(/exec died/);
    });

    it('caches resolved hashes — second call with same expr does not exec again', async () => {
      const stderr =
        '  got: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      const snapshots = mockExecSequence([makeMismatchError(stderr)]);
      const opts = {
        expr: 'runnerPkgs.fetchurl { url = "x"; hash = ""; }',
        pkgSystem: 'x86_64-darwin' as const,
        algo: 'sha256' as const,
      };
      const a = await prefetch(opts);
      const b = await prefetch(opts);
      expect(a).toBe(b);
      // Only ONE exec call despite two prefetch invocations.
      expect(snapshots).toHaveLength(1);
    });

    it('different flakeLockFingerprint invalidates cache', async () => {
      const stderr =
        '  got: sha256-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=';
      const snapshots = mockExecSequence([
        makeMismatchError(stderr),
        makeMismatchError(stderr),
      ]);
      const baseOpts = {
        expr: 'runnerPkgs.fetchurl { url = "z"; hash = ""; }',
        pkgSystem: 'x86_64-linux' as const,
        algo: 'sha256' as const,
      };
      await prefetch({ ...baseOpts, flakeLockFingerprint: 'lock-rev-A' });
      await prefetch({ ...baseOpts, flakeLockFingerprint: 'lock-rev-B' });
      // Two different fingerprints → no cache reuse → two execs.
      expect(snapshots).toHaveLength(2);
    });

    it('does not cache failures — retries on next call', async () => {
      const stderr =
        '  got: sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=';
      const snapshots = mockExecSequence([
        new Error('first attempt died'),
        makeMismatchError(stderr),
      ]);
      const opts = {
        expr: 'runnerPkgs.fetchurl { url = "y"; hash = ""; }',
        pkgSystem: 'x86_64-linux' as const,
        algo: 'sha256' as const,
      };
      await expect(prefetch(opts)).rejects.toThrow(/first attempt died/);
      const ok = await prefetch(opts);
      expect(ok).toBe('sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=');
      expect(snapshots).toHaveLength(2);
    });
  });
});
