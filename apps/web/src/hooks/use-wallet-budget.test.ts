import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PERIOD_REVALIDATE_MS } from '@/lib/ledger-join';
import { BALANCE_HISTORY_INVALIDATE_MS, OWN_ORDERS_INVALIDATE_MS } from '@/lib/market-live';
import { NOTIFICATION_REFRESH_MS } from '@/lib/notifications';
import { getQueryClient } from '@/lib/query-client';

/**
 * /my/wallet's request budget (#69, ADR-0144 결정 6): one tab at most 50 a minute (the address's
 * bucket is 100, a 429 is not retried). Measured 2026-11-17, the steady 78 was spent per own fill —
 * every loaded ledger page, the corrections, the live orders and `GET /me` on each — so the bound
 * here is built from the windows alone and must not depend on the fill rate, the rooms or filters.
 *
 * The bound is arithmetic over the windows; what makes it the code's is the rest of this file:
 * the handlers that fire per event may reach only the windows and keys never on screen on
 * /my/wallet (the source guard below), and each window's own cost is tested where it lives — the
 * round's one head read per entry (use-wallet.test.ts), at most 7 rounds in any 60 s window
 * (market-live.test.ts, driving the provider's own `RoundWindow`), `positionRestartsOrder` and
 * `walletMissesMarket` (market-live.test.ts), the buy-id comparison (wallet.test.ts). The
 * node environment mounts no provider or socket; the measurement (ADR-0144 결과 2) is the check
 * of the whole.
 *
 * #53 (ADR-0157) put the unread notification count beside MY on every page, the wallet included,
 * and it is read again on `user:notification` through its own window (owner answer 53-9: 30 s) —
 * once #134 ships, a resting order's every later fill publishes one, so the bound must count that
 * window too, not only the count's first read. It lowered the wallet's entry limit from 9 ledger
 * pages to 5 (ADR-0144 '일부 대체됨').
 */
const MINUTE = 60_000;

/** The most rounds a leading-and-trailing window of `ms` runs in any closed 60 s window. */
const roundsPerMinute = (ms: number) => Math.floor(MINUTE / ms) + 1;

/** The corrections history the wallet holds: one page. */
const CORRECTION_PAGES = 1;

function bounds(ledgerPages: number) {
  const history = roundsPerMinute(BALANCE_HISTORY_INVALIDATE_MS);
  const book = roundsPerMinute(OWN_ORDERS_INVALIDATE_MS);
  const notifications = roundsPerMinute(NOTIFICATION_REFRESH_MS);
  // A round: one ledger head per entry on screen, and the corrections restarted. A book round: the
  // wallet's live orders (one page) — also the round a fill in a market the wallet does not hold
  // asks for (`walletMissesMarket`), in the same window, so it adds none. `GET /me`: once per
  // round whose buy ids changed, and once more when `storeBalanceEvent` cancelled that read
  // (`refreshLockedBalance`). A notification round (#53): the unread count beside MY, the one
  // query of the inbox on screen here — the list is not on the wallet, so it is only marked stale.
  const steady = history * (1 + CORRECTION_PAGES) + book * 1 + 2 * book + notifications;
  // Entry, reconnect, or a focus after 30 s with nothing read (`staleTime`): the session's read,
  // `GET /me`, every loaded ledger page, the corrections and the live orders — and the watch's
  // `GET /me` when that live read, outside the book rounds, finds other buy ids (the member's
  // own order or cancel across the drop), with its one retry; on entry, the first `GET /me` a
  // `user:balance` asked again (`storeBalanceEvent`) at most. And the unread count's first read,
  // or a reconnect's (`NOTIFICATIONS_KEY` is a resnapshot key) — never a focus's: its `staleTime`
  // is infinite (53-1 '폴링 없음').
  const entry = steady + 1 + (1 + ledgerPages + CORRECTION_PAGES + 1) + 2 + 1;
  return { steady, entry };
}

const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The code of `text`, its `//` comments taken out. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

/** Every call in `text` that asks a query again, as written. */
const reads = (text: string) =>
  [
    ...text.matchAll(
      /\b(restartQueries|invalidateQueries|refetchQueries|resetQueries|fetchQuery|fetchInfiniteQuery|prefetchQuery|cancelFirstFetch|replaceAndRefetch)\(([^;]*?)\);/g,
    ),
  ].map((match) => `${match[1] ?? ''}(${(match[2] ?? '').replace(/\s+/g, ' ').trim()})`);

describe('/my/wallet in budget (#69, ADR-0144 결정 6)', () => {
  it('stays at 38 a minute in the steady state, whatever the fills, notifications, rooms or filters', () => {
    expect(BALANCE_HISTORY_INVALIDATE_MS).toBe(10_000);
    expect(OWN_ORDERS_INVALIDATE_MS).toBe(10_000);
    expect(roundsPerMinute(BALANCE_HISTORY_INVALIDATE_MS)).toBe(7);
    // The notification window (#53, owner answer 53-9): 30 s, 3 rounds a minute.
    expect(NOTIFICATION_REFRESH_MS).toBe(30_000);
    expect(roundsPerMinute(NOTIFICATION_REFRESH_MS)).toBe(3);
    // 35 before #53 (ADR-0144 결정 6), and the count's 3 rounds.
    expect(bounds(3).steady).toBe(38);
  });

  it('stays at 50 on entry, reconnect and focus up to 5 ledger pages — the documented limit (ADR-0157)', () => {
    for (let pages = 1; pages <= 5; pages += 1) {
      expect(bounds(pages).entry, `L = ${String(pages)}`).toBeLessThanOrEqual(50);
    }
    // Past it one such window can pass 50 (ADR-0144 결과 4; 9 pages before #53's window, which
    // owner answer 53-9 chose knowing it); under the address's 100 up to 55.
    expect(bounds(6).entry).toBeGreaterThan(50);
    expect(bounds(55).entry).toBeLessThanOrEqual(100);
    expect(bounds(56).entry).toBeGreaterThan(100);
    // The measured run loaded 3 pages: entry, reconnect and focus at most 48 (44 before #53).
    expect(bounds(3).entry).toBe(48);
    // The other windows the owner was offered (ADR-0157): 10 s would leave 1 page, 60 s 6.
    const entryAt = (windowMs: number, pages: number) =>
      bounds(pages).entry - roundsPerMinute(NOTIFICATION_REFRESH_MS) + roundsPerMinute(windowMs);
    expect(entryAt(10_000, 1)).toBeLessThanOrEqual(50);
    expect(entryAt(10_000, 2)).toBeGreaterThan(50);
    expect(entryAt(60_000, 6)).toBeLessThanOrEqual(50);
    expect(entryAt(60_000, 7)).toBeGreaterThan(50);
  });

  it('keeps repeated focuses during fills at 50 up to 5 pages, whatever the period', () => {
    // While fills go on the rounds keep the corrections, the live orders and `GET /me` fresh, so a
    // focus costs the session's read — counted one a `staleTime`, 3 in a closed minute (better-auth
    // reads on focus up to once in 5 s; focusing more often than this is outside the bound, as it
    // was before). A `period` entry holding rows below its head adds its L pages only when its
    // head reads stop dating it (`ledgerHeadDate`): `PERIOD_REVALIDATE_MS` after the last whole
    // read, so two such reads lie that far apart (use-wallet.test.ts drives `readLedgerHead`).
    const staleTime = getQueryClient().getDefaultOptions().queries?.staleTime;
    expect(staleTime).toBe(30_000);
    const focuses = roundsPerMinute(staleTime as number);
    const wholeReads = (apart: number) => (apart > MINUTE ? 1 : roundsPerMinute(apart));
    expect(focuses).toBe(3);
    expect(wholeReads(PERIOD_REVALIDATE_MS)).toBe(1);
    // A focus reads no unread count (`staleTime: Infinity`); its rounds are in `steady`.
    for (let pages = 1; pages <= 5; pages += 1) {
      const { steady } = bounds(pages);
      const focused = steady + focuses + wholeReads(PERIOD_REVALIDATE_MS) * pages;
      expect(focused, `L = ${String(pages)}`).toBeLessThanOrEqual(50);
    }
    // Held at every head read instead, each focus past `staleTime` reads the entry whole: 50 is
    // passed from 4 pages (38 + 3 × (1 + L)).
    expect(bounds(3).steady + focuses * (1 + 3)).toBeLessThanOrEqual(50);
    expect(bounds(4).steady + focuses * (1 + 4)).toBeGreaterThan(50);
    // Off screen, a fill only marks the wallet's live orders stale (`positionRestartsOrder`): the
    // remount reads them once, a read the entry bound already counts.
  });

  it('spends nothing per fill: the handlers reach only the windows and keys off the wallet', () => {
    const provider = src('../components/realtime/realtime-provider.tsx');
    const balanceAt = provider.indexOf("'user:balance': (raw: unknown) => {");
    const positionAt = provider.indexOf("'user:position': (raw: unknown) => {");
    // `user:notification` (#53) is the last handler; it reads through its own window (below).
    const endAt = provider.indexOf("'user:notification': (raw: unknown) => {");
    expect([balanceAt, positionAt, endAt].every((at) => at > 0)).toBe(true);
    expect(balanceAt < positionAt && positionAt < endAt).toBe(true);
    // `user:balance`: the history window and the figure, and no other read of any query.
    const balance = code(provider.slice(balanceAt, positionAt));
    expect(balance).toContain('refreshBalanceHistory();');
    expect(balance).toContain('storeBalanceEvent(queryClient, parsed.data);');
    expect(reads(balance)).toEqual([]);
    expect(balance).not.toMatch(/\bapi\.|BALANCE_HISTORY_KEYS|ME_QUERY_KEY|MEMBER_CORRECTIONS/);
    // `user:position`: exactly these reads — the orders bar the wallet's live entry on screen (off
    // screen it is only marked stale, no request), and keys /my/wallet never shows (the market,
    // its sellable figure, the settlement lists, the positions lists). A new one here is a new
    // per-fill cost: weigh it against the budget. The wallet's entry on screen, for a market it
    // does not hold, only through the book round's window. MY's holdings chunks naming a market
    // bought back from 0 (#300, ADR-0147) are keys /my/wallet never shows either.
    const position = code(provider.slice(positionAt, endAt));
    expect(reads(position).sort()).toEqual(
      [
        'restartQueries(queryClient, ORDERS_KEY, positionRestartsOrder)',
        'restartQueries(queryClient, key)',
        'restartQueries(queryClient, query.queryKey, sameChunk(query))',
        'restartQueries(queryClient, marketSellableKey(event.marketId))',
        'restartQueries(queryClient, queryKey)',
      ].sort(),
    );
    expect(position).toContain('ownSettlementKeys(queryClient, identity ?? undefined)');
    expect(position).toContain('for (const queryKey of refetchKeys) void restartQueries');
    expect(position).toMatch(
      /if \(walletMissesMarket\(queryClient, event\.marketId, identity\)\) \{\s*refreshOwnOrders\(event\.marketId\);\s*\}/,
    );
    expect(position.match(/refreshOwnOrders\(/g)).toHaveLength(1);
    expect(position).toMatch(/findAll\(\{ queryKey: POSITIONS_KEY \}\)/);
    expect(position).not.toMatch(
      /\bapi\.|ME_QUERY_KEY|MEMBER_CORRECTIONS|LEDGER|storeBalanceEvent/,
    );
    // The window is leading and trailing, per connection, and torn down with the socket. Its
    // steps are `RoundWindow`'s, which market-live.test.ts drives; the provider only does them:
    // a round on 'run', nothing on null, else one timer that reports `fired` — and a timer it
    // cancels (a resnapshot, the teardown) it tells the window of, or every later event waits on
    // a round that never comes.
    expect(provider).toContain(
      'const balanceHistory = new RoundWindow(BALANCE_HISTORY_INVALIDATE_MS);',
    );
    const refreshAt = provider.indexOf('const refreshBalanceHistory = (fired = false) => {');
    const refresh = code(provider.slice(refreshAt, provider.indexOf('\n    };', refreshAt)));
    expect(refreshAt).toBeGreaterThan(0);
    // The provider's steps, in this order: a round on 'run', nothing on null, else one timer.
    const steps = [
      'const step = fired ? balanceHistory.fired(now) : balanceHistory.offer(now);',
      'if (step === null) return;',
      "if (step === 'run') {",
      'balanceHistoryRound(queryClient, balanceHistoryReads.signal);',
      'const timer = setTimeout(() => {',
      'balanceHistoryPending = null;',
      'refreshBalanceHistory(true);',
      '}, step.wait);',
    ];
    const order = steps.map((step) => refresh.indexOf(step));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(provider).toMatch(
      /const cancelBalanceHistory = \(\) => \{\s*balanceHistoryPending\?\.\(\);\s*balanceHistoryPending = null;\s*balanceHistory\.disarm\(\);\s*\};/,
    );
    const resnapshotAt = provider.indexOf('const resnapshot = () => {');
    const resnapshot = provider.slice(resnapshotAt, provider.indexOf('\n    };', resnapshotAt));
    expect(resnapshot).toContain('cancelBalanceHistory();');
    const teardown = provider.slice(provider.lastIndexOf('    return () => {'));
    expect(teardown).toMatch(/cancelBalanceHistory\(\);\s*balanceHistoryReads\.abort\(\);/);
    // Nothing else touches the timer slot: no path arms or clears it beside these.
    expect(provider.match(/balanceHistoryPending = /g)).toHaveLength(3);
    // The watch reads its own entry, not `/my/orders`' one, and compares buy ids alone.
    const watch = src('./use-wallet-lock-watch.ts');
    expect(watch).toContain('useWalletLiveOrders(accountId)');
    expect(watch).not.toContain('useLiveOrders(');
  });

  it('reads the unread count on user:notification through its window alone (#53, ADR-0157)', () => {
    // The bound's `notifications` rounds: the handler reads nothing itself — it hands the signal to
    // `refreshNotifications`, whose round restarts the account's count and its list, once each (on
    // the wallet only the count is on screen; the list is only marked stale). A new read here is a
    // new per-signal cost on every page: weigh it against the budget.
    const provider = src('../components/realtime/realtime-provider.tsx');
    const positionAt = provider.indexOf("'user:position': (raw: unknown) => {");
    const handlerAt = provider.indexOf("'user:notification': (raw: unknown) => {");
    const endAt = provider.indexOf('} satisfies Record<RealtimeEventType');
    // The last handler, after `user:position`.
    expect(positionAt).toBeGreaterThan(0);
    expect(positionAt < handlerAt && handlerAt < endAt).toBe(true);
    const handler = code(provider.slice(handlerAt, endAt));
    expect(handler).toContain('if (identity === null) return;');
    expect(handler).toContain('if (!userNotificationEventSchema.safeParse(raw).success) return;');
    expect(handler).toContain('refreshNotifications();');
    expect(reads(handler)).toEqual([]);
    expect(handler).not.toMatch(/\bapi\.|NOTIFICATIONS_KEY|notification(?:List|Unread)Key/);
    // The window is per connection, leading and trailing, `RoundWindow`'s steps (which
    // market-live.test.ts drives), and torn down with the socket — as the balance history's above.
    expect(provider).toContain('const notifications = new RoundWindow(NOTIFICATION_REFRESH_MS);');
    const refreshAt = provider.indexOf('const refreshNotifications = (fired = false) => {');
    expect(refreshAt).toBeGreaterThan(0);
    const refresh = code(provider.slice(refreshAt, provider.indexOf('\n    };', refreshAt)));
    expect(reads(refresh).sort()).toEqual([
      'restartQueries(queryClient, notificationListKey(identity ?? undefined))',
      'restartQueries(queryClient, notificationUnreadKey(identity ?? undefined))',
    ]);
    const steps = [
      'const step = fired ? notifications.fired(now) : notifications.offer(now);',
      'if (step === null) return;',
      "if (step === 'run') {",
      'const timer = setTimeout(() => {',
      'notificationsPending = null;',
      'refreshNotifications(true);',
      '}, step.wait);',
    ];
    const order = steps.map((step) => refresh.indexOf(step));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(provider).toMatch(
      /const cancelNotifications = \(\) => \{\s*notificationsPending\?\.\(\);\s*notificationsPending = null;\s*notifications\.disarm\(\);\s*\};/,
    );
    // A resnapshot reads the count and the list whole (`NOTIFICATIONS_KEY` is a private snapshot
    // key), so no round is owed after it; the teardown leaves no timer for a socket that is gone.
    const privateKeys = provider.slice(
      provider.indexOf('const PRIVATE_SNAPSHOT_KEYS = ['),
      provider.indexOf('] as const;', provider.indexOf('const PRIVATE_SNAPSHOT_KEYS = [')),
    );
    expect(privateKeys).toContain('NOTIFICATIONS_KEY');
    const resnapshotAt = provider.indexOf('const resnapshot = () => {');
    const resnapshot = provider.slice(resnapshotAt, provider.indexOf('\n    };', resnapshotAt));
    expect(resnapshot).toContain('cancelNotifications();');
    const teardown = provider.slice(provider.lastIndexOf('    return () => {'));
    expect(teardown).toContain('cancelNotifications();');
    expect(provider.match(/notificationsPending = /g)).toHaveLength(3);
    // Nothing else in the provider names the inbox's keys: no other event reads them.
    expect(provider.match(/notificationUnreadKey\(/g)).toHaveLength(1);
    expect(provider.match(/notificationListKey\(/g)).toHaveLength(1);
  });

  it('reads one page of live orders a book round, however many it holds (#302, ADR-0146)', () => {
    // The steady bound's `book * 1`: the watch draws the first page alone and asks for no next one,
    // and that page is 100 long (`WALLET_LIVE_ORDERS_PAGE`) — more rows, not more requests.
    const watch = code(src('./use-wallet-lock-watch.ts'));
    expect(watch).toContain('const rows = orders.data?.pages[0]?.items ?? [];');
    expect(watch).not.toMatch(/fetchNextPage|hasNextPage|pages\.flatMap|pages\[1\]/);
    expect(code(src('./use-my-orders.ts'))).toContain(
      'liveOrdersQueryOptions(accountId, undefined, session, WALLET_LIVE_ORDERS_PAGE)',
    );
  });

  it('is what ADR-0144 records, measured before the fix and with no room cap', () => {
    const decisions = src('../../../../docs/DECISIONS.md');
    const adr = decisions.slice(decisions.indexOf('\n## ADR-0144 '));
    const adr0144 = adr.slice(0, adr.indexOf('\n## ADR-', 1));
    const decision6 = adr0144.slice(
      adr0144.indexOf('**6. 실시간과 요청 예산.**'),
      adr0144.indexOf('**7. 시험.**'),
    );
    expect(decision6).not.toContain('첫 10개 시장');
    expect(decision6).toContain('정상 상태 ≤ 35');
    expect(decision6).toContain('L ≤ 9쪽(180행)일 때 ≤ 50');
    const result2 = adr0144.slice(
      adr0144.indexOf('**2. 문서와 측정.**'),
      adr0144.indexOf('**3. 수용 기준'),
    );
    for (const measured of ['96/78/86/86', '81/78/80/101', '79/78/81/108']) {
      expect(result2).toContain(measured);
    }
    // The after-fix measurement replaced its placeholder: every window of the three wallet targets
    // within the budget, and no placeholder left behind.
    for (const measured of ['29/23/30/24', '28/23/29/24', '27/23/29/24']) {
      expect(result2).toContain(measured);
    }
    expect(result2).not.toContain('[고친 뒤');
    expect(result2).not.toContain('[측정 전');
  });
});
