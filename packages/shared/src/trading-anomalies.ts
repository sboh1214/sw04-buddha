import * as z from 'zod';
import {
  marketStatusSchema,
  orderSideSchema,
  outcomeSchema,
  releaseSettingStatusSchema,
} from './enums.js';
import { uuidSchema } from './api/uuid.js';

/** Technical response bounds, not detection thresholds or operating policy. */
export const TRADING_ANOMALY_SCAN_LIMIT = 10_000;
export const TRADING_ANOMALY_CANDIDATE_LIMIT = 200;
export const TRADING_ANOMALY_EVIDENCE_LIMIT = 50;
export const TRADING_ANOMALY_KINDS = ['human_pair', 'round_trip'] as const;
const count = z.string().regex(/^(0|[1-9]\d*)$/);
const reading = z.object({
  key: z.string(),
  status: releaseSettingStatusSchema,
  value: z.number().int().positive().nullable(),
});
const leg = z.object({
  fillId: count,
  orderId: uuidSchema,
  userId: z.string(),
  at: z.iso.datetime(),
  outcome: outcomeSchema,
  side: orderSideSchema,
  priceCoin: z.number().int().min(1).max(99),
  qty: count,
});
export const tradingAnomalyCandidateSchema = z
  .object({
    id: z.string(),
    kind: z.enum(TRADING_ANOMALY_KINDS),
    market: z.object({ id: uuidSchema, title: z.string(), status: marketStatusSchema }),
    actors: z
      .array(z.object({ userId: z.string(), nickname: z.string().nullable() }))
      .min(1)
      .max(2),
    outcome: outcomeSchema.nullable(),
    count,
    quantity: count,
    windowStartedAt: z.iso.datetime(),
    windowEndedAt: z.iso.datetime(),
    evidenceTotal: count,
    evidenceTruncated: z.boolean(),
    evidence: z.array(z.object({ first: leg, second: leg, matchedQty: count })),
  })
  .meta({ id: 'TradingAnomalyCandidate' });
export type TradingAnomalyCandidate = z.infer<typeof tradingAnomalyCandidateSchema>;
export type TradingAnomalyLeg = z.infer<typeof leg>;
export const tradingAnomalyReportSchema = z
  .object({
    asOf: z.iso.datetime(),
    marketId: uuidSchema.nullable(),
    rangeStartedAt: z.iso.datetime().nullable(),
    source: z.object({
      scannedFills: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      truncated: z.boolean(),
      complete: z.boolean(),
      oldestScannedAt: z.iso.datetime().nullable(),
    }),
    signals: z.array(
      z.object({
        kind: z.enum(TRADING_ANOMALY_KINDS),
        status: z.enum(['ready', 'undecided', 'invalid']),
        settings: z.object({ count: reading, windowSeconds: reading, lookbackSeconds: reading }),
        rangeStartedAt: z.iso.datetime().nullable(),
        observedCandidates: count,
        candidatesTruncated: z.boolean(),
      }),
    ),
    candidates: z.array(tradingAnomalyCandidateSchema),
  })
  .meta({ id: 'TradingAnomalyReport' });
export type TradingAnomalyReport = z.infer<typeof tradingAnomalyReportSchema>;
export const tradingAnomalyQuerySchema = z
  .object({ marketId: uuidSchema.optional() })
  .strict()
  .meta({ id: 'TradingAnomalyQuery' });
export type TradingAnomalyQuery = z.infer<typeof tradingAnomalyQuerySchema>;
