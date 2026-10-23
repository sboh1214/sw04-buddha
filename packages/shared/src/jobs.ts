import * as z from 'zod';
import { uuidSchema } from './api/uuid.js';

/**
 * BullMQ queue and job names (PLAN 9), shared by the producer (apps/api enqueues the delayed
 * close and finalize jobs after a transition commits) and the consumer (apps/worker). One
 * module, so a renamed job cannot leave the API adding work that no worker handles.
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
  marketClose: 'market.close',
  marketFinalize: 'market.finalize',
  ledgerAudit: 'ledger.audit',
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
 * Payload of `market.close` and `market.finalize`. With a `marketId` the job is the trigger
 * the API registered for one market (PLAN 5.5: delayed to `close_at`, or immediate after the
 * judgement — ADR-0046); without one it is the per-minute safety-net scan the worker schedules
 * for itself, which handles every market that is due. Both paths run the same per-market
 * transaction and re-verify the status under the market lock, so a stale or duplicated job is a
 * no-op, never a second settlement.
 */
export const marketJobDataSchema = z.object({ marketId: uuidSchema.optional() });
export type MarketJobData = z.infer<typeof marketJobDataSchema>;

/**
 * Deterministic job ids, so the API can remove the job it registered before when the instant
 * moves (a PATCHed `closeAt`) and so a duplicate registration of the same instant is refused
 * by BullMQ rather than run twice.
 *
 * The instant is part of the id on purpose: a rescheduled job must be a NEW job even while the
 * old one is active (an active job cannot be removed, and a completed one with a custom id
 * would block a later add under the same id). Dots, never colons — BullMQ refuses a custom id
 * containing `:` because its own keys are colon-delimited.
 */
export function marketCloseJobId(marketId: string, closeAt: Date): string {
  return `${JOB_NAMES.marketClose}.${marketId}.${String(closeAt.getTime())}`;
}

/**
 * `resolvedAt` is the judgement's instant (ADR-0046): the job runs at once. A market is judged
 * once, but the instant stays in the id under the rule above, so a later re-judgement (#26)
 * would register a new job rather than collide with a failed one kept by `removeOnFail`.
 */
export function marketFinalizeJobId(marketId: string, resolvedAt: Date): string {
  return `${JOB_NAMES.marketFinalize}.${marketId}.${String(resolvedAt.getTime())}`;
}
