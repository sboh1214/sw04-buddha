import { eq } from 'drizzle-orm';
import { RELEASE_SETTINGS, type ReleaseSettingsRegistry } from '@buddha/shared';
import type { Db } from './client.js';
import { allocateMarketMakerInitial } from './market-maker-allocation.js';
import { readMarketMakerStageSettings } from './market-maker-settings.js';
import { recordMarketMakerOpenAttempt } from './market-maker-runtime.js';
import { ledgerHeldMarketIds } from './ledger-held-markets.js';
import { readMarketMakerConfig } from './market-liquidity.js';
import { insertRuleVersion } from './market-rules-content.js';
import { transitionMarket } from './market-transitions.js';
import { markets } from './schema/index.js';

type MarketRow = typeof markets.$inferSelect;

/** A transaction handle of either app, as `transitionMarket` takes it, that also reads back. */
type Executor = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Why `openScheduledMarket` left a market as it was:
 * - `not_scheduled`: it is not SCHEDULED — not approved yet, opened already, or past the open;
 * - `not_due`: its scheduled open is still ahead, or it has none;
 * - `close_passed`: its close has come. It stays SCHEDULED, public as 개장 예정, until an admin
 *   sends it back to a draft to fix its times (ADR-0093 decision 2 #172 item 6).
 * - `ledger_hold`: reconciliation recovery is still awaiting approval. A passing retest alone
 *   does not open it; after recovery the normal open scan may open it while its close is ahead.
 * - `liquidity_missing`: a legacy scheduled market has no explicit settings; return it to draft,
 *   configure it and review it again. No budget is inferred and nothing is backfilled.
 */
export type OpenSkipReason =
  | 'not_scheduled'
  | 'not_due'
  | 'close_passed'
  | 'ledger_hold'
  | 'liquidity_missing'
  | 'risk_settings_missing'
  | 'risk_settings_invalid'
  | 'treasury_missing'
  | 'treasury_insufficient'
  | 'treasury_inconsistent'
  | 'market_maker_approval_missing'
  | 'market_maker_funds_inconsistent'
  | 'missing_market_maker';

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
  registry?: ReleaseSettingsRegistry;
}

export type OpenScheduledMarketResult =
  | {
      opened: true;
      statusEventId: number;
      row: MarketRow;
      /** The rule version the open recorded: 1, the market's `rule_version` (#80). */
      ruleVersion: number;
    }
  | { opened: false; reason: OpenSkipReason };

/**
 * SCHEDULED → OPEN (#21, ADR-0100; ADR-0093 decision 1 #173 item 1, decision 2 #172 item 6), the
 * one way a market opens, for all three of its callers, so the rule lives in one place:
 * - the worker's `market.open` job at `scheduled_open_at` and its per-minute scan (`job`);
 * - the approval that finds the scheduled open already come ('승인하는 즉시 연다', `approval`);
 * - the reschedule to an instant already come (decision 3 '#21 앞당긴 개장': there is no early
 *   open — an admin moves the scheduled open earlier instead, `reschedule`).
 * Rule v1 (#80) is recorded here, and #72's liquidity config freeze, also taken at the open, hooks
 * in here too.
 *
 * Call it under `lockMarket`, with `market` read `FOR UPDATE` after the lock and `now` the DB
 * clock read after that, in the caller's transaction. It opens a market that is SCHEDULED, whose
 * scheduled open is set and at or before `now`, and whose close is after `now`, checked in that
 * order; otherwise it says why. A due attempt records its observed hold or MM readiness blocker.
 * A null scheduled open never comes: every path
 * to SCHEDULED leaves one (the submission's open-items check, the reschedule), so a row without it
 * was written outside them and waits rather than opening with no time. A close that has come is
 * never opened (ADR-0099 결과 5 left that to #21): trading would end as it began.
 *
 * The explicit liquidity version and all three stage settings must exist. The existing approved
 * review authorizes one allocation of A from treasury, atomically with OPEN, the runtime row and
 * the pinned configuration. Missing funding/settings leaves SCHEDULED with an observed reason;
 * no implicit mint or old-OPEN backfill is allowed. Other opening content
 * is not checked again, since the approval was the last gate: not the open items — a
 * category hidden since keeps its markets (ADR-0093 #172 item 1 '기존 시장은 그 분류를 그대로
 * 가진다') — and not the lead close (ADR-0098 7-6). `lead_close_gap_minutes` stays as the
 * submission stored it.
 *
 * The open is `transitionMarket`'s: the `opened` event — from `scheduled`, to `open`, the actor,
 * payload `{openAt, closeAt, source}` with the instants as ISO — and the row with `open_at`,
 * `updated_at` and the event's instant all `now`, `status_event_id` that event's id and
 * `rule_version` 1 and `opened_liquidity_version` equal to the current configuration. The
 * configuration stays in the admin-only version table, never in the public event payload.
 * Then, in the opened branch only, rule v1 (#80, ADR-0101; ADR-0093 decision 2
 * #172 item 6 '개장할 때 잠긴 내용을 규칙 v1로 기록한다'): `insertRuleVersion` records the content
 * locked at the review — read back from the row and its sources after the write, blank items
 * included (nothing is checked again) — at `now`, made by the actor (null for the job). The
 * `opened` event is v1's record: it writes no event of its own, and its payload is unchanged. A
 * skip writes no version, and a second run is a skip (`not_scheduled`), so a market never has two.
 * From then on its rules change by an approved supplement alone (migration 0053's guard).
 *
 * Returns the event's id, the row read back after the writes and the version; the caller publishes
 * `market:status` after COMMIT. An actor that does not match the source (an admin for the job,
 * none for an admin's action) is a caller's bug and throws before anything is judged.
 */
export async function openScheduledMarket(
  tx: Executor,
  { market, now, actorId, source, registry = RELEASE_SETTINGS }: OpenScheduledMarketInput,
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
  const liquidity = await readMarketMakerConfig(tx, market.id);
  const skip = async (
    reason: OpenSkipReason,
    requiredCoin: bigint | null = liquidity?.budgetCoin ?? null,
    availableCoin: bigint | null = null,
  ): Promise<OpenScheduledMarketResult> => {
    await recordMarketMakerOpenAttempt(tx, {
      marketId: market.id,
      reason,
      requiredCoin,
      availableCoin,
      liquidityVersion: liquidity?.version ?? null,
    });
    return { opened: false, reason };
  };
  if ((await ledgerHeldMarketIds(tx, [market.id])).has(market.id)) return skip('ledger_hold');
  if (!liquidity) return skip('liquidity_missing');
  const stages = await readMarketMakerStageSettings(tx, registry);
  if (stages.kind !== 'ready')
    return skip(stages.reason === 'undecided' ? 'risk_settings_missing' : 'risk_settings_invalid');
  const allocation = await allocateMarketMakerInitial(tx, {
    marketId: market.id,
    liquidityVersion: liquidity.version,
  });
  if (allocation.outcome === 'unavailable') {
    const reason: OpenSkipReason =
      allocation.reason === 'approval_missing'
        ? 'market_maker_approval_missing'
        : allocation.reason === 'funds_inconsistent'
          ? 'market_maker_funds_inconsistent'
          : allocation.reason;
    return skip(reason, allocation.requiredCoin, allocation.availableCoin);
  }
  // Allocation has acquired the final asset locks and rechecked the close. Its instant is
  // the actual open, including when this transaction waited for another market's treasury use.
  now = allocation.at;
  await recordMarketMakerOpenAttempt(tx, {
    marketId: market.id,
    reason: null,
    requiredCoin: allocation.requiredCoin,
    availableCoin: allocation.availableCoin,
    liquidityVersion: liquidity.version,
    at: now,
  });

  const statusEventId = await transitionMarket(tx, {
    marketId: market.id,
    from: 'scheduled',
    to: 'open',
    type: 'opened',
    actorId,
    payload: { openAt: now.toISOString(), closeAt: market.closeAt.toISOString(), source },
    at: now,
    set: { openAt: now, ruleVersion: 1, openedLiquidityVersion: liquidity.version },
  });
  await insertRuleVersion(tx, {
    marketId: market.id,
    version: 1,
    createdAt: now,
    createdBy: actorId,
    supplement: null,
  });
  const [row] = await tx.select().from(markets).where(eq(markets.id, market.id));
  if (!row) throw new Error(`Market ${market.id} was opened but could not be read back`);
  return { opened: true, statusEventId, row, ruleVersion: 1 };
}
