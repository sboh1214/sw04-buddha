import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MARKET_STATUSES } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { SRC } from '../test/screen-text';
import { type OrderBookLevel } from './api';
import {
  BOOK_CLOSE_REREAD_SLACK_MS,
  ORDER_BOOK_SHOWN_LEVELS,
  bookMoreLabel,
  bookReasonMessage,
  bookRereadAt,
  bookSideKey,
  hiddenLevelCount,
  shownLevels,
} from './order-book-view';

/**
 * 호가창 (#122, ADR-0138): the rules the book section draws by — five levels a side until 더 보기
 * (ADR-0135 B2), the reason line's words (B3), the read at an open market's close (result 4) — and
 * that nothing in it makes a price out of another.
 */

/** `n` levels from 60 down, one contract each: a bid side, best first. */
const levels = (n: number): OrderBookLevel[] =>
  Array.from({ length: n }, (_, i) => ({ priceCoin: 60 - i, qty: i + 1 }));

describe('the levels a side shows', () => {
  it('shows five until 더 보기 and every level once it is pressed, in the book’s order', () => {
    expect(ORDER_BOOK_SHOWN_LEVELS).toBe(5);
    for (const n of [0, 4, 5, 7]) {
      const side = levels(n);
      expect(shownLevels(side, false), String(n)).toEqual(side.slice(0, 5));
      expect(shownLevels(side, true), String(n)).toEqual(side);
      expect(hiddenLevelCount(side), String(n)).toBe(Math.max(0, n - 5));
    }
    // The best price stays first: cutting keeps the head, never re-sorts.
    expect(shownLevels(levels(7), false).map((level) => level.priceCoin)).toEqual([
      60, 59, 58, 57, 56,
    ]);
  });

  it('leaves an empty side empty, whatever the other side holds', () => {
    // No ask made from the bids (N02 §5): an empty side is the book's empty array.
    expect(shownLevels([], false)).toEqual([]);
    expect(shownLevels([], true)).toEqual([]);
    expect(hiddenLevelCount([])).toBe(0);
  });

  it('names each side apart, and says whose levels a 더 보기 opens or a 접기 folds', () => {
    expect(bookSideKey('YES', 'asks')).toBe('yes-asks');
    expect(bookSideKey('NO', 'bids')).toBe('no-bids');
    expect(bookMoreLabel('YES', 'bids', false)).toBe('YES 매수호가 더 보기');
    expect(bookMoreLabel('NO', 'asks', false)).toBe('NO 매도호가 더 보기');
    expect(bookMoreLabel('YES', 'bids', true)).toBe('YES 매수호가 접기');
    expect(bookMoreLabel('NO', 'asks', true)).toBe('NO 매도호가 접기');
  });
});

describe('the reason line', () => {
  it('says each reason in its reject reason’s name, not the status label', () => {
    expect(bookReasonMessage('not_open_yet')).toBe(copy.marketBookReasonNotOpenYet);
    expect(bookReasonMessage('paused')).toBe(copy.marketBookReasonPaused);
    expect(bookReasonMessage('closed')).toBe(copy.marketBookReasonClosed);
    expect(copy.marketBookReasonNotOpenYet).toContain('개장 전');
    expect(copy.marketBookReasonPaused).toContain('일시 중단');
    expect(copy.marketBookReasonClosed).toContain('마감');
    // A market still 거래 중 past its close reads '마감' here: never the badge's '거래 마감'.
    expect(copy.marketBookReasonClosed).not.toContain(copy.marketStatusClosed);
    // '호가 없음' is an empty side's, and never the reason (ADR-0138).
    for (const reason of ['not_open_yet', 'paused', 'closed'] as const) {
      expect(bookReasonMessage(reason)).not.toContain(copy.marketBookEmpty);
    }
  });
});

describe('the read at the close', () => {
  const closeAt = '2026-11-16T03:00:00.000Z';

  it('is a second past an open market’s close', () => {
    expect(BOOK_CLOSE_REREAD_SLACK_MS).toBe(1_000);
    expect(bookRereadAt({ status: 'open', closeAt })).toBe('2026-11-16T03:00:01.000Z');
  });

  it('is none for a market that is not open, or not known yet', () => {
    for (const status of MARKET_STATUSES.filter((s) => s !== 'open')) {
      expect(bookRereadAt({ status, closeAt }), status).toBeNull();
    }
    expect(bookRereadAt(undefined)).toBeNull();
  });

  it('follows a moved close (#80): another instant, waited for afresh', () => {
    const moved = '2026-11-17T03:00:00.000Z';
    expect(bookRereadAt({ status: 'open', closeAt: moved })).toBe('2026-11-17T03:00:01.000Z');
    expect(bookRereadAt({ status: 'open', closeAt: moved })).not.toBe(
      bookRereadAt({ status: 'open', closeAt }),
    );
  });
});

describe('the book section makes no price', () => {
  it('has no arithmetic on a price beyond the unit (no 100 − bid, no sum of levels)', () => {
    // The code, not its comments, which name the rules they keep.
    const code = (file: string) =>
      readFileSync(path.join(SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    for (const file of ['lib/order-book-view.ts', 'components/market/order-book.tsx']) {
      const source = code(file);
      expect(source, file).not.toMatch(/\b100\s*[-−]/);
      // `best` too: the side's best price reaches its rows under that name. An operator stands
      // between spaces (prettier), which a testid's '-best' does not.
      expect(source, file).not.toMatch(/\s[+-]\s+\(?\s*[\w.]*(priceCoin|qty|best\w*)\b/);
      expect(source, file).not.toMatch(/\b(priceCoin|qty|best\w*)\s*\)?\s+[+-]\s/);
      expect(source, file).not.toMatch(/\.reduce\(|\+=|payoutCoin|CONTRACT_TERMS/);
    }
  });
});
