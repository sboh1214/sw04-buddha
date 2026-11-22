import {
  MARKET_CANCELLED_NOTIFICATION,
  MARKET_CLOSED_NOTIFICATION,
  MARKET_PAUSED_NOTIFICATION,
  MARKET_RESUMED_NOTIFICATION,
  MARKET_RULES_SUPPLEMENTED_NOTIFICATION,
  type MarketCancelledParams,
  type MarketClosedParams,
  type MarketPauseReason,
  type MarketPausedParams,
  type MarketResumedParams,
  type MarketRulesSupplementedParams,
  type MarketStatus,
  type NotificationParamValues,
} from '@buddha/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { createNotifications, notifiedUserIds, type NotificationInput } from './notifications.js';
import { marketEventKey } from './order-notifications.js';
import type { ReconciliationRun } from './reconciliation-audit.js';
import type { markets } from './schema/index.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type MarketRow = typeof markets.$inferSelect;

/*
 * 시장 상태 알림 (#54, ADR-0159; N05 §4, 52-1·52-5·52-8~52-10, 54-1~54-8): who hears of a
 * market's state and the inputs that tell them. The transaction owners append these inputs to the
 * ONE `createNotifications` call of the event (ADR-0158 결과 6 — never a second call), after the
 * event's writes:
 *
 * - G the close at `close_at` (market-close.ts `closeMarketAtClose`): `market_closed` early
 *   false, or `market_cancelled` with no fill a person's account is on;
 * - B an admin's pause and C its approved end (the API's market-pause.service.ts): `market_paused`,
 *   then `market_resumed` or `market_closed` early true / `market_cancelled`;
 * - B′ the reconciliation's automatic ledger-failure pause (54-5): `deliverReconciliationNotices`,
 *   called last by the run's transaction owners, inside a savepoint (54-6);
 * - D an approved supplement that changed a NOTIFIED_SUPPLEMENT_ITEMS item (52-10, 54-7) and E a
 *   SCHEDULED market's cancel (the API's services): `market_rules_supplemented` and
 *   `market_cancelled`.
 *
 * Never: the bot-only stop, the open and the pre-open transitions, a title- or background-only
 * supplement, a request, a rejection or a retraction (market-notifications.test.ts pins the
 * callers of `transitionMarket`). Judgement and settlement are #188's, which reuses
 * `marketAudience` (52-14).
 */

/**
 * 52-1: who hears of a market's state — its watchers now and its holders now (one contract or
 * more of either outcome, 지급 0이 될 보유 included; `qty` counts the contracts sell orders hold),
 * each once, sorted by byte order. Not a member with resting orders only, nor one who sold
 * everything: their own order notices tell them (#134). The 운영 마켓메이커 is in it when it holds,
 * and the write path's gate skips it (53-5: no inbox), as it skips a closed account or a closure
 * in flight; an admin and a restricted member are in it like anyone (53-5, 53-6, 54-8).
 *
 * One statement, two index reads, and NO row lock: read under the event's market lock and its
 * market row FOR UPDATE, right before the event's one `createNotifications` call (ADR-0158 12-20).
 * Holders change only under the market lock (fills), and every effective watch or unwatch writes a
 * row whose foreign key takes the market row FOR KEY SHARE — which waits for the event's FOR
 * UPDATE — so the set read is exactly the event's: an unwatch that committed first is honoured
 * (#54 AC 5), one still waiting is after the event. Never lock a profile, an inbox or a watch here
 * (a profile under the market lock deadlocks with a closure, ADR-0157 결정 1의 2).
 */
export async function marketAudience(tx: Tx, marketId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ user_id: string }>(sql`
    SELECT user_id FROM (
      SELECT user_id FROM market_watches WHERE market_id = ${marketId}
      UNION
      SELECT user_id FROM positions WHERE market_id = ${marketId} AND qty > 0
    ) audience
    ORDER BY user_id COLLATE "C"`);
  return rows.map((row) => row.user_id);
}

/** One state change of a market, as its transaction owner tells it (#54). */
export type MarketNotice =
  /** 거래 마감 (52-8): at `close_at` (`early` false) or by an approved 조기 마감 (true). */
  | { kind: 'closed'; early: boolean }
  /** 시장 취소 (52-5): no fill a person's account is on, or a SCHEDULED market's cancel. */
  | { kind: 'cancelled' }
  /** 전체 거래 일시 중단 (52-9): an admin's or the reconciliation's (54-5), with its reason. */
  | { kind: 'paused'; reason: MarketPauseReason }
  /** 거래 재개 (52-9, 54-2): with the ended pause's reason. */
  | { kind: 'resumed'; reason: MarketPauseReason }
  /** 중요한 규칙 보충 (52-10): the version it made and its public reason. */
  | { kind: 'rules_supplemented'; ruleVersion: number; reason: string };

/** The event the notice tells: its key (`marketEventKey`) and its instant, the 발생 시각. */
export interface MarketNoticeEvent {
  readonly eventKey: string;
  readonly occurredAt: Date;
}

/** The market as the event wrote or read it under its lock: what the notice names and leads to. */
export type MarketNoticeMarket = Pick<MarketRow, 'slug' | 'title' | 'status'>;

/** The statuses a market is in after each notice's event (a mismatch is a caller bug). */
const STATUS_AFTER: { readonly [K in MarketNotice['kind']]: readonly MarketStatus[] } = {
  closed: ['closed'],
  cancelled: ['cancelled'],
  paused: ['paused'],
  resumed: ['open'],
  rules_supplemented: ['open', 'paused'],
};

/** The notice's type and params (#54's five definitions). */
function noticeOf(
  market: MarketNoticeMarket,
  notice: MarketNotice,
): { type: string; params: NotificationParamValues } {
  const marketTitle = market.title;
  switch (notice.kind) {
    case 'closed': {
      const params: MarketClosedParams = { marketTitle, early: notice.early };
      return { type: MARKET_CLOSED_NOTIFICATION.type, params };
    }
    case 'cancelled': {
      const params: MarketCancelledParams = { marketTitle };
      return { type: MARKET_CANCELLED_NOTIFICATION.type, params };
    }
    case 'paused': {
      const params: MarketPausedParams = { marketTitle, reason: notice.reason };
      return { type: MARKET_PAUSED_NOTIFICATION.type, params };
    }
    case 'resumed': {
      const params: MarketResumedParams = { marketTitle, reason: notice.reason };
      return { type: MARKET_RESUMED_NOTIFICATION.type, params };
    }
    case 'rules_supplemented': {
      if (!Number.isInteger(notice.ruleVersion) || notice.ruleVersion < 2) {
        throw new Error(`a supplement makes version 2 or later, not ${String(notice.ruleVersion)}`);
      }
      if (notice.reason.length === 0) throw new Error('a supplement notice needs its reason');
      const params: MarketRulesSupplementedParams = {
        marketTitle,
        ruleVersion: notice.ruleVersion,
        reason: notice.reason,
      };
      return { type: MARKET_RULES_SUPPLEMENTED_NOTIFICATION.type, params };
    }
  }
}

/**
 * The inputs of one market event's notice (#54): one per member of `audience` (`marketAudience`,
 * read under the event's locks), each keyed by the event (`market_event:<id>` — in G and C the
 * same key as #134's order notices, another type, so each is delivered, 53-4), at its instant,
 * leading to the market's detail (`market` target by its slug, 54-4) and naming its title as the
 * event left it (for a supplement, the title after it). Pure: no SQL.
 *
 * Throws — a caller bug, and the event rolls back with it (ADR-0158 12-19) — when the market's
 * status is not the one the notice's event leaves (`closed`; `cancelled`; `paused`; `open` after
 * a resume; `open` or `paused` for a supplement), on a supplement's version below 2 or an empty
 * reason. An empty audience gives no input. The slug must pass `marketSlugSchema`, as every
 * written market's does: the write path refuses another and the event would roll back.
 */
export function marketNotificationInputs(
  audience: readonly string[],
  market: MarketNoticeMarket,
  notice: MarketNotice & MarketNoticeEvent,
): NotificationInput[] {
  if (!STATUS_AFTER[notice.kind].includes(market.status)) {
    throw new Error(`a ${notice.kind} notice of a market that is ${market.status}`);
  }
  const { type, params } = noticeOf(market, notice);
  return audience.map((userId) => ({
    userId,
    type,
    eventKey: notice.eventKey,
    occurredAt: notice.occurredAt,
    target: { kind: 'market', slug: market.slug },
    params,
  }));
}

/**
 * The fixed line a transaction owner logs when `deliverReconciliationNotices` failed (54-6): the
 * pause stands and its notices are lost. Never with the error's message (a database error can name
 * a key holding an account id), an id or a count.
 */
export const RECONCILIATION_NOTICES_FAILED_LOG =
  'reconciliation pause kept; its market notices were not written';

/**
 * B′ (54-5, 54-6): the notices of the reconciliation's automatic ledger-failure pause, which the
 * run describes (`ReconciliationRun.systemPause`; null for every run that paused nothing → nothing,
 * no SQL). The run's transaction owners — the worker's `reconcileTarget`, the API's manual run and
 * its correction's approval — call it last in their transaction, as their one call.
 *
 * The audience read, the inputs (`market_paused`, reason `ledger_failure`, keyed by the pause's
 * event at its instant) and `createNotifications` run inside ONE savepoint of that transaction —
 * still the same transaction (53-4). Whatever throws there rolls back to it (its row locks with
 * it) and answers `failed`: the pause is the unattended safety stop on broken books (ADR-0119), so
 * a notice must never be why it does not happen (54-6, the narrow exception to ADR-0157 결정 4의
 * 7). The cost: those notices are lost for good — the next run finds the market PAUSED. The
 * owner logs RECONCILIATION_NOTICES_FAILED_LOG and publishes `user:notification` to `notified`
 * after COMMIT.
 */
export async function deliverReconciliationNotices(
  tx: Tx,
  systemPause: ReconciliationRun['systemPause'],
): Promise<{ notified: string[]; failed: boolean }> {
  if (systemPause === null) return { notified: [], failed: false };
  try {
    const outcomes = await tx.transaction(async (savepoint) => {
      const audience = await marketAudience(savepoint, systemPause.marketId);
      return createNotifications(
        savepoint,
        marketNotificationInputs(
          audience,
          { slug: systemPause.slug, title: systemPause.title, status: 'paused' },
          {
            kind: 'paused',
            reason: 'ledger_failure',
            eventKey: marketEventKey(systemPause.eventId),
            occurredAt: systemPause.at,
          },
        ),
      );
    });
    return { notified: notifiedUserIds(outcomes), failed: false };
  } catch {
    return { notified: [], failed: true };
  }
}
