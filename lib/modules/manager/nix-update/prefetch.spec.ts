import { mockExecSequence } from '~test/exec-util.ts';
import { env } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import { logger } from '../../../logger/index.ts';
import {
  _resetPrefetchCacheForTesting,
  assertSubstitutableStore,
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

    it('reports a failed builder as a build failure, not a parse failure', async () => {
      const stderr = [
        "building '/nix/store/xxx-foo-go-modules.drv'...",
        "error: Cannot build '/nix/store/xxx-foo-go-modules.drv'.",
        '       Reason: builder failed with exit code 1.',
        '       Last 8 log lines:',
        '       > go: go.mod requires go >= 1.27.0 (running go 1.26.7; GOTOOLCHAIN=local)',
      ].join('\n');
      await expect(parseHashFromStderr(stderr, 'sha256')).rejects.toThrow(
        /FOD build failed.*\/nix\/store\/xxx-foo-go-modules\.drv/s,
      );
      // The build log is what the user needs, so it has to survive into the message.
      await expect(parseHashFromStderr(stderr, 'sha256')).rejects.toThrow(
        /go\.mod requires go >= 1\.27\.0/,
      );
    });

    it('reports an old-style failed builder as a build failure', async () => {
      const stderr =
        "error: builder for '/nix/store/yyy-bar.drv' failed with exit code 2";
      await expect(parseHashFromStderr(stderr, 'sha256')).rejects.toThrow(
        /FOD build failed/,
      );
    });

    it('truncates very long stderr but keeps both ends', async () => {
      const longStderr = `warning: binary cache is unusable\n${'x'.repeat(5000)}\nactual error: the thing that actually broke`;
      await expect(parseHashFromStderr(longStderr, 'sha256')).rejects.toThrow(
        /more chars truncated/,
      );
      await expect(parseHashFromStderr(longStderr, 'sha256')).rejects.toThrow(
        /actual error: the thing that actually broke/,
      );
      // The head carries nix's setup diagnostics, which explain why the build
      // ran from source at all.
      await expect(parseHashFromStderr(longStderr, 'sha256')).rejects.toThrow(
        /warning: binary cache is unusable/,
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

  describe('assertSubstitutableStore', () => {
    it('resolves for the canonical store dir', async () => {
      mockExecSequence([{ stdout: '/nix/store\n', stderr: '' }]);
      await expect(assertSubstitutableStore()).toResolve();
    });

    it('throws when the store dir cannot use binary caches', async () => {
      mockExecSequence([
        { stdout: '/tmp/containerbase/cache/nix/store\n', stderr: '' },
      ]);
      await expect(assertSubstitutableStore()).rejects.toThrow(
        /binary caches only serve '\/nix\/store'/,
      );
    });

    it('re-probes on every call — another manager can swap nix mid-run', async () => {
      const snapshots = mockExecSequence([
        { stdout: '/nix/store\n', stderr: '' },
        { stdout: '/tmp/containerbase/cache/nix/store\n', stderr: '' },
      ]);
      await expect(assertSubstitutableStore()).toResolve();
      await expect(assertSubstitutableStore()).rejects.toThrow(
        /binary caches only serve/,
      );
      expect(snapshots).toHaveLength(2);
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

    it('does not pass --eval-system so runnerPkgs resolves to the runner system', async () => {
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
      expect(cmd).toContain('--no-link');
      expect(cmd).toContain('--impure');
      // Critical: passing --eval-system would make `builtins.currentSystem`
      // resolve to the package's system, then `runnerPkgs` would be darwin
      // pkgs, then the fetcher would produce a darwin derivation linux
      // can't build. We rely on currentSystem == runner system.
      expect(cmd).not.toContain('--eval-system');
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

    it('warns when nix ignored a substituter for want of a key', async () => {
      const stderr = [
        "warning: ignoring substitute for '/nix/store/xxx-foo' from 'https://nixkit.cachix.org', as it's not signed by any of the keys in 'trusted-public-keys'",
        '  got: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ].join('\n');
      mockExecSequence([makeMismatchError(stderr)]);

      await prefetch({
        expr: 'x',
        pkgSystem: 'x86_64-linux',
        algo: 'sha256',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        { substituters: ['https://nixkit.cachix.org'] },
        'nix-update: substituters ignored, no matching key in nixTrustedPublicKeys',
      );
    });
  });
});
