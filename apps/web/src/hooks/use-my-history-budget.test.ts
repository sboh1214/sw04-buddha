import { readFileSync } from 'node:fs';
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Order, api } from '@/lib/api';
import {
  ORDERS_KEY,
  myFillHistoryKey,
  myOrderHistoryKey,
  myOrderKey,
  myOrdersLiveKey,
} from '@/lib/market-keys';
import {
  ORDER_HISTORY_INVALIDATE_MS,
  RoundWindow,
  ownHistoryQuery,
  positionRestartsOrder,
} from '@/lib/market-live';
import { NOTIFICATION_REFRESH_MS } from '@/lib/notifications';
import type { CursorPage } from '@/lib/order-join';
import { restartQueries } from '@/lib/query-client';
import { orderHistoryQueryOptions } from './use-my-history';

/**
 * /my/history's request budget on its account's fills (#301, ADR-0148): one tab at most 50 a
 * minute (the address's bucket is 100, a 429 is not retried). Measured for #124, a fill re-read
 * every loaded page of the list on screen — 'pages × fills a minute', 36 at 3 pages and 12 fills —
 * so the bound here is built from the window alone and must not depend on the fill rate.
 *
 * What makes the arithmetic the code's: `positionRestartsOrder` leaves the history lists on
 * screen out of the fill's `ORDERS_KEY` restart (driven below through a real client), the round
 * restarts exactly the account's history lists (`ownHistoryQuery`), and the provider holds one
 * `RoundWindow` of `ORDER_HISTORY_INVALIDATE_MS` for it (the source guard below; the window's own
 * steps are market-live.test.ts's, and this file drives the same class on a virtual clock).
 *
 * The bound counts one more window. The unread notification count beside MY (#53, ADR-0157) is in
 * the header on this page too, and its own window (`NOTIFICATION_REFRESH_MS`, owner answer 53-9)
 * reads it again on `user:notification`, 3 rounds a minute at most — once #134 ships, a resting
 * order's every later fill publishes one. So the steady state is 7 × K + 3, which moved the
 * documented limit from 7 loaded pages to 6 (ADR-0148 '일부 대체됨'). use-wallet-budget.test.ts
 * pins the provider's wiring of that window; on /my/notifications a round reads the count and
 * every loaded page of the list (use-notifications.test.ts).
 */
const MINUTE = 60_000;
const ACCOUNT = 'a1e1c0de-0000-4000-8000-000000000001';
const OTHER = 'b2e1c0de-0000-4000-8000-000000000002';
const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The most rounds a leading-and-trailing window of `ms` runs in any closed 60 s window. */
const roundsPerMinute = (ms: number) => Math.floor(MINUTE / ms) + 1;

/** The provider's `refreshOrderHistory` on a virtual clock: the times its rounds ran at. */
function rounds(events: readonly number[]): number[] {
  const gate = new RoundWindow(ORDER_HISTORY_INVALIDATE_MS);
  let pendingAt: number | null = null;
  const ran: number[] = [];
  const take = (now: number, step: ReturnType<RoundWindow['offer']>) => {
    if (step === null) return;
    if (step === 'run') ran.push(now);
    else pendingAt = now + step.wait;
  };
  let next = 0;
  while (next < events.length || pendingAt !== null) {
    const event = events[next] ?? Number.POSITIVE_INFINITY;
    if (pendingAt !== null && pendingAt <= event) {
      const at = pendingAt;
      pendingAt = null;
      take(at, gate.fired(at));
    } else {
      take(event, gate.offer(event));
      next += 1;
    }
  }
  return ran;
}

const busiestMinute = (ran: readonly number[]) =>
  Math.max(
    0,
    ...ran.map((start) => ran.filter((at) => at >= start && at <= start + MINUTE).length),
  );

describe('/my/history in budget on fills (#301, ADR-0148)', () => {
  it('re-reads at most 7 rounds a minute, whatever the fill rate', () => {
    expect(ORDER_HISTORY_INVALIDATE_MS).toBe(10_000);
    expect(roundsPerMinute(ORDER_HISTORY_INVALIDATE_MS)).toBe(7);
    // 12 and 30 fills a minute (#301's acceptance), and one a second.
    for (const gap of [5_000, 2_000, 1_000]) {
      const fills = Array.from({ length: (2 * MINUTE) / gap + 1 }, (_, at) => at * gap);
      const ran = rounds(fills);
      expect(busiestMinute(ran), `every ${String(gap)} ms`).toBeLessThanOrEqual(7);
      // No fill is left unread: each has a round at or after it, within the window.
      expect(
        fills.every((at) => ran.some((round) => round >= at && round <= at + 10_000)),
        `every ${String(gap)} ms`,
      ).toBe(true);
    }
    // A lone fill is read at once.
    expect(rounds([0])).toEqual([0]);
  });

  it('stays at 50 up to 6 loaded pages — the documented limit (ADR-0157)', () => {
    // One list on screen at a time (주문 or 체결); each round reads every page it has loaded.
    const list = (pages: number) => roundsPerMinute(ORDER_HISTORY_INVALIDATE_MS) * pages;
    // And the unread count beside MY (#53): its own window's rounds, whatever the pages.
    expect(NOTIFICATION_REFRESH_MS).toBe(30_000);
    const notificationRounds = roundsPerMinute(NOTIFICATION_REFRESH_MS);
    expect(notificationRounds).toBe(3);
    const steady = (pages: number) => list(pages) + notificationRounds;
    // Measured for #124 at 3 pages and 12 fills a minute: 36 before; at most 21 after (#301).
    expect(list(3)).toBe(21);
    expect(list(5)).toBe(35);
    // ADR-0148's limit, the list's window alone: 7 pages (49), 8 past 50.
    expect(list(7)).toBeLessThanOrEqual(50);
    expect(list(8)).toBeGreaterThan(50);
    // With the count's rounds: 6 pages (45); 7 pages, 121 rows or more, can pass 50 (52).
    expect(steady(6)).toBe(45);
    expect(steady(7)).toBe(52);
    // Under the address's 100 up to 13 pages (14 before #53).
    expect(steady(13)).toBeLessThanOrEqual(100);
    expect(steady(14)).toBeGreaterThan(100);
    // Before #301 the same pages cost 'pages × fills', past 50 from 3 pages at 17 fills a minute.
    expect(3 * 17).toBeGreaterThan(50);
    // Measured 2026-11-20 on this code, before #53 (ADR-0148 결과 2): the steady list reads of the
    // three history targets, at 3 and 5 pages × 12 and 30 own fills a minute — within 7 × K, and
    // not growing with the fill rate.
    const measuredSteady = {
      '3x12': [18, 18, 18],
      '5x12': [30, 30, 30],
      '3x30': [15, 18, 15],
      '5x30': [30, 30, 25],
    } as const;
    for (const [run, reads] of Object.entries(measuredSteady)) {
      const pages = Number(run.split('x')[0]);
      for (const read of reads) expect(read, run).toBeLessThanOrEqual(list(pages));
    }
    const decisions = readFileSync(
      new URL('../../../../docs/DECISIONS.md', import.meta.url),
      'utf8',
    );
    const adr0148 = decisions.slice(decisions.indexOf('\n## ADR-0148 '));
    expect(adr0148).toMatch(/\| 3쪽 × 12건 +\| 23\/18\/23\/19 +\|/);
    expect(adr0148).not.toContain('[측정 전]');
  });

  it('leaves the lists on screen to the window, and the round reads each loaded page once', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pageOf = (n: number): CursorPage<Order> => ({
      items: [{ id: `o${String(n)}` } as Order],
      nextCursor: n < 3 ? `cursor-${String(n + 1)}` : null,
    });
    const get = vi.spyOn(api, 'GET').mockImplementation(((
      _path: string,
      init: { params: { query: { cursor?: string } } },
    ) => {
      const n =
        init.params.query.cursor === undefined ? 1 : Number(init.params.query.cursor.slice(7));
      return Promise.resolve({
        data: { data: pageOf(n).items, meta: { nextCursor: pageOf(n).nextCursor } },
        response: new Response(null),
      });
    }) as never);
    // A filtered list on screen, with the MY summary's unfiltered preview and a market-only
    // entry of the same list still cached: both are key prefixes of it (codex review).
    const options = orderHistoryQueryOptions({ market: MARKET, period: '7d' }, ACCOUNT, {
      user: {},
    });
    const empty = { pages: [], pageParams: [] };
    client.setQueryData(myOrderHistoryKey({}, ACCOUNT), empty);
    client.setQueryData(myOrderHistoryKey({ market: MARKET }, ACCOUNT), empty);
    const observer = new InfiniteQueryObserver(client, options);
    const leave = observer.subscribe(() => undefined);
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
      await observer.fetchNextPage();
      await observer.fetchNextPage();
      expect(observer.getCurrentResult().data?.pages).toHaveLength(3);
      // Another account's list and a live list sit beside it.
      client.setQueryData(myFillHistoryKey({}, OTHER), { pages: [], pageParams: [] });
      client.setQueryData(myOrdersLiveKey(ACCOUNT), { pages: [], pageParams: [] });
      get.mockClear();

      // A fill's `user:position`: the `ORDERS_KEY` restart leaves the list on screen alone.
      await restartQueries(client, ORDERS_KEY, positionRestartsOrder);
      expect(get).not.toHaveBeenCalled();
      expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(false);

      // The window's round: this account's history lists, once each — the list on screen reads
      // each loaded page once, however many broader entries of it are cached.
      const own = ownHistoryQuery(ACCOUNT);
      const matched = client
        .getQueryCache()
        .findAll({ queryKey: ORDERS_KEY, predicate: own })
        .map((query) => query.queryKey);
      expect(matched).toHaveLength(3);
      expect(matched).toContainEqual(options.queryKey);
      expect(own({ queryKey: myFillHistoryKey({}, OTHER) })).toBe(false);
      expect(own({ queryKey: myOrdersLiveKey(ACCOUNT) })).toBe(false);
      expect(ownHistoryQuery(OTHER)({ queryKey: myFillHistoryKey({}, OTHER) })).toBe(true);
      expect(ownHistoryQuery(undefined)({ queryKey: myOrderHistoryKey({}, ACCOUNT) })).toBe(false);
      // As the provider fires it: not awaited.
      void restartQueries(client, ORDERS_KEY, own);
      await vi.waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(false));
      expect(get).toHaveBeenCalledTimes(3);
      expect(get.mock.calls.map((call) => call[0])).toEqual([
        '/api/v1/me/orders',
        '/api/v1/me/orders',
        '/api/v1/me/orders',
      ]);
      // A restart per key, which this replaced, read the list on screen once per key prefix of
      // it: three times.
      get.mockClear();
      for (const key of matched) void restartQueries(client, key);
      await vi.waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(false));
      expect(get.mock.calls.length).toBeGreaterThan(3);
    } finally {
      leave();
      client.clear();
    }
  });

  it('is wired into user:position, the resnapshot and the teardown', () => {
    const provider = readFileSync(
      new URL('../components/realtime/realtime-provider.tsx', import.meta.url),
      'utf8',
    );
    expect(provider).toContain(
      'const orderHistory = new RoundWindow(ORDER_HISTORY_INVALIDATE_MS);',
    );
    const positionAt = provider.indexOf("'user:position': (raw: unknown) => {");
    const position = provider.slice(
      positionAt,
      // `user:notification` (#53) follows it, the last handler.
      provider.indexOf("'user:notification': (raw: unknown) => {"),
    );
    // Inside the fill's branch, beside the `ORDERS_KEY` restart that now leaves the lists out.
    expect(position).toMatch(
      /if \(wroteAnOrder\(event\)\) \{\s*void restartQueries\(queryClient, ORDERS_KEY, positionRestartsOrder\);[\s\S]*?refreshOrderHistory\(\);\s*\}/,
    );
    expect(position.match(/refreshOrderHistory\(/g)).toHaveLength(1);
    // The round: the account's history lists, by the session's identity.
    const refreshAt = provider.indexOf('const refreshOrderHistory = (fired = false) => {');
    const refresh = provider.slice(refreshAt, provider.indexOf('\n    };', refreshAt));
    expect(refresh).toContain('fired ? orderHistory.fired(now) : orderHistory.offer(now)');
    expect(refresh).toContain(
      'void restartQueries(queryClient, ORDERS_KEY, ownHistoryQuery(identity ?? undefined));',
    );
    expect(refresh.match(/restartQueries\(/g)).toHaveLength(1);
    expect(refresh).toContain('refreshOrderHistory(true);');
    // A resnapshot read the lists whole; the teardown leaves no timer for a socket that is gone.
    const resnapshotAt = provider.indexOf('const resnapshot = () => {');
    expect(provider.slice(resnapshotAt, provider.indexOf('\n    };', resnapshotAt))).toContain(
      'cancelOrderHistory();',
    );
    const teardown = provider.slice(provider.lastIndexOf('    return () => {'));
    expect(teardown).toContain('cancelOrderHistory();');
    expect(provider.match(/orderHistoryPending = /g)).toHaveLength(3);
    // The detail of an order a fill wrote is still read at once (not a history list).
    expect(
      positionRestartsOrder({ queryKey: myOrderKey('o1', ACCOUNT), isActive: () => true }),
    ).toBe(true);
    expect(
      positionRestartsOrder({ queryKey: myOrderHistoryKey({}, ACCOUNT), isActive: () => true }),
    ).toBe(false);
  });
});
