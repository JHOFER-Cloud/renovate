import { DEBUG, ERROR, FATAL, INFO, TRACE, WARN } from 'bunyan';
import { getProblems } from '../../logger/index.ts';
import {
  extractNixUpdateArtifactWarnings,
  formatProblemLevel,
} from './common.ts';

vi.mock('../../logger/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger/index.ts')>();
  return { ...actual, getProblems: vi.fn().mockReturnValue([]) };
});

describe('workers/repository/common', () => {
  describe('extractNixUpdateArtifactWarnings()', () => {
    beforeEach(() => {
      vi.mocked(getProblems).mockReturnValue([]);
    });

    it('returns warnings matching the nix-update prefix for the given repo', () => {
      vi.mocked(getProblems).mockReturnValue([
        {
          repository: 'me/r',
          level: WARN,
          msg: 'nix-update: failed to prefetch foo src (fetchurl)',
        } as never,
        {
          repository: 'me/r',
          level: WARN,
          msg: 'nix-update: failed to prefetch bar goModules (goModules)',
        } as never,
        // Lower level — must not be picked up.
        {
          repository: 'me/r',
          level: INFO,
          msg: 'nix-update: failed to prefetch info-only',
        } as never,
        // Unrelated msg — must not be picked up.
        {
          repository: 'me/r',
          level: WARN,
          msg: 'something else broke',
        } as never,
        // Different repo — must not be picked up.
        {
          repository: 'other/repo',
          level: WARN,
          msg: 'nix-update: failed to prefetch baz src (fetchurl)',
        } as never,
      ]);
      const out = extractNixUpdateArtifactWarnings('me/r');
      expect(out).toEqual([
        'nix-update: failed to prefetch foo src (fetchurl)',
        'nix-update: failed to prefetch bar goModules (goModules)',
      ]);
    });

    it('returns empty when no matching warnings exist', () => {
      vi.mocked(getProblems).mockReturnValue([]);
      expect(extractNixUpdateArtifactWarnings('me/r')).toEqual([]);
    });

    it('deduplicates identical warnings', () => {
      vi.mocked(getProblems).mockReturnValue([
        {
          repository: 'me/r',
          level: WARN,
          msg: 'nix-update: failed to prefetch foo src (fetchurl)',
        } as never,
        {
          repository: 'me/r',
          level: WARN,
          msg: 'nix-update: failed to prefetch foo src (fetchurl)',
        } as never,
      ]);
      expect(extractNixUpdateArtifactWarnings('me/r')).toEqual([
        'nix-update: failed to prefetch foo src (fetchurl)',
      ]);
    });
  });

  describe('formatProblemLevel()', () => {
    it('handles trace level', () => {
      expect(formatProblemLevel(TRACE)).toEqual('🔬 TRACE');
    });

    it('handles debug level', () => {
      expect(formatProblemLevel(DEBUG)).toEqual('🔍 DEBUG');
    });

    it('handles info level', () => {
      expect(formatProblemLevel(INFO)).toEqual('ℹ️ INFO');
    });

    it('handles warn level', () => {
      expect(formatProblemLevel(WARN)).toEqual('⚠️ WARN');
    });

    it('handles error level', () => {
      expect(formatProblemLevel(ERROR)).toEqual('❌ ERROR');
    });

    it('handles fatal level', () => {
      expect(formatProblemLevel(FATAL)).toEqual('💀 FATAL');
    });
  });
});
