import * as z from 'zod';
import { uuidSchema } from './api/uuid.js';

/**
 * BullMQ queue and job names (PLAN 9), shared by the producers (apps/api enqueues a market's
 * delayed open, close and resolve jobs after the write that sets their instant commits; the
 * worker enqueues the finalize after its own confirmation, #152) and the consumer (apps/worker).
 * One module, so a renamed job cannot leave the API adding work that no worker handles.
 */
export const QUEUE_NAMES = [
  'markets',
  'audit',
  'stats',
  'wallet',
  'media',
  'community',
  'retention',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const JOB_NAMES = {
  /**
   * Opens a SCHEDULED market at its 예정 개장 시각 (#21, ADR-0100; ADR-0093 decision 1 #173 item
   * 1): SCHEDULED → OPEN, actor NULL (the worker). The delayed job the API registers per market
   * when an approval or a reschedule leaves it SCHEDULED, and the worker's per-minute scan as the
   * backstop. A market whose close has passed is never opened: it stays SCHEDULED until an admin
   * sends it back to a draft (ADR-0093 decision 2 #172 item 6). A market cancelled meanwhile
   * (#20) is skipped as any other not SCHEDULED, and its cancel removes both delayed jobs.
   */
  marketOpen: 'market.open',
  /**
   * Closes an OPEN or PAUSED market at its 거래 마감 시각 (#120, ADR-0115; ADR-0093 decision 1 #173
   * items 1·3), actor NULL: → CLOSED, or → CANCELLED when no fill a person's account is on
   * happened (#20, ADR-0117), every remaining order ended 만료. The delayed job and the per-minute
   * scan, as `market.open`.
   */
  marketClose: 'market.close',
  /**
   * Confirms a PROVISIONAL market's result once its 이의 기한 has passed with nothing held (#152,
   * ADR-0103; ADR-0093 decision 1 #173 item 1): PROVISIONAL → RESOLVED, actor NULL (the worker),
   * with the settlement steps, then `market.finalize` at once. The delayed job the API registers
   * when an approval publishes the provisional result, and the worker's per-minute scan
   * (`market-resolve-scan`) as the backstop — which also confirms a market whose hold (#175's
   * 판정 이의; #176's waiting correction, ADR-0105) cleared after its deadline. A held market's run
   * completes `held`, and the run of a deadline a correction replaced `not_due` (it is never
   * cancelled); the dismissal, or the correction's 반려 or 철회, that leaves nothing holding past
   * the deadline enqueues it again under the same id, delay 0 (#175, ADR-0104), so the worker
   * stays the only confirmer.
   */
  marketResolve: 'market.resolve',
  marketFinalize: 'market.finalize',
  ledgerAudit: 'ledger.audit',
  /**
   * Reserved: nothing schedules it. `markets.trader_count` is kept exactly in the fill's own
   * transaction by the intake (#121, ADR-0116), so no job recounts it.
   */
  marketTraderCount: 'market.trader_count',
  /**
   * Pays every start grant still `pending` (#70, ADR-0071) once the release setting
   * `grant.start_coin` has a value: the worker's per-minute scan, so the accounts that finished
   * onboarding while the amount was undecided get it within a minute of an admin entering it.
   */
  startGrantPay: 'start_grant.pay',
  /**
   * Removes the uploads nothing took (#46, ADR-0073): an image uploaded for a post that was never
   * written, ORPHAN_MEDIA_HOURS after its upload — its row, then its object from storage (the key
   * queued in `media_deletions` until the store has removed it, retried on later runs). The
   * worker's hourly scan.
   */
  mediaOrphanCleanup: 'media.orphan_cleanup',
  /**
   * Deletes the working records of #187 (ADR-0083) that left the last 24 hours — the counted
   * writes of the write limits (`write_limit_events`) and the links the repetition rules count
   * (`link_uses`) — which nothing reads past their windows. The review list (`link_flags`) stays.
   * The worker's hourly scan.
   */
  communityRecordsPurge: 'community.records_purge',
  /**
   * Deletes the records whose retention period has passed (#184, retention.ts): every period whose
   * release setting is approved, read once per run, and the nickname holds past their 30 days —
   * recording each kind's count (`retention_purges`). The worker's daily run.
   */
  retentionPurge: 'retention.purge',
} as const;
export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * Payload of `market.open`, `market.close`, `market.resolve` and `market.finalize`. With a
 * `marketId` the job is the trigger registered for one market (#21: delayed to
 * `scheduled_open_at`; PLAN 5.5: delayed to `close_at`; #152: delayed to the dispute deadline, and
 * the finalize immediate after the confirmation — ADR-0046, ADR-0103); without one it is the
 * per-minute safety-net scan the worker schedules for itself, which handles every market that is
 * due. Both paths run the same per-market transaction and re-verify the status and the instant
 * under the market lock, so a stale or duplicated job is a no-op, never a second open, close,
 * confirmation or settlement.
 */
export const marketJobDataSchema = z.object({ marketId: uuidSchema.optional() });
export type MarketJobData = z.infer<typeof marketJobDataSchema>;

/**
 * Deterministic job ids, so the API can remove the job it registered before when the instant
 * moves (a rescheduled `scheduledOpenAt`, a close a supplement extended) and so a duplicate
 * registration of the same instant is refused by BullMQ rather than run twice.
 *
 * The instant is part of the id on purpose: a rescheduled job must be a NEW job even while the
 * old one is active (an active job cannot be removed, and a completed one with a custom id
 * would block a later add under the same id). Dots, never colons — BullMQ refuses a custom id
 * containing `:` because its own keys are colon-delimited.
 *
 * `scheduledOpenAt` is the market's 예정 개장 시각 (#21, ADR-0100): an approval that leaves the
 * market SCHEDULED registers the job under it, a reschedule (#78) removes that one and registers
 * one under the new instant unless it opened the market, and a 되돌리기 from SCHEDULED removes it.
 */
export function marketOpenJobId(marketId: string, scheduledOpenAt: Date): string {
  return `${JOB_NAMES.marketOpen}.${marketId}.${String(scheduledOpenAt.getTime())}`;
}

/** `closeAt` is the market's 거래 마감 시각, under the same rule. */
export function marketCloseJobId(marketId: string, closeAt: Date): string {
  return `${JOB_NAMES.marketClose}.${marketId}.${String(closeAt.getTime())}`;
}

/**
 * `disputeDeadline` is the provisional result's 이의 기한 (#152, ADR-0103), fixed by the approval
 * that published it: the API registers the job delayed to it. A correction's approval (#176,
 * ADR-0105) gives the market a later deadline, and so a new job under the rule above; the old
 * one still runs at its instant and finds the market not due.
 */
export function marketResolveJobId(marketId: string, disputeDeadline: Date): string {
  return `${JOB_NAMES.marketResolve}.${marketId}.${String(disputeDeadline.getTime())}`;
}

/**
 * `resolvedAt` is the instant the result was confirmed (`markets.resolved_at`, → RESOLVED): the
 * worker's confirmation at the dispute deadline (#152, ADR-0103; before it, ADR-0046's interim
 * judgement) registers the job at once. A market is confirmed once, but the instant stays in the
 * id under the rule above, so a later confirmation would register a new job rather than collide
 * with a failed one kept by `removeOnFail`.
 */
export function marketFinalizeJobId(marketId: string, resolvedAt: Date): string {
  return `${JOB_NAMES.marketFinalize}.${marketId}.${String(resolvedAt.getTime())}`;
}
