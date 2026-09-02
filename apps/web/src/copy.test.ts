import { formatP } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from './copy';

// PLAN Appendix A: gambling vocabulary must never appear in user-facing copy.
const FORBIDDEN_WORDS = ['베팅', '배당', '배당률', '승률', '판돈', '당첨'];

describe('copy', () => {
  it('has the wallet notice', () => {
    expect(copy.walletNotice).toContain('환전');
  });

  it('contains no forbidden gambling vocabulary', () => {
    for (const text of Object.values(copy)) {
      for (const word of FORBIDDEN_WORDS) {
        expect(text).not.toContain(word);
      }
    }
  });

  it('formats P via @buddha/shared (workspace wiring)', () => {
    expect(formatP(12345n)).toBe('12,345P');
  });
});
