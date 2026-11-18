import { readFileSync } from 'node:fs';
import {
  LEDGER_ENTRY_KINDS,
  LEDGER_FILTER_KINDS,
  RECENT_PERIODS,
  type UserBalanceEvent,
  findExcludedText,
} from '@buddha/shared';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { storeBalanceEvent } from '@/hooks/use-me';
import { type LedgerEntry, type Me, type Order } from './api';
import {
  type LedgerPage,
  type LedgerPages,
  PERIOD_EXPIRY_MARGIN_MS,
  PERIOD_REVALIDATE_MS,
  headCoversLedger,
  ledgerHeadDate,
  keepNewerHead,
  mergeLedgerHead,
} from './ledger-join';
import { ME_KEY, getQueryClient } from './query-client';
import {
  LEDGER_FILTER_OPTIONS,
  LEDGER_KIND_LABEL,
  type WalletFilters,
  isWalletFiltered,
  ledgerBalanceNote,
  ledgerEmptyText,
  ledgerKindSlug,
  liveBuysReading,
  lockWatchStep,
  meReadOwed,
  myWalletPath,
  onlyMarketPath,
  refreshLockedBalance,
  showsCorrectionNote,
  startGrantPending,
  walletFiltersFromSearchParams,
  walletListFilters,
} from './wallet';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PACKAGE = '9c858901-8a57-4791-81fe-4c455b099bc9';

describe('LEDGER_KIND_LABEL', () => {
  it('names every kind an answer can carry, each with a word of its own', () => {
    expect(Object.keys(LEDGER_KIND_LABEL).sort()).toEqual([...LEDGER_ENTRY_KINDS].sort());
    const labels = Object.values(LEDGER_KIND_LABEL);
    // Two kinds under one word would make 이용 내역 tell two sources of Coin as one (N04 §5).
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("uses the owner's names (ADR-0135 H1), and never calls a payout a refund", () => {
    expect(LEDGER_FILTER_KINDS.map((kind) => LEDGER_KIND_LABEL[kind])).toEqual([
      '매수 체결',
      '매도 체결',
      '정산 지급',
      '시작 지급',
      'Coin 보정',
    ]);
    for (const kind of LEDGER_FILTER_KINDS) {
      expect(LEDGER_KIND_LABEL[kind], kind).not.toMatch(/환불|원금|대금|담보|정정/);
    }
    // The old provisional names (ADR-0109 결정 11) name no row: their keys are gone, and no kind
    // reads as one. '체결 대금' stays as 주문 상세's own field (`orderFilledAmountLabel`, #123).
    expect(copy).not.toHaveProperty('ledgerTypePairMintCollateral');
    expect(copy).not.toHaveProperty('ledgerTypeTradeFill');
    for (const old of ['쌍 발행 담보', '체결 대금', '대사 정정']) {
      expect(Object.values(LEDGER_KIND_LABEL), old).not.toContain(old);
    }
  });

  it("calls the start Coin '시작 지급', never the coupon's 보너스 (ADR-0069 decision 4 #70)", () => {
    expect(LEDGER_KIND_LABEL.START_GRANT).toBe('시작 지급');
    expect(LEDGER_KIND_LABEL.START_GRANT).not.toBe(LEDGER_KIND_LABEL.BONUS);
    expect(LEDGER_KIND_LABEL.START_GRANT).not.toContain('보너스');
  });
});

describe('LEDGER_FILTER_OPTIONS', () => {
  it("offers '전체' first, then the five names in the owner's order (ADR-0135 H5)", () => {
    expect(LEDGER_FILTER_OPTIONS.map((option) => option.label)).toEqual([
      copy.ledgerKindAll,
      '매수 체결',
      '매도 체결',
      '정산 지급',
      '시작 지급',
      'Coin 보정',
    ]);
    expect(LEDGER_FILTER_OPTIONS.map((option) => option.kind)).toEqual([
      undefined,
      ...LEDGER_FILTER_KINDS,
    ]);
  });

  it('offers no kept paid-Coin or coupon kind, and names no excluded feature', () => {
    for (const option of LEDGER_FILTER_OPTIONS) {
      expect(findExcludedText(option.label), option.label).toEqual([]);
    }
  });
});

describe('the wallet address', () => {
  it('writes a filter kind as a lower-case slug with hyphens', () => {
    expect(LEDGER_FILTER_KINDS.map(ledgerKindSlug)).toEqual([
      'buy-fill',
      'sell-fill',
      'settlement-payout',
      'start-grant',
      'reconciliation-correction',
    ]);
  });

  it('reads each slug, each period and a market uuid lower-cased, and opens on no filter', () => {
    expect(walletFiltersFromSearchParams({})).toEqual({});
    for (const kind of LEDGER_FILTER_KINDS) {
      expect(walletFiltersFromSearchParams({ kind: ledgerKindSlug(kind) })).toEqual({ kind });
    }
    for (const period of RECENT_PERIODS) {
      expect(walletFiltersFromSearchParams({ period })).toEqual({ period });
    }
    expect(
      walletFiltersFromSearchParams({
        kind: 'sell-fill',
        period: '30d',
        market: MARKET.toUpperCase(),
      }),
    ).toEqual({ kind: 'SELL_FILL', period: '30d', market: MARKET });
  });

  it('drops what the API would refuse instead of sending it, and reads a repeat by its first', () => {
    // The API's own value, a kept kind, an empty value: '전체'. `all` and a day count: no period.
    for (const kind of ['SELL_FILL', 'deposit', 'trade-fill', 'pair-mint-collateral', '', 'all']) {
      expect(walletFiltersFromSearchParams({ kind }), kind).toEqual({});
    }
    expect(walletFiltersFromSearchParams({ period: 'all', market: 'rate-cut-2026' })).toEqual({});
    expect(
      walletFiltersFromSearchParams({ kind: ['buy-fill', 'sell-fill'], period: ['7d', '90d'] }),
    ).toEqual({ kind: 'BUY_FILL', period: '7d' });
  });

  it('keeps the package /charge sent only while sales are on', () => {
    expect(walletFiltersFromSearchParams({ package: PACKAGE }, false)).toEqual({});
    expect(walletFiltersFromSearchParams({ package: PACKAGE }, true)).toEqual({
      packageId: PACKAGE,
    });
    expect(myWalletPath({ packageId: PACKAGE, kind: 'BUY_FILL' }, false)).toBe(
      '/my/wallet?kind=buy-fill',
    );
    expect(myWalletPath({ packageId: PACKAGE, kind: 'BUY_FILL' }, true)).toBe(
      `/my/wallet?kind=buy-fill&package=${PACKAGE}`,
    );
  });

  it('writes what is set only, and reads back what it wrote', () => {
    expect(myWalletPath({})).toBe('/my/wallet');
    const filters = { kind: 'SETTLEMENT_PAYOUT', period: '90d', market: MARKET } as const;
    const path = myWalletPath({ ...filters, market: MARKET.toUpperCase() });
    expect(path).toBe(`/my/wallet?kind=settlement-payout&period=90d&market=${MARKET}`);
    const read = new URL(path, 'https://x.test').searchParams;
    expect(
      walletFiltersFromSearchParams({
        kind: read.get('kind') ?? undefined,
        period: read.get('period') ?? undefined,
        market: read.get('market') ?? undefined,
      }),
    ).toEqual(filters);
  });

  it('says whether a filter is on, and gives the list its three filters alone', () => {
    expect(isWalletFiltered({})).toBe(false);
    expect(isWalletFiltered({ kind: 'START_GRANT' })).toBe(true);
    expect(isWalletFiltered({ period: '7d' })).toBe(true);
    expect(isWalletFiltered({ market: MARKET })).toBe(true);
    expect(walletListFilters({ market: MARKET.toUpperCase() })).toEqual({ market: MARKET });
    const withPackage: WalletFilters = { kind: 'BUY_FILL', packageId: PACKAGE };
    expect(walletListFilters(withPackage)).toEqual({ kind: 'BUY_FILL' });
  });
});

describe("the list's lines (ADR-0144 결정 2)", () => {
  const OTHER = '9a3b4c5d-6e7f-4a1b-8c2d-3e4f5a6b7c8d';

  it("links '이 시장만 보기' with the filters kept, never for no market or the market narrowed to", () => {
    const filters: WalletFilters = { kind: 'BUY_FILL', period: '30d' };
    expect(onlyMarketPath({ marketId: MARKET }, filters)).toBe(
      `/my/wallet?kind=buy-fill&period=30d&market=${MARKET}`,
    );
    expect(onlyMarketPath({ marketId: null }, filters)).toBeUndefined();
    expect(onlyMarketPath({ marketId: MARKET }, { ...filters, market: MARKET })).toBeUndefined();
    // The id is compared lower-cased, as the address writes it.
    expect(onlyMarketPath({ marketId: MARKET.toUpperCase() }, { market: MARKET })).toBeUndefined();
    // Narrowed to another market: the row's market replaces it.
    expect(onlyMarketPath({ marketId: MARKET }, { market: OTHER })).toBe(
      `/my/wallet?market=${MARKET}`,
    );
  });

  it('says nothing exists when unfiltered, and nothing matched while any filter is on', () => {
    expect(ledgerEmptyText({})).toBe(copy.ledgerEmpty);
    for (const filters of [
      { kind: 'START_GRANT' },
      { period: '7d' },
      { market: MARKET },
    ] as const) {
      expect(ledgerEmptyText(filters), JSON.stringify(filters)).toBe(copy.historyFilteredEmpty);
    }
  });

  it("explains '반영 후 코인 합계', and while filtered that it no longer follows on", () => {
    expect(ledgerBalanceNote({})).toBe(copy.ledgerBalanceAfterNote);
    expect(ledgerBalanceNote({ period: '90d' })).toBe(
      `${copy.ledgerBalanceAfterNote} ${copy.ledgerBalanceAfterFilteredNote}`,
    );
  });

  it("says where the other corrections are under 'Coin 보정' only", () => {
    expect(showsCorrectionNote({ kind: 'RECONCILIATION_CORRECTION' })).toBe(true);
    expect(showsCorrectionNote({})).toBe(false);
    for (const kind of LEDGER_FILTER_KINDS.filter((k) => k !== 'RECONCILIATION_CORRECTION')) {
      expect(showsCorrectionNote({ kind }), kind).toBe(false);
    }
  });

  it('is what the list draws, under its test ids', () => {
    const list = readFileSync(new URL('../app/my/wallet/ledger-list.tsx', import.meta.url), 'utf8');
    expect(list).toMatch(
      /\{showsCorrectionNote\(listFilters\) && \(\s*<Text[^>]*data-testid="ledger-correction-note"/,
    );
    expect(list).toMatch(/data-testid="ledger-empty">\s*\{ledgerEmptyText\(listFilters\)\}/);
    expect(list).toMatch(
      /data-testid="ledger-balance-note">\s*\{ledgerBalanceNote\(listFilters\)\}/,
    );
    expect(list).toContain('onlyMarketHref={onlyMarketPath(entry, filters)}');
  });
});

describe("the wallet's watch of its live buys (ADR-0144 결정 2-11)", () => {
  const order = (
    id: string,
    side: Order['side'],
    qty: number,
    filledQty = 0,
  ): Pick<Order, 'id' | 'side' | 'qty' | 'filledQty' | 'filledAmountCoin'> => ({
    id,
    side,
    qty,
    filledQty,
    filledAmountCoin: '0',
  });
  const ACCOUNT = 'account-a';
  const before = liveBuysReading([order('b1', 'buy', 3), order('s1', 'sell', 2)]);
  const watchedFrom = lockWatchStep(undefined, ACCOUNT, before, true).baseline;

  it('reads nothing before a baseline, and makes one from the first reading watched', () => {
    expect(lockWatchStep(undefined, ACCOUNT, before, false)).toEqual({
      baseline: undefined,
      read: false,
    });
    expect(lockWatchStep(undefined, ACCOUNT, before, true)).toEqual({
      baseline: { accountId: ACCOUNT, buys: before },
      read: false,
    });
  });

  it('reads nothing while the buys are the same, whatever their order', () => {
    const same = liveBuysReading([order('s1', 'sell', 2), order('b1', 'buy', 3)]);
    expect(lockWatchStep(watchedFrom, ACCOUNT, same, true).read).toBe(false);
  });

  it('reads once when a buy left or came', () => {
    for (const rows of [
      [order('s1', 'sell', 2)],
      [order('b1', 'buy', 3), order('b2', 'buy', 1), order('s1', 'sell', 2)],
    ]) {
      const step = lockWatchStep(watchedFrom, ACCOUNT, liveBuysReading(rows), true);
      expect(step.read).toBe(true);
      // The next reading compares with this one: the same rows read nothing more.
      expect(lockWatchStep(step.baseline, ACCOUNT, liveBuysReading(rows), true).read).toBe(false);
    }
  });

  it('reads nothing when a buy was only filled in part — its user:balance brought the lock', () => {
    // An order's size is fixed at intake, so a remaining quantity moves by a fill alone, and the
    // fill's `user:balance` carries `lockedCoin` (ADR-0144 결정 2-11, 결정 6).
    const partly = liveBuysReading([
      { ...order('b1', 'buy', 3, 2), filledAmountCoin: '80' },
      order('s1', 'sell', 2),
    ]);
    expect(partly).toBe(before);
    expect(lockWatchStep(watchedFrom, ACCOUNT, partly, true).read).toBe(false);
    // The reading is the buy ids alone, sorted.
    expect(liveBuysReading([order('b2', 'buy', 1), order('b1', 'buy', 3)])).toBe('b1,b2');
  });

  it('reads nothing when only a sell changed — it locks contracts, not Coin', () => {
    const sells = liveBuysReading([order('b1', 'buy', 3), order('s1', 'sell', 2, 1)]);
    expect(sells).toBe(before);
    expect(lockWatchStep(watchedFrom, ACCOUNT, sells, true).read).toBe(false);
    const gone = liveBuysReading([order('b1', 'buy', 3)]);
    expect(lockWatchStep(watchedFrom, ACCOUNT, gone, true).read).toBe(false);
  });

  it('starts again without a read when the account changed', () => {
    const other = liveBuysReading([]);
    expect(lockWatchStep(watchedFrom, 'account-b', other, true)).toEqual({
      baseline: { accountId: 'account-b', buys: other },
      read: false,
    });
  });

  it('waits for the new account’s first watched reading when the account changed', () => {
    // `['me']` turned to B before B's live orders were read: an empty reading nobody watched.
    const unwatched = lockWatchStep(watchedFrom, 'account-b', '', false);
    expect(unwatched).toEqual({ baseline: undefined, read: false });
    // B's first page then builds the baseline without a read, and the same buys read nothing.
    const bBuys = liveBuysReading([order('b9', 'buy', 2)]);
    const first = lockWatchStep(unwatched.baseline, 'account-b', bBuys, true);
    expect(first).toEqual({ baseline: { accountId: 'account-b', buys: bBuys }, read: false });
    expect(lockWatchStep(first.baseline, 'account-b', bBuys, true).read).toBe(false);
  });
});

describe('meReadOwed', () => {
  const owed = { cancelled: true, answered: false, failed: false, running: false };

  it('owes a read only when it was cancelled and nothing brought or refused the balance', () => {
    expect(meReadOwed(owed)).toBe(true);
    // Each of the four on its own decides it: an answer, a failure or a newer read on its way
    // ends the debt, and an uncancelled read owes nothing.
    expect(meReadOwed({ ...owed, cancelled: false })).toBe(false);
    expect(meReadOwed({ ...owed, answered: true })).toBe(false);
    expect(meReadOwed({ ...owed, failed: true })).toBe(false);
    expect(meReadOwed({ ...owed, running: true })).toBe(false);
  });
});

describe('refreshLockedBalance', () => {
  /** The profile `['me']` holds, as much of it as the balance event reads. */
  const profile = (id: string, startGrant: Me['startGrant'] = null): Me =>
    ({
      id,
      balance: { availableCoin: '100', lockedCoin: '20' },
      startGrant,
    }) as unknown as Me;
  /** A `user:balance` as realtime-provider.tsx's handler hands it to `storeBalanceEvent`. */
  const balance: UserBalanceEvent = {
    type: 'user:balance',
    availableCoin: '90',
    lockedCoin: '30',
    ledgerEntryId: '9',
    ts: '2026-11-16T00:00:00.000Z',
  };

  /** `['me']` with data and one observer (the balance card), and its reads counted. */
  function meQuery(held: Me = profile('held')) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let reads = 0;
    const pending: { resolve: (me: Me) => void; reject: (error: Error) => void }[] = [];
    queryClient.setQueryData(ME_KEY, held);
    const observer = new QueryObserver(queryClient, {
      queryKey: ME_KEY,
      queryFn: () => {
        reads += 1;
        return new Promise<Me>((resolve, reject) => pending.push({ resolve, reject }));
      },
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    return {
      queryClient,
      reads: () => reads,
      answer: (id: string) => pending.shift()?.resolve(profile(id)),
      fail: () => pending.shift()?.reject(new Error('GET /me failed')),
      done: () => {
        unsubscribe();
        queryClient.clear();
      },
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('reads `GET /me` once, and no more once it answered', async () => {
    const me = meQuery();
    try {
      expect(me.reads()).toBe(0);
      refreshLockedBalance(me.queryClient);
      expect(me.reads()).toBe(1);
      me.answer('fresh');
      await settle();
      expect(me.reads()).toBe(1);
      expect(me.queryClient.getQueryData(ME_KEY)).toMatchObject({ id: 'fresh' });
    } finally {
      me.done();
    }
  });

  it("reads once more when a balance event's cancel took the read, and only once", async () => {
    const me = meQuery();
    try {
      refreshLockedBalance(me.queryClient);
      // The read on its way cancelled and the event's balance written (`replace`).
      storeBalanceEvent(me.queryClient, balance);
      await settle();
      expect(me.reads()).toBe(2);
      // A second event cancels that read too: the read owed was asked again once, not again.
      storeBalanceEvent(me.queryClient, { ...balance, ledgerEntryId: '10' });
      await settle();
      expect(me.reads()).toBe(2);
    } finally {
      me.done();
    }
  });

  it("reads no more when the event's own read is on its way", async () => {
    // While the start Coin waits (`replaceAndRefetch`) the event cancels the read, writes its
    // balance and asks `['me']` again itself: that read brings the balance, so no third.
    const me = meQuery(profile('held', { status: 'pending', amountCoin: null, grantedAt: null }));
    try {
      refreshLockedBalance(me.queryClient);
      storeBalanceEvent(me.queryClient, balance);
      expect(me.reads()).toBe(2);
      await settle();
      expect(me.reads()).toBe(2);
    } finally {
      me.done();
    }
  });

  it('reads no more when the read failed — a failure is not a cancel', async () => {
    const me = meQuery();
    try {
      refreshLockedBalance(me.queryClient);
      me.fail();
      await settle();
      expect(me.reads()).toBe(1);
    } finally {
      me.done();
    }
  });

  it('asks once more for two lock changes close together, not once for each', async () => {
    const me = meQuery();
    try {
      refreshLockedBalance(me.queryClient);
      // The second replaces the first's read on its way; both watch the read that is left.
      refreshLockedBalance(me.queryClient);
      expect(me.reads()).toBe(2);
      storeBalanceEvent(me.queryClient, balance);
      await settle();
      expect(me.reads()).toBe(3);
    } finally {
      me.done();
    }
  });

  it('reads no more when a newer read took its place', async () => {
    const me = meQuery();
    try {
      refreshLockedBalance(me.queryClient);
      // Another restart (a focus, an order's answer) replaces the read on its way: that one brings
      // the balance, and its answer ends the watch.
      void me.queryClient.invalidateQueries({ queryKey: ME_KEY, exact: true });
      expect(me.reads()).toBe(2);
      me.answer('first');
      me.answer('newer');
      await settle();
      expect(me.reads()).toBe(2);
    } finally {
      me.done();
    }
  });
});

describe('startGrantPending', () => {
  const pending: Pick<Me, 'startGrant'> = {
    startGrant: { status: 'pending', amountCoin: null, grantedAt: null },
  };
  const granted: Pick<Me, 'startGrant'> = {
    startGrant: { status: 'granted', amountCoin: '10000', grantedAt: '2026-10-18T00:00:00.000Z' },
  };

  it('is true only while the grant waits for its amount', () => {
    expect(startGrantPending(pending)).toBe(true);
  });

  it('says nothing once it is paid, without a grant, or before the profile is known', () => {
    // Paid: the ledger's 시작 지급 row says so. No grant: the account has not finished the
    // onboarding, or its number's start Coin went to an earlier account (`number_used`, which
    // only the onboarding's notice says, ADR-0072) — nothing is waiting.
    expect(startGrantPending(granted)).toBe(false);
    expect(
      startGrantPending({
        startGrant: { status: 'number_used', amountCoin: null, grantedAt: null },
      }),
    ).toBe(false);
    expect(startGrantPending({ startGrant: null })).toBe(false);
    expect(startGrantPending(undefined)).toBe(false);
  });

  it("shows the owner's words for the wait, with no amount and no date", () => {
    expect(copy.walletStartGrantPending).toBe('시작 Coin은 준비되는 대로 지급됩니다.');
    // Nothing is decided while it waits: the notice promises neither a figure nor a time.
    expect(copy.walletStartGrantPending).not.toMatch(/\d/);
  });
});

describe('where the wait is told', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it("is one notice, drawn from startGrantPending with the owner's words", () => {
    const notice = source('../app/my/wallet/start-grant-notice.tsx');
    expect(notice).toContain('if (!startGrantPending(me)) return null;');
    expect(notice).toContain('{copy.walletStartGrantPending}');
  });

  it('is shown under the balance on the wallet and on MY 요약’s wallet preview (owner decision 2026-10-18)', () => {
    // The wallet's balance card (ADR-0069 decision 4 #70: '지갑에도') and the preview of the wallet
    // on MY's first screen, which shows the same balance; each with its own test id for the e2e.
    for (const [path, testId] of [
      ['../app/my/wallet/balance-card.tsx', 'wallet-start-grant-pending'],
      ['../app/my/summary.tsx', 'my-preview-wallet-start-grant-pending'],
    ] as const) {
      const screen = source(path);
      expect(screen, path).toMatch(/<StartGrantPendingNotice\b[^>]*\bme=\{me(\.data)?\}/s);
      expect(screen, path).toContain(`testId="${testId}"`);
      // Only through the shared notice: no second copy of the words or the rule.
      expect(screen, path).not.toContain('walletStartGrantPending');
    }
  });
});

describe('the ledger joins (#69, ADR-0144 결정 6)', () => {
  /** A ledger row: its id (a decimal bigserial) and its time, the two the list is ordered by. */
  const row = (id: number, second: number): LedgerEntry =>
    ({
      id: String(id),
      createdAt: new Date(Date.UTC(2026, 10, 17, 0, 0, second)).toISOString(),
    }) as LedgerEntry;
  /** Rows `from` down to `to` (ids and seconds alike), newest first. */
  const rows = (from: number, to: number): LedgerEntry[] =>
    Array.from({ length: from - to + 1 }, (_, at) => row(from - at, from - at));
  const page = (items: LedgerEntry[], nextCursor: string | null = null): LedgerPage => ({
    items,
    nextCursor,
  });
  const ids = (data: LedgerPages) => data.pages.map((each) => each.items.map((item) => item.id));
  // Three pages loaded: rows 60..1, twenty a page, newest first.
  const held: LedgerPages = {
    pages: [page(rows(60, 41), 'c41'), page(rows(40, 21), 'c21'), page(rows(20, 1))],
    pageParams: [undefined, 'c41', 'c21'],
  };

  describe('mergeLedgerHead', () => {
    it('puts the rows the head adds on the first page, the later pages and cursors kept', () => {
      const merged = mergeLedgerHead(held, page(rows(63, 44), 'c44'));
      expect(ids(merged)[0]).toEqual([...rows(63, 41)].map((item) => item.id));
      // Page one keeps its own cursor (keyset: still the row after its last); 2 and 3 untouched.
      expect(merged.pages[0]?.nextCursor).toBe('c41');
      expect(merged.pages[1]).toBe(held.pages[1]);
      expect(merged.pages[2]).toBe(held.pages[2]);
      expect(merged.pageParams).toBe(held.pageParams);
    });

    it('changes nothing when merged twice, or for a head with nothing new or older', () => {
      const head = page(rows(63, 44), 'c44');
      const once = mergeLedgerHead(held, head);
      expect(mergeLedgerHead(once, head)).toBe(once);
      // The held top is the head's top: nothing new.
      expect(mergeLedgerHead(held, page(rows(60, 41), 'c41'))).toBe(held);
      // An older head answer (it left before an earlier merge) lacks the held top and is not
      // newer than it: it adds nothing and drops nothing.
      expect(mergeLedgerHead(once, page(rows(60, 41), 'c41'))).toBe(once);
      expect(mergeLedgerHead(once, page(rows(59, 40), 'c40'))).toBe(once);
    });

    it('is the head alone with no overlap, an empty head or the held rows aged out', () => {
      // More than a page arrived between two rounds: no held row in the head.
      const far = page(rows(90, 71), 'c71');
      expect(mergeLedgerHead(held, far)).toEqual({ pages: [far], pageParams: [undefined] });
      // Every held row left `period`: nothing to list.
      expect(mergeLedgerHead(held, page([]))).toEqual({
        pages: [page([])],
        pageParams: [undefined],
      });
      // The held rows aged out of `period` while two new ones came: the head holds those alone.
      const aged = page([row(62, 62), row(61, 61)]);
      expect(mergeLedgerHead(held, aged)).toEqual({ pages: [aged], pageParams: [undefined] });
      // An empty list takes the head; an empty head over it changes nothing.
      const none: LedgerPages = { pages: [page([])], pageParams: [undefined] };
      expect(mergeLedgerHead(none, page([row(1, 1)]))).toEqual({
        pages: [page([row(1, 1)])],
        pageParams: [undefined],
      });
      expect(mergeLedgerHead(none, page([]))).toBe(none);
    });

    it('is the head alone when the head ends the list: a row aged out of `period` goes', () => {
      // '최근 7일', the list ended at r1, and r1 has just turned 8 days old. The round's head is the
      // whole list now (no cursor): r6 is new, and r1 is gone from it.
      const ended: LedgerPages = { pages: [page(rows(5, 1))], pageParams: [undefined] };
      const whole = page(rows(6, 2));
      expect(mergeLedgerHead(ended, whole)).toEqual({ pages: [whole], pageParams: [undefined] });
      // Over several loaded pages too: the list is that one page.
      const deeper: LedgerPages = {
        pages: [page(rows(9, 5), 'c5'), page(rows(4, 1))],
        pageParams: [undefined, 'c5'],
      };
      expect(mergeLedgerHead(deeper, page(rows(10, 2)))).toEqual({
        pages: [page(rows(10, 2))],
        pageParams: [undefined],
      });
      // A held row the head lacks ABOVE its last row committed after it was read, and stays.
      const later: LedgerPages = { pages: [page(rows(7, 2))], pageParams: [undefined] };
      expect(ids(mergeLedgerHead(later, page(rows(6, 3))))).toEqual([['7', '6', '5', '4', '3']]);
      // Through the cache as the round writes it: the join does not bring r1 back.
      const client = getQueryClient();
      const key = ['ledger', { period: '7d' }, 'account-a'];
      try {
        client.setQueryData(key, ended);
        client.setQueryData<LedgerPages>(key, (held) =>
          held === undefined ? undefined : mergeLedgerHead(held, whole),
        );
        expect(ids(client.getQueryData<LedgerPages>(key) ?? ended)).toEqual([
          ['6', '5', '4', '3', '2'],
        ]);
      } finally {
        client.removeQueries({ queryKey: key });
      }
    });

    it('leaves a filtered entry as it is when its head brought no new row', () => {
      // `kind=SETTLEMENT_PAYOUT`: a fill's round reads the head, which is the same rows.
      const filtered: LedgerPages = {
        pages: [page([row(30, 30), row(12, 12)])],
        pageParams: [undefined],
      };
      expect(mergeLedgerHead(filtered, page([row(30, 30), row(12, 12)]))).toBe(filtered);
    });

    it('orders rows of one instant by id, as the API does', () => {
      const same = (id: number) => row(id, 61);
      const merged = mergeLedgerHead(held, page([same(65), same(64), row(60, 60)]));
      expect(ids(merged)[0]?.slice(0, 3)).toEqual(['65', '64', '60']);
      // The id compares by value, not as text ('100' is after '99').
      const late = mergeLedgerHead(
        { pages: [page([same(99)])], pageParams: [undefined] },
        page([same(100), same(99)]),
      );
      expect(ids(late)).toEqual([['100', '99']]);
      // An older head of that instant (its top is 99, not newer than 100) adds nothing.
      expect(mergeLedgerHead(late, page([same(99)]))).toBe(late);
    });

    // B's transaction started first (an intake) and waited for the account's balance lock while
    // A (a fill on a resting buy) committed: B is listed BELOW A (older `createdAt`) yet has the
    // larger id and shows up later. The leading round drew A alone; the trailing one brings B.
    const a = row(11, 11);
    const b = row(12, 10);

    it('puts a late-committed row in its place below the held top', () => {
      const leading: LedgerPages = {
        pages: [page([a, row(9, 9)], 'c9'), page([row(8, 8)], 'c8')],
        pageParams: [undefined, 'c9'],
      };
      const trailing = mergeLedgerHead(leading, page([a, b, row(9, 9), row(8, 8)], 'c8'));
      expect(ids(trailing)).toEqual([['11', '12', '9'], ['8']]);
      expect(trailing.pages[0]?.nextCursor).toBe('c9');
      expect(trailing.pages[1]).toBe(leading.pages[1]);
      expect(mergeLedgerHead(trailing, page([a, b, row(9, 9)], 'c9'))).toBe(trailing);
      // A list that ends with A (nothing older) takes B after it; one with more to load leaves a
      // row below its last loaded row to 더 보기, whose cursor is that row.
      const short: LedgerPages = { pages: [page([a])], pageParams: [undefined] };
      expect(ids(mergeLedgerHead(short, page([a, b], 'c12')))).toEqual([['11', '12']]);
      const open: LedgerPages = { pages: [page([a], 'c11')], pageParams: [undefined] };
      expect(mergeLedgerHead(open, page([a, b], 'c12'))).toBe(open);
      // A held top the head lacks (it committed after the head was read) is kept, not let go.
      const newer: LedgerPages = {
        pages: [page([row(13, 13), a, row(9, 9)])],
        pageParams: [undefined],
      };
      expect(ids(mergeLedgerHead(newer, page([a, b, row(9, 9)])))).toEqual([
        ['13', '11', '12', '9'],
      ]);
    });
    it('takes the head’s reading of a held row: the market’s title can change, the row not', () => {
      const titled = (entry: LedgerEntry, marketTitle: string) =>
        ({ ...entry, marketSlug: 'market', marketTitle }) as LedgerEntry;
      const before: LedgerPages = {
        pages: [
          page([titled(row(5, 5), 'old'), titled(row(4, 4), 'old')], 'c4'),
          page([row(3, 3)]),
        ],
        pageParams: [undefined, 'c4'],
      };
      const titles = (data: LedgerPages) =>
        data.pages.map((each) => each.items.map((item) => item.marketTitle));
      // A new row on top and the held two retitled (an approved supplement): all three as read.
      const merged = mergeLedgerHead(
        before,
        page([row(6, 6), titled(row(5, 5), 'new'), titled(row(4, 4), 'new')], 'c4'),
      );
      expect(ids(merged)).toEqual([['6', '5', '4'], ['3']]);
      expect(titles(merged)[0]).toEqual([undefined, 'new', 'new']);
      expect(merged.pages[0]?.nextCursor).toBe('c4');
      expect(merged.pages[1]).toBe(before.pages[1]);
      // No new row, only the title moved: still a change, and the second merge none.
      const same = page([titled(row(5, 5), 'new'), titled(row(4, 4), 'new')], 'c4');
      const retitled = mergeLedgerHead(before, same);
      expect(retitled).not.toBe(before);
      expect(titles(retitled)).toEqual([['new', 'new'], [undefined]]);
      expect(mergeLedgerHead(retitled, same)).toBe(retitled);
      // A head that is the whole list (no cursor) as well.
      const ended: LedgerPages = {
        pages: [page([titled(row(2, 2), 'old')])],
        pageParams: [undefined],
      };
      expect(titles(mergeLedgerHead(ended, page([titled(row(2, 2), 'new')])))).toEqual([['new']]);
      // Through the cache, as the round writes it (`keepNewerHead` and `replaceEqualDeep`).
      const client = getQueryClient();
      const key = ['ledger', {}, 'account-a'];
      try {
        client.setQueryData(key, before);
        client.setQueryData<LedgerPages>(key, (held) =>
          held === undefined ? undefined : mergeLedgerHead(held, same),
        );
        expect(titles(client.getQueryData<LedgerPages>(key) ?? before)).toEqual([
          ['new', 'new'],
          [undefined],
        ]);
      } finally {
        client.removeQueries({ queryKey: key });
      }
    });

    describe('with `period`, below the head', () => {
      const DAY = 86_400_000;
      const NOW = Date.UTC(2026, 10, 17);
      const at = (id: number, ms: number): LedgerEntry =>
        ({ id: String(id), createdAt: new Date(ms).toISOString() }) as LedgerEntry;
      // '최근 7일', three pages loaded; the head reads r10 (now) down to r8, and more to load.
      const head = page([at(10, NOW), at(9, NOW - 1_000), at(8, NOW - 2_000)], 'c8');
      const loaded = (third: LedgerEntry[]): LedgerPages => ({
        pages: [
          page([at(9, NOW - 1_000), at(8, NOW - 2_000), at(7, NOW - 3_000)], 'c7'),
          page(
            [
              at(6, NOW - 6 * DAY),
              at(5, NOW - 7 * DAY + 3_600_000),
              // Inside the margin under N × 24 hours: kept, the server may still list it.
              at(4, NOW - 7 * DAY - PERIOD_EXPIRY_MARGIN_MS + 1_000),
            ],
            'c4',
          ),
          page(third, 'c1'),
        ],
        pageParams: [undefined, 'c7', 'c4'],
      });
      const aged = [
        at(3, NOW - 7 * DAY - PERIOD_EXPIRY_MARGIN_MS),
        at(2, NOW - 8 * DAY),
        at(1, NOW - 9 * DAY),
      ];

      it('lets go the rows certainly aged out, and the list ends at the last row kept', () => {
        const merged = mergeLedgerHead(loaded(aged), head, '7d');
        expect(ids(merged)).toEqual([
          ['10', '9', '8', '7'],
          ['6', '5', '4'],
        ]);
        expect(merged.pages.map((each) => each.nextCursor)).toEqual(['c7', null]);
        expect(merged.pageParams).toEqual([undefined, 'c7']);
        // A page partly aged out keeps what is left and ends the list.
        const partly = mergeLedgerHead(
          loaded([at(3, NOW - 7 * DAY + 1_000), ...aged.slice(1)]),
          head,
          '7d',
        );
        expect(ids(partly)[2]).toEqual(['3']);
        expect(partly.pages[2]?.nextCursor).toBeNull();
        // Without `period` rows never leave: every page kept.
        expect(ids(mergeLedgerHead(loaded(aged), head))[2]).toEqual(['3', '2', '1']);
        // A '30일' entry keeps them all. An older head (no overlap) adds nothing, and the bound is
        // the held top's (r9, a second older): r3 sits just inside it now, r2 and r1 go.
        expect(ids(mergeLedgerHead(loaded(aged), head, '30d'))[2]).toEqual(['3', '2', '1']);
        const old = page([at(0, NOW - 10 * DAY)], 'c0');
        expect(ids(mergeLedgerHead(loaded(aged), old, '7d'))).toEqual([
          ['9', '8', '7'],
          ['6', '5', '4'],
          ['3'],
        ]);
        // Merging again changes nothing.
        expect(mergeLedgerHead(merged, head, '7d')).toBe(merged);
      });

      it('vouches for the list only when nothing is kept below the head', () => {
        const merged = mergeLedgerHead(loaded(aged), head, '7d');
        // r7..r4 lie below the head's last row: they may have aged out since their read.
        expect(headCoversLedger(merged, head, '7d')).toBe(false);
        expect(headCoversLedger(merged, head, undefined)).toBe(true);
        const whole = page(head.items);
        expect(headCoversLedger(mergeLedgerHead(loaded(aged), whole, '7d'), whole, '7d')).toBe(
          true,
        );
        const within: LedgerPages = {
          pages: [page(head.items.slice(1), 'c8')],
          pageParams: [undefined],
        };
        expect(headCoversLedger(mergeLedgerHead(within, head, '7d'), head, '7d')).toBe(true);
      });

      it('dates an unvouched entry fresh only within the cap from its last whole read', () => {
        const date = (covered: boolean, requestStart: number, heldAt: number, vouchedAt: number) =>
          ledgerHeadDate({ covered, requestStart, heldAt, vouchedAt });
        const T = 1_000_000;
        // Vouched for: when the request left, never before a read that landed meanwhile.
        expect(date(true, T + 5, T, 0)).toBe(T + 5);
        expect(date(true, T, T + 5, 0)).toBe(T + 5);
        // Not vouched for: fresh under the cap, measured from `vouchedAt`, not from `heldAt`.
        expect(date(false, T + PERIOD_REVALIDATE_MS - 1, T + 60_000, T)).toBe(
          T + PERIOD_REVALIDATE_MS - 1,
        );
        expect(date(false, T + PERIOD_REVALIDATE_MS, T + PERIOD_REVALIDATE_MS - 1, T)).toBe(
          T + PERIOD_REVALIDATE_MS - 1,
        );
        expect(PERIOD_REVALIDATE_MS).toBeGreaterThanOrEqual(60_000);
      });
    });
  });

  describe('keepNewerHead', () => {
    const merged = mergeLedgerHead(held, page(rows(63, 44), 'c44'));

    it('keeps the merged rows through a 더 보기 answer built from the pages held before', () => {
      // `fetchNextPage` left from `held` (top 60) and lands after the merge (top 63).
      const late: LedgerPages = {
        pages: [...held.pages, page([], null)],
        pageParams: [...held.pageParams, 'c1'],
      };
      const kept = keepNewerHead(merged, late);
      expect(ids(kept)[0]?.slice(0, 4)).toEqual(['63', '62', '61', '60']);
      expect(kept.pages).toHaveLength(4);
      // A focus refetch from before the merge as well.
      expect(ids(keepNewerHead(merged, held))[0]?.slice(0, 3)).toEqual(['63', '62', '61']);
    });

    it('is the same data for an answer that holds the merged rows', () => {
      const client = getQueryClient();
      const key = ['ledger', {}, 'account-a'];
      try {
        client.setQueryData(key, merged);
        const before = client.getQueryData(key);
        // A full answer equal to what is held: the join and `replaceEqualDeep` keep the reference.
        client.setQueryData(key, structuredClone(merged));
        expect(client.getQueryData(key)).toBe(before);
        expect(keepNewerHead(merged, merged)).toBe(merged);
      } finally {
        client.removeQueries({ queryKey: key });
      }
    });

    it('keeps a late-committed row a late answer lacks, in its place', () => {
      const late = row(12, 10);
      const holding: LedgerPages = {
        pages: [page([row(11, 11), late, row(9, 9)], 'c9'), page([row(8, 8)])],
        pageParams: [undefined, 'c9'],
      };
      // A focus read that left before B committed: B is below its top, still kept.
      const answer: LedgerPages = {
        pages: [page([row(11, 11), row(9, 9)], 'c9'), page([row(8, 8)])],
        pageParams: [undefined, 'c9'],
      };
      expect(ids(keepNewerHead(holding, answer))).toEqual([['11', '12', '9'], ['8']]);
    });

    it('drops an answer older than every held row rather than leave a gap', () => {
      // A round kept the head alone (rows 107, 106); a 더 보기 from the pages before lands.
      const alone: LedgerPages = {
        pages: [page([row(107, 107), row(106, 106)], 'c106')],
        pageParams: [undefined],
      };
      const stale: LedgerPages = {
        pages: [page([row(50, 50)], 'c50'), page([row(49, 49)], 'c49')],
        pageParams: [undefined, 'c50'],
      };
      expect(keepNewerHead(alone, stale)).toBe(alone);
    });

    it('never brings back a row below the answer’s last row: aged out of `period` stays out', () => {
      const answer: LedgerPages = { pages: [page(rows(63, 50))], pageParams: [undefined] };
      expect(keepNewerHead(merged, answer)).toBe(answer);
      // An empty answer is taken as it is: nothing to order by.
      const empty: LedgerPages = { pages: [page([])], pageParams: [undefined] };
      expect(keepNewerHead(merged, empty)).toBe(empty);
      expect(keepNewerHead(undefined, answer)).toBe(answer);
    });

    it('lets head reads land in any order and agree', () => {
      const first = page(rows(62, 43), 'c43');
      const second = page(rows(64, 45), 'c45');
      const ab = mergeLedgerHead(mergeLedgerHead(held, first), second);
      const ba = mergeLedgerHead(mergeLedgerHead(held, second), first);
      expect(ids(ab)).toEqual(ids(ba));
      expect(ids(ab)[0]?.[0]).toBe('64');
    });
  });
});
