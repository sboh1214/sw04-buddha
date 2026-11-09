import {
  MARKET_NO_FILL_CANCEL_REASON,
  type MarketCancelledByJobPayload,
  type MarketStatus,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { marketHasHumanFill } from './market-cancel.js';
import { endPauseAtClose, type MarketPauseRow } from './market-pause.js';
import { transitionMarket } from './market-transitions.js';
import { expireLockedOrders, lockMarketOrders, type ExpiredOrders } from './order-cancel.js';
import { markets } from './schema/index.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The statuses the close at `close_at` ends (ADR-0093 decision 1 #173 items 1·3): OPEN, and PAUSED
 * on schedule — never later — since #114; to CLOSED, or to CANCELLED with no fill a person's
 * account is on (#20).
 */
export const CLOSABLE_STATUSES = ['open', 'paused'] as const satisfies readonly MarketStatus[];

const isClosable = (status: MarketStatus): status is (typeof CLOSABLE_STATUSES)[number] =>
  (CLOSABLE_STATUSES as readonly MarketStatus[]).includes(status);

/**
 * Why `closeMarketAtClose` left a market as it was: `not_open_or_paused` — neither OPEN nor PAUSED
 * (a draft up to SCHEDULED, or closed or cancelled already); `not_due` — its close is still ahead.
 */
export type CloseSkipReason = 'not_open_or_paused' | 'not_due';

export type CloseMarketAtCloseResult =
  | {
      /** The close ran: the market left trading, CLOSED or CANCELLED (`status`). */
      closed: true;
      /**
       * Where it went: `closed` with a fill a person's account is on, `cancelled` with none (#20,
       * `marketHasHumanFill`).
       */
      status: 'closed' | 'cancelled';
      /** The `closed` or `cancelled` event's id, the market's `status_event_id`. */
      statusEventId: number;
      /** The close's instant: the event's, the market row's and every expired order's. */
      closedAt: Date;
      /** A PAUSED market's lasting pause, ended `closed_at_close`; null for an OPEN one. */
      pause: MarketPauseRow | null;
      /** The orders it ended 만료, and a held market's left live and locked (#93's). */
      expired: ExpiredOrders;
    }
  | { closed: false; reason: CloseSkipReason };

/**
 * 시장 마감 at `close_at` (PLAN 5.5 마감; #120, ADR-0115; #20, ADR-0117; ADR-0093 decision 1 #173 items
 * 1·3·10, ADR-0107 결정 4 '#120·#20'·#178 rows, 결정 5 '#120 PAUSED 중'·'#20·#120 거래가 전혀 없던과 자동
 * CANCELLED'·'#20·#120·#177 7항'): OPEN or PAUSED → CLOSED, or → CANCELLED when no fill a person's
 * account is on happened, for one market and the end of its remaining orders, in the caller's
 * transaction — the worker's `market.close` (its delayed job and per-minute scan) and the tests'
 * `closeTestMarket`, so the rule lives once, as the open is `openScheduledMarket`'s (ADR-0100 결정
 * 2). In order:
 *
 * 1. `lockMarket`, the row `FOR UPDATE`: neither OPEN nor PAUSED → `not_open_or_paused` (a second
 *    closer sees the first's CLOSED or CANCELLED);
 * 2. the DB clock: `close_at` still ahead → `not_due`, before anyone's balance row is taken, so a
 *    stale delayed job (a supplement extended the close, #80) locks no one. The judgement is the
 *    `close_at` as stored and the server's clock only (ADR-0107 결정 5 '#120 개장 뒤 거래 마감 시각
 *    변경'), never `scheduled_judgement_at`; the clock only moves forward and `close_at` cannot
 *    change under the lock, so a market due now is due at the instant read in 4;
 * 3. every live order's owner's Coin account at once (`lockMarketOrders`: people and the 운영
 *    마켓메이커's 마켓메이커 자금, ADR-0110 결정 4), unless the market is held: then only its
 *    orders and hold are read, because the close changes no asset and must survive broken books;
 * 4. the close's instant, the DB clock after the last lock;
 * 5. '사용자 체결 0건' judged from the fills under the lock (`marketHasHumanFill`, #20: any fill a
 *    person's account is on, abnormal or not — never `trader_count`); a fill that committed before
 *    the lock counts, and none can follow;
 * 6. the transition (`transitionMarket`, actor null): with such a fill `closed`, payload
 *    `{closedAt, source: 'job'}`; with none `cancelled`, payload `{cancelledAt, source: 'job',
 *    reason}` with the system sentence (MARKET_NO_FILL_CANCEL_REASON, MarketCancelledPayload) and
 *    the result type left null — no judgement, 판정 이의 or payout follows; there is no closed →
 *    cancelled edge, so a market CLOSED once stays so. Then a PAUSED market's lasting pause ended
 *    `closed_at_close` (`endPauseAtClose`, which cancels nothing) — a held market closes or cancels
 *    on schedule too, and stays held;
 * 7. every live order of every account type ended 만료 at that instant, its lock given back once
 *    (`expireLockedOrders`), the same for CLOSED and CANCELLED: no ledger entry, fill or contract
 *    move — the 운영 마켓메이커's Coin stays in the market's 마켓메이커 자금 for #181; a market held
 *    for a ledger failure keeps its orders live and locked until #93's recovery (결정 4 #178 '복구
 *    전에 마감이 오면').
 *
 * It writes no `orders` row itself (order-cancel.ts does) and publishes nothing: the caller sends
 * `market:status`, and `market:book` when an order expired, after COMMIT. A lock that does not
 * hold what an order's remainder names (`ContractError`) rolls the whole close back — a ledger
 * inconsistency for #93 — and the market stays OPEN by status while the intake, the quote and the
 * book refuse it by the clock. Never 'not_found': an unknown id throws (see the worker's doc).
 */
export async function closeMarketAtClose(
  tx: Tx,
  marketId: string,
): Promise<CloseMarketAtCloseResult> {
  await lockMarket(tx, marketId);
  const [current] = await tx
    .select()
    .from(markets)
    .where(eq(markets.id, marketId))
    .limit(1)
    .for('update');
  if (!current) throw new Error(`Market ${marketId} not found`);
  if (!isClosable(current.status)) return { closed: false, reason: 'not_open_or_paused' };
  // The database clock after the market lock (tx-helpers.ts): an admin edit or transition may
  // have committed while this transaction queued, and the close is judged after it.
  if (current.closeAt > (await clockTimestamp(tx))) return { closed: false, reason: 'not_due' };

  const orders = await lockMarketOrders(tx, marketId, { preserveHold: true });
  const at = await clockTimestamp(tx);
  // '사용자 체결 0건' under the market lock (#20): no fill a person's account is on → cancelled.
  const traded = await marketHasHumanFill(tx, marketId);
  const statusEventId = await transitionMarket(
    tx,
    traded
      ? {
          marketId,
          from: current.status,
          to: 'closed',
          type: 'closed',
          actorId: null,
          payload: { closedAt: at.toISOString(), source: 'job' },
          at,
        }
      : {
          marketId,
          from: current.status,
          to: 'cancelled',
          type: 'cancelled',
          actorId: null,
          payload: {
            cancelledAt: at.toISOString(),
            source: 'job',
            reason: MARKET_NO_FILL_CANCEL_REASON,
          } satisfies MarketCancelledByJobPayload,
          at,
        },
  );
  const pause =
    current.status === 'paused'
      ? await endPauseAtClose(tx, { marketId, now: at, eventId: statusEventId })
      : null;
  const expired = await expireLockedOrders(tx, orders, { at });
  return {
    closed: true,
    status: traded ? 'closed' : 'cancelled',
    statusEventId,
    closedAt: at,
    pause,
    expired,
  };
}
