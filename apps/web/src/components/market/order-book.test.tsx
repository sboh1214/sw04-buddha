import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type OrderBook, type OrderBookContract, type OrderBookLevel } from '@/lib/api';
import { formatContracts, formatPricePerContract } from '@/lib/market-admin';
import { type BookSideKey } from '@/lib/order-book-view';
import { type ListView } from '@/lib/query-client';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { OrderBookView } from './order-book';

/**
 * 호가창 (#122, ADR-0138) as drawn: `OrderBookView` from props alone, rendered to HTML (no effects
 * and no clicks run under node), and the wiring `OrderBookSection` holds, pinned in its source as
 * `use-instant-reached.test.ts` pins its hook's. The e2e (orders.spec.ts '공개 호가와 견적 (#179)',
 * market.spec.ts, pause.spec.ts, scheduled-open.spec.ts) watches the real book arrive and move.
 */

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const BOOK_ID = 'market-order-book';

/**
 * orders.spec.ts's book (#179): A's NO bid 40 is the YES ask 60 beside B's sell, one level; A's YES
 * bid 30 is the NO ask 70.
 */
const YES: OrderBookContract = {
  outcome: 'YES',
  asks: [{ priceCoin: 60, qty: 2 }],
  bids: [{ priceCoin: 30, qty: 3 }],
  bestAskCoin: 60,
  bestBidCoin: 30,
};
const NO: OrderBookContract = {
  outcome: 'NO',
  asks: [{ priceCoin: 70, qty: 3 }],
  bids: [{ priceCoin: 40, qty: 1 }],
  bestAskCoin: 70,
  bestBidCoin: 40,
};
const BOOK: OrderBook = { marketId: ID, marketRejectReason: null, contracts: [YES, NO] };

const EMPTY_SIDES = { asks: [], bids: [], bestAskCoin: null, bestBidCoin: null };
const EMPTY: OrderBook = {
  marketId: ID,
  marketRejectReason: null,
  contracts: [
    { outcome: 'YES', ...EMPTY_SIDES },
    { outcome: 'NO', ...EMPTY_SIDES },
  ],
};

const FOLDED: Record<BookSideKey, boolean> = {
  'yes-asks': false,
  'yes-bids': false,
  'no-asks': false,
  'no-bids': false,
};

const draw = (
  book: OrderBook | undefined,
  { view = 'ready', expanded = FOLDED }: { view?: ListView; expanded?: typeof FOLDED } = {},
) =>
  renderWithQueries(
    <OrderBookView
      view={view}
      book={book}
      expanded={expanded}
      onToggle={() => undefined}
      onRetry={() => undefined}
    />,
  );

const price = (priceCoin: number) => formatPricePerContract(priceCoin * 100);
const rowText = (level: OrderBookLevel) => `${price(level.priceCoin)}${formatContracts(level.qty)}`;

describe('호가창 (#122)', () => {
  it('draws each contract’s levels as the book answered them, price and quantity only', () => {
    const html = draw(BOOK);
    for (const [testId, level] of [
      ['yes-asks', { priceCoin: 60, qty: 2 }],
      ['yes-bids', { priceCoin: 30, qty: 3 }],
      ['no-asks', { priceCoin: 70, qty: 3 }],
      ['no-bids', { priceCoin: 40, qty: 1 }],
    ] as const) {
      const prefix = `${BOOK_ID}-${testId}-level-`;
      expect(testIdsStartingWith(html, prefix), testId).toEqual([
        `${prefix}${String(level.priceCoin)}`,
      ]);
      // The row says the price per contract and the summed quantity, and nothing else: no
      // account, no direction, no source, no running total.
      expect(byTestId(html, `${prefix}${String(level.priceCoin)}`)?.text, testId).toBe(
        rowText(level),
      );
    }
    // Each side's best price, as the answer gave it, on the side's title line.
    for (const [side, best] of [
      ['yes-asks', 60],
      ['yes-bids', 30],
      ['no-asks', 70],
      ['no-bids', 40],
    ] as const) {
      expect(byTestId(html, `${BOOK_ID}-${side}-best`)?.text, side).toBe(
        `${copy.marketBookBest} ${price(best)}`,
      );
      expect(byTestId(html, `${BOOK_ID}-${side}-empty`), side).toBeUndefined();
    }
    // YES 60 and NO 70 stand as they are: no sum of the two contracts is drawn anywhere.
    expect(html).not.toContain(price(100));
    expect(html).not.toContain(price(130));
    expect(byTestId(html, `${BOOK_ID}-reason`)).toBeUndefined();
  });

  it('keeps the section’s one h2 and gives each contract an h3, YES then NO', () => {
    const html = draw(BOOK);
    expect(byTagName(html, 'h2').map((h) => h.text)).toEqual([copy.marketOrderBook]);
    expect(byTagName(html, 'h3').map((h) => h.text)).toEqual([copy.yes, copy.no]);
    const contracts = testIdsStartingWith(html, BOOK_ID).filter(
      (id) => id.endsWith('-yes') || id.endsWith('-no'),
    );
    expect(contracts).toEqual([`${BOOK_ID}-yes`, `${BOOK_ID}-no`]);
    // 매도호가 over 매수호가 in each contract.
    expect(
      testIdsStartingWith(html, `${BOOK_ID}-yes-`).filter((id) => /-(asks|bids)$/.test(id)),
    ).toEqual([`${BOOK_ID}-yes-asks`, `${BOOK_ID}-yes-bids`]);
    // Every column header is a column's, visible or not (`scope="col"`): two tables of two.
    expect(html.match(/scope="col"/g)).toHaveLength(8);
  });

  it('says 호가 없음 on an empty side and borrows nothing from the other side or contract', () => {
    const html = draw({ ...BOOK, contracts: [{ ...YES, asks: [], bestAskCoin: null }, NO] });
    const yesAsks = byTestId(html, `${BOOK_ID}-yes-asks`);
    expect(byTestId(html, `${BOOK_ID}-yes-asks-empty`)?.text).toBe(copy.marketBookEmpty);
    expect(byTestId(html, `${BOOK_ID}-yes-asks-best`)).toBeUndefined();
    expect(testIdsStartingWith(html, `${BOOK_ID}-yes-asks-level-`)).toEqual([]);
    // Not 100 − 30 of the same contract, nor NO's 40 bid made an ask.
    expect(yesAsks?.text).not.toContain(price(70));
    expect(byTestId(html, `${BOOK_ID}-yes`)?.text).not.toContain(price(70));
    expect(yesAsks?.text).not.toContain(price(60));
  });

  it('says 호가 없음 on all four sides of an open market nobody quotes, with no reason line', () => {
    // A market whose bot alone stopped: open, so not drawn as 마감 or 일시 중단.
    const html = draw(EMPTY);
    expect(testIdsStartingWith(html, BOOK_ID).filter((id) => id.endsWith('-empty'))).toEqual([
      `${BOOK_ID}-yes-asks-empty`,
      `${BOOK_ID}-yes-bids-empty`,
      `${BOOK_ID}-no-asks-empty`,
      `${BOOK_ID}-no-bids-empty`,
    ]);
    expect(byTestId(html, `${BOOK_ID}-reason`)).toBeUndefined();
    expect(byTagName(html, 'table')).toEqual([]);
    expect(html).not.toContain(copy.marketBookReasonClosed);
    expect(html).not.toContain(copy.marketBookReasonPaused);
  });

  it('draws one reason line in place of the contracts when the book has a reason', () => {
    const html = draw({ ...EMPTY, marketRejectReason: 'closed' });
    expect(byTestId(html, `${BOOK_ID}-reason`)?.text).toBe(copy.marketBookReasonClosed);
    expect(byTagName(html, 'h2').map((h) => h.text)).toEqual([copy.marketOrderBook]);
    expect(byTagName(html, 'h3')).toEqual([]);
    expect(byTestId(html, `${BOOK_ID}-yes`)).toBeUndefined();
    expect(html).not.toContain(copy.marketBookEmpty);
    // The reason alone decides it: the same contracts with no reason are drawn.
    const open = draw(BOOK);
    expect(byTestId(open, `${BOOK_ID}-reason`)).toBeUndefined();
    expect(byTestId(open, `${BOOK_ID}-yes`)).toBeDefined();
  });

  it('shows five levels a side and a 더 보기 for the rest, opens that side only, and 접기', () => {
    const seven = (from: number): OrderBookLevel[] =>
      Array.from({ length: 7 }, (_, i) => ({ priceCoin: from - i, qty: 1 }));
    const deep: OrderBook = {
      ...BOOK,
      contracts: [
        { ...YES, bids: seven(30), bestBidCoin: 30 },
        { ...NO, asks: seven(70).reverse(), bestAskCoin: 64 },
      ],
    };
    const folded = draw(deep);
    for (const side of ['yes-bids', 'no-asks'] as const) {
      expect(testIdsStartingWith(folded, `${BOOK_ID}-${side}-level-`), side).toHaveLength(5);
      const more = byTestId(folded, `${BOOK_ID}-${side}-more`);
      expect(more?.text, side).toBe(copy.marketBookShowAll);
      expect(more?.attributes['aria-expanded'], side).toBe('false');
    }
    expect(byTestId(folded, `${BOOK_ID}-yes-bids-more`)?.attributes['aria-label']).toBe(
      'YES 매수호가 더 보기',
    );
    // The first five are the best five, in the book's order.
    expect(testIdsStartingWith(folded, `${BOOK_ID}-yes-bids-level-`)).toEqual(
      [30, 29, 28, 27, 26].map((p) => `${BOOK_ID}-yes-bids-level-${String(p)}`),
    );
    // A side of one level has no 더 보기.
    expect(byTestId(folded, `${BOOK_ID}-yes-asks-more`)).toBeUndefined();

    const opened = draw(deep, { expanded: { ...FOLDED, 'yes-bids': true } });
    expect(testIdsStartingWith(opened, `${BOOK_ID}-yes-bids-level-`)).toHaveLength(7);
    // The open side keeps its button, now 접기 (owner decision 2026-11-16, ADR-0138): it stays,
    // so the focus stays on it, and it says the side is open.
    const collapse = byTestId(opened, `${BOOK_ID}-yes-bids-more`);
    expect(collapse?.text).toBe(copy.marketBookCollapse);
    expect(collapse?.attributes['aria-expanded']).toBe('true');
    expect(collapse?.attributes['aria-label']).toBe('YES 매수호가 접기');
    // The other side is as it was.
    expect(testIdsStartingWith(opened, `${BOOK_ID}-no-asks-level-`)).toHaveLength(5);
    const otherMore = byTestId(opened, `${BOOK_ID}-no-asks-more`);
    expect(otherMore?.text).toBe(copy.marketBookShowAll);
    expect(otherMore?.attributes['aria-expanded']).toBe('false');
    // A side of five levels or fewer has no button, open or not.
    const shallowOpen = draw(deep, { expanded: { ...FOLDED, 'yes-asks': true } });
    expect(byTestId(shallowOpen, `${BOOK_ID}-yes-asks-more`)).toBeUndefined();
    expect(byTestId(opened, `${BOOK_ID}-yes-asks-more`)).toBeUndefined();
    expect(byTestId(opened, `${BOOK_ID}-no-bids-more`)).toBeUndefined();
  });

  it('keeps the card and its title in every state, and the last book under a stale notice', () => {
    const pending = draw(undefined, { view: 'pending' });
    expect(byTestId(pending, BOOK_ID)).toBeDefined();
    expect(byTagName(pending, 'h2').map((h) => h.text)).toEqual([copy.marketOrderBook]);
    expect(byTestId(pending, `${BOOK_ID}-pending`)).toBeDefined();
    expect(byTestId(pending, `${BOOK_ID}-yes`)).toBeUndefined();

    const failed = draw(undefined, { view: 'failed' });
    expect(byTestId(failed, `${BOOK_ID}-failed`)?.text).toContain(copy.errUnknown);
    expect(byTestId(failed, `${BOOK_ID}-failed`)?.text).toContain(copy.retry);
    expect(byTestId(failed, `${BOOK_ID}-pending`)).toBeUndefined();

    const stale = draw(BOOK, { view: 'stale' });
    expect(byTestId(stale, `${BOOK_ID}-stale`)?.text).toContain(copy.marketRefreshFailed);
    expect(byTestId(stale, `${BOOK_ID}-yes-asks-level-60`)).toBeDefined();

    const ready = draw(BOOK);
    expect(byTestId(ready, `${BOOK_ID}-stale`)).toBeUndefined();
    expect(byTestId(ready, `${BOOK_ID}-pending`)).toBeUndefined();
    expect(byTestId(ready, `${BOOK_ID}-failed`)).toBeUndefined();
  });
});

describe('OrderBookSection', () => {
  const source = readFileSync(new URL('./order-book.tsx', import.meta.url), 'utf8');
  const section = source.slice(
    source.indexOf('export function OrderBookSection('),
    source.indexOf('export interface OrderBookViewProps'),
  );

  it('reads the public book through the one hook and its four states', () => {
    expect(section).toContain('const query = useOrderBook(marketId);');
    expect(section).toContain('view={listView(query)}');
    expect(section).toContain('book={query.data}');
  });

  it('reads the book again a second past an open market’s close, from the server’s anchor', () => {
    expect(section).toContain('useInstantReached(bookRereadAt(market), now, () => {');
    expect(section).toContain('void restartQueries(queryClient, marketBookKey(marketId));');
  });

  it('keeps one 더 보기 state per side, which its button flips', () => {
    expect(section.match(/useState\(false\)/g)).toHaveLength(4);
    expect(section).toContain('setters[key](!expanded[key]);');
  });

  // The static HTML drops the styles, so which header row shows is pinned in the source: one per
  // contract, over 매도호가's table, or 매수호가's when there is no ask (the `scope="col"` count
  // above holds every header, shown or not).
  it('shows one header row per contract, over its first table', () => {
    expect(source).toContain("showsHead={side === 'asks' || contract.asks.length === 0}");
    // YES and NO side by side from lg only (ADR-0138 2-2): below it, md included, one above the
    // other. Pinned so a change of the width is a decision, not a slip.
    expect(source).toContain('columns={{ base: 1, lg: 2 }}');
    expect(source).toContain('<Table.Header {...(showsHead ? {} : { srOnly: true })}>');
  });

  // The button stays as its side opens (it turns into 접기), so the focus stays on it and nothing
  // moves it — clicks do not run under node, so the e2e watches the focus stay.
  it('keeps the button drawn on an open side and moves no focus', () => {
    expect(source).toContain('if (hiddenCount === 0) return null;');
    expect(source).not.toContain('flushSync');
    expect(source).not.toContain('.focus()');
    expect(source).not.toContain('tabIndex');
  });

  it('draws a level from the public level alone', () => {
    expect(source).toContain('function BookLevelCells({ level }: { level: OrderBookLevel })');
  });
});
