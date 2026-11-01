import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { transitionMarket } from './market-transitions.js';
import type * as schema from './schema/index.js';
import { markets } from './schema/index.js';

type MarketRow = typeof markets.$inferSelect;

/** A transaction handle of either app, as `transitionMarket` takes it, that also reads back. */
type Executor = Pick<NodePgDatabase<typeof schema>, 'insert' | 'update' | 'select'>;

/**
 * Why `openScheduledMarket` left a market as it was:
 * - `not_scheduled`: it is not SCHEDULED — not approved yet, opened already, or past the open;
 * - `not_due`: its scheduled open is still ahead, or it has none;
 * - `close_passed`: its close has come. It stays SCHEDULED, public as 개장 예정, until an admin
 *   sends it back to a draft to fix its times (ADR-0093 decision 2 #172 item 6).
 */
export type OpenSkipReason = 'not_scheduled' | 'not_due' | 'close_passed';

/**
 * Who opened it, the `opened` event's payload `source` (#21, ADR-0100): the worker's `market.open`
 * job or scan at the scheduled open (`job`, actor NULL — ADR-0095: NULL is the worker), or the
 * admin whose approval (`approval`) or reschedule (`reschedule`) found the scheduled open already
 * come (that admin the actor).
 */
export type OpenSource = 'job' | 'approval' | 'reschedule';

export interface OpenScheduledMarketInput {
  /** The market row the caller read `FOR UPDATE` after `lockMarket`, in the same transaction. */
  market: Pick<MarketRow, 'id' | 'status' | 'scheduledOpenAt' | 'closeAt'>;
  /** The DB clock read after the lock (`clockTimestamp`): what is judged, the open's instant. */
  now: Date;
  /** The approving or rescheduling admin, or null for the worker (`source: 'job'`). */
  actorId: string | null;
  source: OpenSource;
}

export type OpenScheduledMarketResult =
  | { opened: true; statusEventId: number; row: MarketRow }
  | { opened: false; reason: OpenSkipReason };

/**
 * SCHEDULED → OPEN (#21, ADR-0100; ADR-0093 decision 1 #173 item 1, decision 2 #172 item 6), the
 * one way a market opens, for all three of its callers, so the rule lives in one place:
 * - the worker's `market.open` job at `scheduled_open_at` and its per-minute scan (`job`);
 * - the approval that finds the scheduled open already come ('승인하는 즉시 연다', `approval`);
 * - the reschedule to an instant already come (decision 3 '#21 앞당긴 개장': there is no early
 *   open — an admin moves the scheduled open earlier instead, `reschedule`).
 * #80's rules v1 and #72's liquidity config freeze, both taken at the open, hook in here.
 *
 * Call it under `lockMarket`, with `market` read `FOR UPDATE` after the lock and `now` the DB
 * clock read after that, in the caller's transaction. It opens a market that is SCHEDULED, whose
 * scheduled open is set and at or before `now`, and whose close is after `now`, checked in that
 * order; otherwise it writes nothing and says why. A null scheduled open never comes: every path
 * to SCHEDULED leaves one (the submission's open-items check, the reschedule), so a row without it
 * was written outside them and waits rather than opening with no time. A close that has come is
 * never opened (ADR-0099 결과 5 left that to #21): trading would end as it began.
 *
 * Nothing else is checked again, since the approval was the last gate: not the open items — a
 * category hidden since keeps its markets (ADR-0093 #172 item 1 '기존 시장은 그 분류를 그대로
 * 가진다') — and not the lead close (ADR-0098 7-6). `lead_close_gap_minutes` stays as the
 * submission stored it.
 *
 * The open is `transitionMarket`'s: the `opened` event — from `scheduled`, to `open`, the actor,
 * payload `{openAt, closeAt, source}` with the instants as ISO — and the row with `open_at`,
 * `updated_at` and the event's instant all `now` and `status_event_id` that event's id. Returns
 * the id and the row read back after the write; the caller publishes `market:status` after
 * COMMIT. An actor that does not match the source (an admin for the job, none for an admin's
 * action) is a caller's bug and throws before anything is judged.
 */
export async function openScheduledMarket(
  tx: Executor,
  { market, now, actorId, source }: OpenScheduledMarketInput,
): Promise<OpenScheduledMarketResult> {
  if ((source === 'job') !== (actorId === null)) {
    throw new Error(
      `An open by ${source} is recorded with ${source === 'job' ? 'no actor' : 'its admin'}`,
    );
  }
  if (market.status !== 'scheduled') return { opened: false, reason: 'not_scheduled' };
  if (market.scheduledOpenAt === null || market.scheduledOpenAt.getTime() > now.getTime()) {
    return { opened: false, reason: 'not_due' };
  }
  if (market.closeAt.getTime() <= now.getTime()) return { opened: false, reason: 'close_passed' };

  const statusEventId = await transitionMarket(tx, {
    marketId: market.id,
    from: 'scheduled',
    to: 'open',
    type: 'opened',
    actorId,
    payload: { openAt: now.toISOString(), closeAt: market.closeAt.toISOString(), source },
    at: now,
    set: { openAt: now },
  });
  const [row] = await tx.select().from(markets).where(eq(markets.id, market.id));
  if (!row) throw new Error(`Market ${market.id} was opened but could not be read back`);
  return { opened: true, statusEventId, row };
}
