import * as z from 'zod';
import { uuidSchema } from './api/uuid.js';

/**
 * BullMQ queue and job names (PLAN 9), shared by the producer (apps/api enqueues the delayed
 * close and finalize jobs after a transition commits) and the consumer (apps/worker). One
 * module, so a renamed job cannot leave the API adding work that no worker handles.
 */
export const QUEUE_NAMES = ['markets', 'audit', 'stats'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const JOB_NAMES = {
  marketClose: 'market.close',
  marketFinalize: 'market.finalize',
  ledgerAudit: 'ledger.audit',
  marketTraderCount: 'market.trader_count',
} as const;
export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * Payload of `market.close` and `market.finalize`. With a `marketId` the job is the delayed
 * trigger the API registered for one market (PLAN 5.5: `close_at` / `dispute_until`); without
 * one it is the per-minute safety-net scan the worker schedules for itself, which handles every
 * market that is due. Both paths run the same per-market transaction and re-verify the status
 * and the instant under the market lock, so a stale or duplicated job is a no-op, never a
 * second settlement.
 */
export const marketJobDataSchema = z.object({ marketId: uuidSchema.optional() });
export type MarketJobData = z.infer<typeof marketJobDataSchema>;

/**
 * Deterministic job ids, so the API can remove the job it registered before when the instant
 * moves (a PATCHed `closeAt`, a changed result) and so a duplicate registration of the same
 * instant is refused by BullMQ rather than run twice.
 *
 * The instant is part of the id on purpose: a rescheduled job must be a NEW job even while the
 * old one is active (an active job cannot be removed, and a completed one with a custom id
 * would block a later add under the same id). Dots, never colons — BullMQ refuses a custom id
 * containing `:` because its own keys are colon-delimited.
 */
export function marketCloseJobId(marketId: string, closeAt: Date): string {
  return `${JOB_NAMES.marketClose}.${marketId}.${String(closeAt.getTime())}`;
}

export function marketFinalizeJobId(marketId: string, disputeUntil: Date): string {
  return `${JOB_NAMES.marketFinalize}.${marketId}.${String(disputeUntil.getTime())}`;
}
