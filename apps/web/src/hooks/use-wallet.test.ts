import { readFileSync } from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type LedgerEntry, type Payment, api, isForAnotherAccount } from '@/lib/api';
import { PERIOD_REVALIDATE_MS } from '@/lib/ledger-join';
import { getQueryClient, restartQueries } from '@/lib/query-client';
import { PAYMENT_POLL_INTERVAL_MS, PAYMENT_POLL_LIMIT, paymentsPoll } from '@/lib/payments';
import { ME_QUERY_KEY } from './use-me';
import { MEMBER_CORRECTIONS_KEY } from './use-reconciliation-corrections';
import {
  BALANCE_HISTORY_KEYS,
  CHARGE_PACKAGES_QUERY_KEY,
  balanceHistoryRound,
  LEDGER_QUERY_KEY,
  PAYMENTS_QUERY_KEY,
  isChargeInProgress,
  isCouponRejection,
  isStaleCatalogue,
  ledgerQuery,
  myLedgerKey,
  paymentsRefetchInterval,
  readLedgerHead,
} from './use-wallet';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);

describe('isStaleCatalogue', () => {
  it('refetches on the three rejections that mean the cards are out of date', () => {
    // Re-priced, retired and deleted. Without the refetch the refused card keeps showing the
    // offer the server just rejected and every further click re-sends the same terms.
    expect(isStaleCatalogue(apiError(409, 'PRICE_MOVED'))).toBe(true);
    expect(
      isStaleCatalogue(apiError(404, 'NOT_FOUND', [{ path: ['packageId'], message: 'not found' }])),
    ).toBe(true);
    expect(
      isStaleCatalogue(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['packageId'], message: 'inactive' }]),
      ),
    ).toBe(true);
  });

  it('leaves the cards alone when the catalogue is not the problem', () => {
    // A declined payment is a VALIDATION_ERROR too, but on `amountCoin` — refetching would be
    // pointless, and a refetch that fails swaps the whole card list for the error alert.
    expect(
      isStaleCatalogue(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['amountCoin'], message: 'payment refused' }]),
      ),
    ).toBe(false);
    expect(isStaleCatalogue(apiError(400, 'VALIDATION_ERROR'))).toBe(false);
    // `charge` answers 404 for an account with no balance row too (refused before anything
    // is reserved or charged). That one names no field: the catalogue still lists the
    // package, so refetching it and calling the package unavailable would only invite the
    // same failure again.
    expect(isStaleCatalogue(apiError(404, 'NOT_FOUND'))).toBe(false);
    expect(isStaleCatalogue(apiError(500, 'INTERNAL'))).toBe(false);
    expect(isStaleCatalogue(apiError(401, 'UNAUTHENTICATED'))).toBe(false);
    expect(isStaleCatalogue(new Error('network'))).toBe(false);
    expect(isStaleCatalogue(undefined)).toBe(false);
  });
});

describe('isChargeInProgress', () => {
  it('is true only for the DUPLICATE_REQUEST that names the header', () => {
    // The first request with this key is still running: the key must be kept so the next
    // click collects that purchase instead of opening another one (PLAN 5.4).
    expect(
      isChargeInProgress(
        apiError(409, 'DUPLICATE_REQUEST', [{ path: ['Idempotency-Key'], message: 'in progress' }]),
      ),
    ).toBe(true);
  });

  it('is false for the other 409 and for everything else', () => {
    // Same key, different terms: the key was spent by a different purchase, so a new one is
    // right. Nothing else says anything about the key at all.
    expect(isChargeInProgress(apiError(409, 'DUPLICATE_REQUEST'))).toBe(false);
    expect(isChargeInProgress(apiError(409, 'PRICE_MOVED'))).toBe(false);
    expect(
      isChargeInProgress(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['Idempotency-Key'], message: 'required' }]),
      ),
    ).toBe(false);
    expect(isChargeInProgress(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('isForAnotherAccount', () => {
  it('is true only for the FORBIDDEN that names the account field', () => {
    // The screen showed A, the cookie was B's: the server refused to charge, or redeem for, B.
    expect(
      isForAnotherAccount(
        apiError(403, 'FORBIDDEN', [
          { path: ['expectedAccountId'], message: 'session belongs to another account' },
        ]),
      ),
    ).toBe(true);
  });

  it('is false for the CSRF 403, for other codes and for a transport failure', () => {
    expect(isForAnotherAccount(apiError(403, 'FORBIDDEN'))).toBe(false);
    expect(
      isForAnotherAccount(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['expectedAccountId'], message: 'required' }]),
      ),
    ).toBe(false);
    expect(isForAnotherAccount(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('isCouponRejection', () => {
  it('is true only for the one answer the API gives about the code itself', () => {
    // Unknown, disabled, expired and exhausted are deliberately indistinguishable (A-M2-9)
    // and all arrive as a VALIDATION_ERROR naming `code`.
    expect(
      isCouponRejection(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['code'], message: 'invalid or expired' }]),
      ),
    ).toBe(true);
  });

  it('leaves everything else off the field, where it would call a good code invalid', () => {
    // Its NOT_FOUND means the account has no balance row; a 500, a dead session or an
    // unreachable API say nothing about what the user typed.
    expect(isCouponRejection(apiError(404, 'NOT_FOUND'))).toBe(false);
    expect(isCouponRejection(apiError(500, 'INTERNAL'))).toBe(false);
    expect(isCouponRejection(apiError(401, 'UNAUTHENTICATED'))).toBe(false);
    expect(isCouponRejection(apiError(400, 'VALIDATION_ERROR'))).toBe(false);
    expect(isCouponRejection(new TypeError('Failed to fetch'))).toBe(false);
    // The duplicate is handled on its own branch before this predicate runs.
    expect(isCouponRejection(apiError(409, 'DUPLICATE_REQUEST'))).toBe(false);
  });
});

describe('BALANCE_HISTORY_KEYS', () => {
  it('names ledger, payments and correction history for the reconnect snapshot', async () => {
    // What a resnapshot restarts whole (`PRIVATE_SNAPSHOT_KEYS`): an admin refund moves a payment
    // as well as the balance, and 결제 내역 must not go on saying 완료 beside the ledger. A live
    // `user:balance` goes through `balanceHistoryRound` instead (the round's tests below).
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] };
    const held = [
      LEDGER_QUERY_KEY,
      PAYMENTS_QUERY_KEY,
      MEMBER_CORRECTIONS_KEY,
      ME_QUERY_KEY,
      CHARGE_PACKAGES_QUERY_KEY,
    ];
    for (const key of held) queryClient.setQueryData(key, page);
    try {
      for (const key of BALANCE_HISTORY_KEYS) await restartQueries(queryClient, key);
      const invalidated = held.map((key) => queryClient.getQueryState(key)?.isInvalidated ?? false);
      expect(invalidated).toEqual([true, true, true, false, false]);
    } finally {
      queryClient.clear();
    }
  });
});

describe('myLedgerKey', () => {
  const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

  it("hangs every filter's and every account's entry off ['ledger'], the account last", async () => {
    // `user:balance`'s round finds each entry by this prefix, and the resnapshot's restart
    // (BALANCE_HISTORY_KEYS), a charge's refresh and SessionCacheGuard's reset reach it by it
    // (#69, ADR-0144 결정 2-10).
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] };
    const keys = [
      myLedgerKey({}, 'a'),
      myLedgerKey({ kind: 'BUY_FILL' }, 'a'),
      myLedgerKey({ period: '7d', market: MARKET }, 'a'),
      myLedgerKey({}, 'b'),
    ];
    for (const key of keys) queryClient.setQueryData(key, page);
    try {
      expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(keys.length);
      for (const key of keys) {
        expect(key.slice(0, 1)).toEqual([...LEDGER_QUERY_KEY]);
        expect(key[2]).toBe(key === keys[3] ? 'b' : 'a');
      }
      await restartQueries(queryClient, LEDGER_QUERY_KEY);
      expect(keys.map((key) => queryClient.getQueryState(key)?.isInvalidated)).toEqual([
        true,
        true,
        true,
        true,
      ]);
    } finally {
      queryClient.clear();
    }
  });

  it('keys what is set only, the market lower-cased: the preview reads the tab’s unfiltered entry', () => {
    expect(myLedgerKey({}, 'a')).toEqual(['ledger', {}, 'a']);
    expect(myLedgerKey({ market: MARKET.toUpperCase() }, 'a')).toEqual(
      myLedgerKey({ market: MARKET }, 'a'),
    );
    expect(myLedgerKey({ kind: undefined, period: undefined }, 'a')).toEqual(myLedgerKey({}, 'a'));
  });

  it('asks the API for the filters set, by its own names, and the cursor', () => {
    expect(ledgerQuery({}, undefined)).toEqual({});
    expect(
      ledgerQuery({ kind: 'SELL_FILL', period: '30d', market: MARKET.toUpperCase() }, '1_2'),
    ).toEqual({ kind: 'SELL_FILL', period: '30d', marketId: MARKET, cursor: '1_2' });
  });
});

describe('the balance-history round (#69, ADR-0144 결정 6)', () => {
  const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const row = (id: number): LedgerEntry =>
    ({
      id: String(id),
      createdAt: new Date(Date.UTC(2026, 10, 17, 0, 0, id)).toISOString(),
    }) as LedgerEntry;
  const pagesOf = (...ids: number[][]) => ({
    pages: ids.map((page) => ({ items: page.map(row), nextCursor: null })),
    pageParams: ids.map((_, at) => (at === 0 ? undefined : `c${String(at)}`)),
  });
  const answer = (items: LedgerEntry[]) =>
    vi.spyOn(api, 'GET').mockResolvedValue({
      data: { data: items, meta: { nextCursor: 'next' } },
      response: new Response(null, { status: 200 }),
    } as never);
  type Call = [string, { params: { query: unknown } }];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads one page with the key’s filters and no cursor, and merges it into what is held', async () => {
    const get = answer([row(5), row(4), row(3)]);
    const client = new QueryClient();
    const key = myLedgerKey({ kind: 'BUY_FILL', market: MARKET }, 'a');
    client.setQueryData(key, pagesOf([3, 2], [1]));
    try {
      await readLedgerHead(client, key);
      const calls = get.mock.calls as unknown as Call[];
      expect(calls.map(([route, init]) => [route, init.params.query])).toEqual([
        ['/api/v1/me/ledger', { kind: 'BUY_FILL', marketId: MARKET }],
      ]);
      const held = client.getQueryData<ReturnType<typeof pagesOf>>(key);
      expect(held?.pages.map((page) => page.items.map((item) => item.id))).toEqual([
        ['5', '4', '3', '2'],
        ['1'],
      ]);
      // After a session reset (or a removal) the answer writes nothing and makes no entry.
      client.removeQueries({ queryKey: key });
      await readLedgerHead(client, key);
      expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBeUndefined();
    } finally {
      client.clear();
    }
  });

  it('dates an old `period` entry fresh only when its head vouches for all it keeps', async () => {
    // The head (r5..r3) has more to load, as every head here (`answer`'s cursor).
    answer([row(5), row(4), row(3)]);
    const client = new QueryClient();
    const recent = myLedgerKey({ period: '7d' }, 'a');
    const whole = myLedgerKey({}, 'a');
    const short = myLedgerKey({ period: '30d' }, 'a');
    client.setQueryData(recent, pagesOf([3, 2], [1]), { updatedAt: 1_000 });
    client.setQueryData(whole, pagesOf([3, 2], [1]), { updatedAt: 1_000 });
    client.setQueryData(short, pagesOf([4, 3]), { updatedAt: 1_000 });
    try {
      for (const key of [recent, whole, short]) await readLedgerHead(client, key);
      const ids = (key: readonly unknown[]) =>
        client
          .getQueryData<ReturnType<typeof pagesOf>>(key)
          ?.pages.map((page) => page.items.map((item) => item.id));
      // Merged alike: the head's rows on top, r2 and r1 kept (none has aged out of 7 days).
      expect(ids(recent)).toEqual([['5', '4', '3', '2'], ['1']]);
      expect(ids(whole)).toEqual(ids(recent));
      // '최근 7일' keeps r2 and r1 below the head, which may have left the window since their
      // read, and its last whole read is far past `PERIOD_REVALIDATE_MS`: its date stays, so a
      // focus past `staleTime` reads it whole. Unfiltered, rows never leave; and a period entry
      // holding nothing below the head is vouched for: both fresh.
      expect(client.getQueryState(recent)?.dataUpdatedAt).toBe(1_000);
      expect(client.getQueryState(whole)?.dataUpdatedAt).toBeGreaterThan(1_000);
      expect(client.getQueryState(short)?.dataUpdatedAt).toBeGreaterThan(1_000);
      // The query's own `period` was sent.
      expect(
        (api.GET as unknown as { mock: { calls: Call[] } }).mock.calls.map(
          ([, init]) => init.params.query,
        ),
      ).toEqual([{ period: '7d' }, {}, { period: '30d' }]);
    } finally {
      client.clear();
    }
  });

  it('holds a `period` entry’s date once its last whole read is 5 minutes old', async () => {
    // The head (r5..r3, a cursor) keeps r2 and r1 below it: not vouched for.
    answer([row(5), row(4), row(3)]);
    const now = vi.spyOn(Date, 'now');
    const client = new QueryClient();
    const key = myLedgerKey({ period: '7d' }, 'a');
    const date = () => client.getQueryState(key)?.dataUpdatedAt;
    const at = async (ms: number) => {
      now.mockReturnValue(ms);
      await readLedgerHead(client, key);
    };
    const T = 10_000_000;
    // A whole read landed at T (not this function's write).
    client.setQueryData(key, pagesOf([3, 2], [1]), { updatedAt: T });
    try {
      // Rounds every 10 s under the cap date it fresh: a focus inside `staleTime` reads nothing.
      for (let ms = T + 10_000; ms < T + PERIOD_REVALIDATE_MS; ms += 10_000) {
        await at(ms);
        expect(date()).toBe(ms);
      }
      // Measured from the whole read, not from the last fresh date: past the cap it stays, so the
      // next focus past `staleTime` reads it whole — once per cap, not once per `staleTime`.
      const last = T + PERIOD_REVALIDATE_MS - 10_000;
      await at(T + PERIOD_REVALIDATE_MS);
      expect(date()).toBe(last);
      await at(T + PERIOD_REVALIDATE_MS + 60_000);
      expect(date()).toBe(last);
      // That whole read (another write) starts the cap again.
      const whole = T + PERIOD_REVALIDATE_MS + 90_000;
      client.setQueryData(key, pagesOf([3, 2], [1]), { updatedAt: whole });
      await at(whole + 10_000);
      expect(date()).toBe(whole + 10_000);
      await at(whole + PERIOD_REVALIDATE_MS);
      expect(date()).toBe(whole + 10_000);
    } finally {
      client.clear();
    }
  });

  it('reads each entry on screen by its head, restarts a first read, and marks the rest', async () => {
    const get = answer([row(9), row(8)]);
    const client = new QueryClient();
    const shown = myLedgerKey({}, 'a');
    const filtered = myLedgerKey({ kind: 'SETTLEMENT_PAYOUT' }, 'a');
    const hidden = myLedgerKey({ period: '7d' }, 'a');
    const first = myLedgerKey({ kind: 'SELL_FILL' }, 'a');
    client.setQueryData(shown, pagesOf([8, 7], [6], [5]));
    client.setQueryData(filtered, pagesOf([4]));
    client.setQueryData(hidden, pagesOf([8]));
    // 결제 내역, the correction history and `['me']`, on screen with data as on /my/wallet.
    for (const key of [PAYMENTS_QUERY_KEY, MEMBER_CORRECTIONS_KEY, ME_QUERY_KEY]) {
      client.setQueryData(key, pagesOf([1]));
    }
    const counted = () => vi.fn(() => new Promise<never>(() => undefined));
    const fns = new Map<readonly unknown[], ReturnType<typeof counted>>();
    const observe = (queryKey: readonly unknown[]) => {
      const queryFn = counted();
      fns.set(queryKey, queryFn);
      return new QueryObserver(client, {
        queryKey,
        queryFn,
        staleTime: Number.POSITIVE_INFINITY,
      }).subscribe(() => undefined);
    };
    const stops = [
      shown,
      filtered,
      first,
      PAYMENTS_QUERY_KEY,
      MEMBER_CORRECTIONS_KEY,
      ME_QUERY_KEY,
    ].map(observe);
    const calls = (queryKey: readonly unknown[]) => fns.get(queryKey)?.mock.calls.length;
    try {
      get.mockClear();
      // `first` began its first read on subscribing; only the round's own requests count below.
      for (const queryFn of fns.values()) queryFn.mockClear();
      balanceHistoryRound(client);
      await vi.waitFor(() => {
        expect(
          client.getQueryData<ReturnType<typeof pagesOf>>(shown)?.pages[0]?.items,
        ).toHaveLength(3);
      });
      // One `GET /me/ledger` per entry on screen with data, whatever its loaded pages: 2, not 5.
      const ledgerCalls = (get.mock.calls as unknown as Call[]).filter(
        ([route]) => route === '/api/v1/me/ledger',
      );
      expect(ledgerCalls.map(([, init]) => init.params.query)).toEqual([
        {},
        { kind: 'SETTLEMENT_PAYOUT' },
      ]);
      // The entry not on screen is only marked; it is read whole when mounted again.
      expect(client.getQueryState(hidden)?.isInvalidated).toBe(true);
      expect(client.getQueryState(hidden)?.fetchStatus).toBe('idle');
      // The first read on its way is asked again (restarted): one request of its own fetch.
      expect(calls(first)).toBe(1);
      // A head read never marks the merged entry stale, nor runs the entry's own fetch.
      expect(client.getQueryState(shown)?.isInvalidated).toBe(false);
      expect(calls(shown)).toBe(0);
      expect(calls(filtered)).toBe(0);
      // 결제 내역 and the correction history are restarted, once each; `['me']` is not touched —
      // the figure comes from the event (`storeBalanceEvent`), never from this round.
      expect(calls(PAYMENTS_QUERY_KEY)).toBe(1);
      expect(calls(MEMBER_CORRECTIONS_KEY)).toBe(1);
      expect(calls(ME_QUERY_KEY)).toBe(0);
      expect(client.getQueryState(ME_QUERY_KEY)?.isInvalidated).toBe(false);
    } finally {
      for (const stop of stops) stop();
      client.clear();
    }
  });

  it('reads an entry again in full when its head read failed on the way or with a 5xx', async () => {
    vi.spyOn(api, 'GET').mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new QueryClient();
    const shown = myLedgerKey({}, 'a');
    client.setQueryData(shown, pagesOf([8]));
    const full = vi.fn(() => new Promise<never>(() => undefined));
    const stop = new QueryObserver(client, {
      queryKey: shown,
      queryFn: full,
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => undefined);
    try {
      balanceHistoryRound(client);
      // The query's own fetch (and `retry`), as every event did before: the round's update is
      // not left missing until a focus.
      await vi.waitFor(() => {
        expect(full).toHaveBeenCalledTimes(1);
      });
      expect(client.getQueryState(shown)?.fetchStatus).toBe('fetching');
      expect(client.getQueryData<ReturnType<typeof pagesOf>>(shown)?.pages[0]?.items).toHaveLength(
        1,
      );
    } finally {
      stop();
      client.clear();
    }
  });

  it('reads an entry a 4xx refused once more, unretried, and says so if refused again', async () => {
    const refused = apiError(429, 'RATE_LIMITED');
    vi.spyOn(api, 'GET').mockResolvedValue({
      error: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
      response: new Response(null, { status: 429 }),
    } as never);
    // The app's own client: its `retry` never retries a 4xx (query-client.ts).
    const client = getQueryClient();
    const shown = myLedgerKey({}, 'a');
    client.setQueryData(shown, pagesOf([8]));
    const full = vi.fn(() => Promise.reject(refused));
    const observer = new QueryObserver(client, {
      queryKey: shown,
      queryFn: full,
      staleTime: Number.POSITIVE_INFINITY,
    });
    const stop = observer.subscribe(() => undefined);
    try {
      balanceHistoryRound(client);
      // One request of the query's own fetch, and no retry: a refresh that failed over the rows
      // kept, which the list draws as `ledger-stale` with 다시 시도 — never a silent row short.
      await vi.waitFor(() => {
        expect(observer.getCurrentResult().isRefetchError).toBe(true);
      });
      expect(full).toHaveBeenCalledTimes(1);
      expect(observer.getCurrentResult().error).toBe(refused);
      expect(client.getQueryData<ReturnType<typeof pagesOf>>(shown)?.pages[0]?.items).toHaveLength(
        1,
      );
    } finally {
      stop();
      client.clear();
    }
  });

  it('restarts a first read alone, never the filtered entries its key is a prefix of', async () => {
    const get = answer([row(9), row(4)]);
    const client = new QueryClient();
    const first = myLedgerKey({}, 'a');
    const filtered = myLedgerKey({ kind: 'SETTLEMENT_PAYOUT' }, 'a');
    client.setQueryData(filtered, pagesOf([4]));
    const full = vi.fn(() => new Promise<never>(() => undefined));
    const observe = (queryKey: readonly unknown[]) =>
      new QueryObserver(client, {
        queryKey,
        queryFn: full,
        staleTime: Number.POSITIVE_INFINITY,
      }).subscribe(() => undefined);
    const stops = [observe(first), observe(filtered)];
    try {
      full.mockClear();
      get.mockClear();
      balanceHistoryRound(client);
      await vi.waitFor(() => {
        expect(
          client.getQueryData<ReturnType<typeof pagesOf>>(filtered)?.pages[0]?.items,
        ).toHaveLength(2);
      });
      // The unfiltered first read is asked again; the filtered entry gets its head read only.
      expect(full).toHaveBeenCalledTimes(1);
      expect(client.getQueryState(first)?.fetchStatus).toBe('fetching');
      expect(client.getQueryState(filtered)?.fetchStatus).toBe('idle');
      expect((get.mock.calls as unknown as Call[]).map(([, init]) => init.params.query)).toEqual([
        { kind: 'SETTLEMENT_PAYOUT' },
      ]);
    } finally {
      for (const stop of stops) stop();
      client.clear();
    }
  });
});

describe('paymentsRefetchInterval', () => {
  const row = (id: string, status: Payment['status']): Payment => ({
    id,
    amountCoin: '10000',
    priceKrw: 9900,
    packageId: null,
    provider: 'mock',
    providerRef: 'mock_0123456789',
    status,
    method: null,
    approvedAt: '2026-09-20T03:00:00.000Z',
    refundedAt: null,
    resultMessage: null,
    cancelConfirmed: null,
    createdAt: '2026-09-20T02:59:00.000Z',
  });
  const older = row('00000000-0000-4000-8000-0000000000c1', 'succeeded');
  const refunding = row('00000000-0000-4000-8000-0000000000c2', 'refunding');

  it("polls 결제 내역 over every loaded page while a row is in flight, by the query's count", () => {
    const queryClient = new QueryClient();
    const interval = paymentsRefetchInterval(paymentsPoll());
    // The cache's own query object, as query-core hands it to `refetchInterval` (typed by the
    // key alone here, so its data is narrowed to what `usePayments` stores under it).
    const query = () => {
      const found = queryClient.getQueryCache().find({ queryKey: PAYMENTS_QUERY_KEY, exact: true });
      if (!found) throw new Error('no payments query');
      return found as Parameters<typeof interval>[0];
    };
    try {
      // The refund under way sits on the second loaded page.
      queryClient.setQueryData(PAYMENTS_QUERY_KEY, {
        pages: [
          { items: [older], nextCursor: 'c1' },
          { items: [refunding], nextCursor: null },
        ],
        pageParams: [undefined, 'c1'],
      });
      expect(interval(query())).toBe(PAYMENT_POLL_INTERVAL_MS);
      // The finish landed (환불됨): nothing left to wait on.
      queryClient.setQueryData(PAYMENTS_QUERY_KEY, {
        pages: [
          { items: [older], nextCursor: 'c1' },
          { items: [{ ...refunding, status: 'refunded' }], nextCursor: null },
        ],
        pageParams: [undefined, 'c1'],
      });
      expect(interval(query())).toBe(false);
    } finally {
      queryClient.clear();
    }
    // Nothing loaded yet: nothing to wait on.
    expect(interval({ state: { data: undefined, dataUpdateCount: 0, errorUpdateCount: 0 } })).toBe(
      false,
    );
  });

  it('spends the budget on failed fetches too: a list that keeps failing stops polling', async () => {
    // A 401 once the session expired is never retried; neither is anything here.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const interval = paymentsRefetchInterval(paymentsPoll());
    const query = () => {
      const found = queryClient.getQueryCache().find({ queryKey: PAYMENTS_QUERY_KEY, exact: true });
      if (!found) throw new Error('no payments query');
      return found as Parameters<typeof interval>[0];
    };
    const refetchFails = () =>
      queryClient.prefetchInfiniteQuery({
        queryKey: PAYMENTS_QUERY_KEY,
        queryFn: () => Promise.reject(apiError(401, 'UNAUTHENTICATED')),
        initialPageParam: undefined as string | undefined,
      });
    try {
      queryClient.setQueryData(PAYMENTS_QUERY_KEY, {
        pages: [{ items: [refunding], nextCursor: null }],
        pageParams: [undefined],
      });
      expect(interval(query())).toBe(PAYMENT_POLL_INTERVAL_MS);
      for (let fetch = 1; fetch < PAYMENT_POLL_LIMIT; fetch += 1) await refetchFails();
      // The rows stay what the list last loaded, and query-core counts no failure as data.
      expect(query().state).toMatchObject({
        status: 'error',
        dataUpdateCount: 1,
        errorUpdateCount: PAYMENT_POLL_LIMIT - 1,
      });
      expect(interval(query())).toBe(PAYMENT_POLL_INTERVAL_MS);
      await refetchFails();
      expect(interval(query())).toBe(false);
    } finally {
      queryClient.clear();
    }
  });
});

describe('the account a charge and a redemption name (ADR-0091)', () => {
  it('is the one the wallet was drawn for, never the session’s, and the coupon field is keyed by it', () => {
    // In the render between the session naming B and SessionCacheGuard's reset the wallet still
    // shows A's balance, and a body naming the session's account would be taken with B's cookie: B
    // charged for a package bought on A's screen (its Idempotency-Key filed under B), or the code
    // typed there spent for B. No component renders under node, so the wiring is pinned in the
    // sources: the hooks offer no account (no session id, no `ready`), the charge's keys are filed
    // under the account the click names, and both cards read the wallet's `Me` — the balance
    // card's `['me']` — and send its id. The coupon field is keyed by it as well: `['me']` can turn
    // to B in place before the session does, and an unkeyed field would keep the code typed for A,
    // 등록 on, now naming B. Paid Coin is closed (ADR-0049), so no e2e can reach these cards.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    const hooks = source('./use-wallet.ts');
    expect(hooks).not.toMatch(/user\.id/);
    const hook = (name: string) => {
      const start = hooks.indexOf(`export function ${name}()`);
      expect(start).toBeGreaterThan(-1);
      return hooks.slice(start, hooks.indexOf('\n}\n', start));
    };
    const charge = hook('useCharge');
    expect(charge).not.toMatch(/\baccountId\b|\bready\b/);
    expect(charge).toContain('mutationFn: async ({ pack, expectedAccountId }: ChargeRequest) =>');
    expect(charge).toContain('const keys = keysFor(expectedAccountId);');
    expect(hook('useRedeemCoupon')).not.toMatch(/\baccountId\b|\bready\b/);

    const chargeForm = source('../app/my/wallet/charge-form.tsx');
    expect(chargeForm).toContain('const accountId = useMe().data?.id;');
    expect(chargeForm).toContain('if (accountId !== undefined) void buy(pack, accountId);');
    expect(chargeForm).toContain('charge.mutateAsync({ pack, expectedAccountId })');
    expect(chargeForm).not.toMatch(/\bcharge\.(accountId|ready)\b/);

    const couponForm = source('../app/my/wallet/coupon-form.tsx');
    expect(couponForm).toContain('const accountId = useMe().data?.id;');
    expect(couponForm).toContain("<CouponFields key={accountId ?? ''} accountId={accountId} />");
    expect(couponForm).toContain('redeem.mutateAsync({ code, expectedAccountId: accountId })');
    expect(couponForm).not.toMatch(/\bredeem\.(accountId|ready)\b/);
  });
});
