import * as z from 'zod';
import { marketResultSchema } from './enums.js';
import {
  judgementEvidenceSchema,
  judgementSourceSchema,
  judgementVersionSchema,
} from './market-judgement.js';
import {
  marketPauseEndKindSchema,
  marketPauseReasonSchema,
  marketPauseReviewResultSchema,
} from './market-pause.js';
import { ruleVersionNumberSchema } from './market-supplement.js';

/** Public allowlists (#24): never derive these from an administrator's record by omission. */
export const publicMarketJudgementSchema = z
  .object({
    version: judgementVersionSchema,
    result: marketResultSchema,
    source: judgementSourceSchema.nullable(),
    fallbackReason: z.string().nullable(),
    voidReason: z.string().nullable(),
    evidence: judgementEvidenceSchema,
    description: z.string(),
    ruleVersion: ruleVersionNumberSchema.nullable(),
    publishedAt: z.iso.datetime(),
    disputeDeadline: z.iso.datetime(),
    correctionReason: z.string().nullable(),
  })
  .meta({ id: 'PublicMarketJudgement' });
export type PublicMarketJudgement = z.infer<typeof publicMarketJudgementSchema>;

export const publicMarketPauseSchema = z
  .object({
    reason: marketPauseReasonSchema,
    /** Legacy notes were collected as private and have no public acknowledgement. */
    note: z.string().nullable(),
    resultPublishedAt: z.iso.datetime().nullable(),
    pausedAt: z.iso.datetime(),
    reviewResult: marketPauseReviewResultSchema.nullable(),
    endKind: marketPauseEndKindSchema.nullable(),
    endedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PublicMarketPause' });
export type PublicMarketPause = z.infer<typeof publicMarketPauseSchema>;

export const publicMarketJudgementDelaySchema = z
  .object({
    reason: z.string(),
    nextReviewAt: z.iso.datetime(),
    current: z.boolean(),
  })
  .meta({ id: 'PublicMarketJudgementDelay' });
export type PublicMarketJudgementDelay = z.infer<typeof publicMarketJudgementDelaySchema>;

/**
 * 판정 정정 (#144 part 1, ADR-0165; owner answer 144-5, ADR-0093 decision 1 #173 item 13): the
 * market's confirmed 판정 오류 사건 as the public sees it — the corrected result, the paid result
 * and the judgement version it was paid on (which stays the current version: the market row, its
 * judgements and its settlement records never move), when the error was confirmed, and what went
 * wrong with its evidence links and collection instant. Never who registered or confirmed it, the
 * reviewer's reason, a dismissed or waiting incident, or anything about an account. #144 part 2
 * adds the compensation figures (144-6).
 */
export const publicMarketJudgementCorrectionSchema = z
  .object({
    /** 정정된 결과. */
    result: marketResultSchema,
    /** 원래 결과: the paid one, `markets.resolved_result`. */
    originalResult: marketResultSchema,
    /** The paid judgement version the correction is about. */
    judgementVersion: judgementVersionSchema,
    confirmedAt: z.iso.datetime(),
    /** 오류 내용. */
    description: z.string(),
    evidence: judgementEvidenceSchema,
  })
  .meta({ id: 'PublicMarketJudgementCorrection' });
export type PublicMarketJudgementCorrection = z.infer<typeof publicMarketJudgementCorrectionSchema>;

const countSchema = z.number().int().nonnegative();
export const publicDisputeCountsSchema = z
  .object({
    pending: countSchema,
    dismissed: countSchema,
    accepted: countSchema,
    retracted: countSchema,
    closed_by_correction: countSchema,
  })
  .meta({ id: 'PublicDisputeCounts' });
export const publicDisputeDecisionSchema = z
  .object({
    judgementVersion: judgementVersionSchema,
    decision: z.enum(['accepted', 'dismissed']),
    reason: z.string(),
  })
  .meta({ id: 'PublicDisputeDecision' });
export type PublicDisputeDecision = z.infer<typeof publicDisputeDecisionSchema>;
export const publicMarketDisputesSchema = z
  .object({
    total: countSchema,
    byVersion: z.array(
      z.object({
        judgementVersion: judgementVersionSchema,
        total: countSchema,
        counts: publicDisputeCountsSchema,
      }),
    ),
    /** Decision history survives a correction's rejection/retraction reopening an accepted dispute. */
    decisions: z.array(publicDisputeDecisionSchema),
  })
  .meta({ id: 'PublicMarketDisputes' });
export type PublicMarketDisputes = z.infer<typeof publicMarketDisputesSchema>;

export const marketJudgingRecordSchema = z
  .object({
    /** Only approved versions, newest first. A legacy result has no invented version. */
    versions: z.array(publicMarketJudgementSchema),
    pauses: z.array(publicMarketPauseSchema),
    delays: z.array(publicMarketJudgementDelaySchema),
    disputes: publicMarketDisputesSchema,
    cancellation: z.object({ reason: z.string(), cancelledAt: z.iso.datetime() }).nullable(),
    /** A payout failure or reconciliation hold while settling; no internal error text. */
    payoutDelayed: z.boolean(),
    /**
     * The confirmed 판정 오류 사건's 판정 정정 (#144, ADR-0165), or null when the market has none —
     * every market until one is confirmed, which happens once paid (144-13).
     */
    correction: publicMarketJudgementCorrectionSchema.nullable(),
  })
  .meta({ id: 'MarketJudgingRecord' });
export type MarketJudgingRecord = z.infer<typeof marketJudgingRecordSchema>;
