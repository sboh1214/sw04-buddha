import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { adminMarketMakerSchema } from './admin-market-maker.js';
import { approvalReasonSchema } from './approvals.js';
import { coinAmountSchema } from './api/coin-amount.js';
import { cursorQuerySchema } from './api/pagination.js';
import { uuidSchema } from './api/uuid.js';
import { MAX_COIN_AMOUNT, ORDER_QTY_MAX } from './constants.js';
import { approvalStatusSchema } from './enums.js';
import { expectedAccountBodySchema } from './expected-account.js';
import { marketLiquiditySettingsSchema } from './market-liquidity.js';

export const MARKET_MAKER_CONTROL_KIND = 'market_maker_control';
const positiveCoin = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .refine((v) => /^[1-9]\d{0,15}$/.test(v) && BigInt(v) <= MAX_COIN_AMOUNT);
const counter = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(20);
const generation = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((v) => /^[1-9]\d{0,18}$/.test(v) && BigInt(v) < 9_223_372_036_854_775_807n);
export const marketMakerDemandSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    independentParticipants: approvalReasonSchema,
    bidirectionalTrading: approvalReasonSchema,
    actualDemand: approvalReasonSchema,
  })
  .strict()
  .refine((v) => Date.parse(v.from) < Date.parse(v.to), {
    path: ['to'],
    message: 'must follow from',
  });
export const marketMakerDemandSnapshotSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    capturedAt: z.iso.datetime(),
    lastFillId: counter,
    fillCount: counter,
    humanInvolvedFillCount: counter,
    humanHumanFillCount: counter,
    humanMakerFillCount: counter,
    distinctHumanAccounts: counter,
    humanBuyQty: counter,
    humanBuyCoin: counter,
    humanSellQty: counter,
    humanSellCoin: counter,
    firstFillAt: z.iso.datetime().nullable(),
    lastFillAt: z.iso.datetime().nullable(),
  })
  .strict();
export type MarketMakerDemandSnapshot = z.infer<typeof marketMakerDemandSnapshotSchema>;
export const marketMakerControlChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('stop') }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z
    .object({
      action: z.literal('settings'),
      settings: z
        .object({
          maxLossCoin: positiveCoin,
          levels: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
          quantity: z.number().int().min(1).max(ORDER_QTY_MAX),
          safetyTicks: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('increase'),
      additionalCoin: positiveCoin,
      demand: marketMakerDemandSchema,
    })
    .strict(),
]);
export type MarketMakerControlChange = z.infer<typeof marketMakerControlChangeSchema>;
export const requestMarketMakerControlBodySchema = expectedAccountBodySchema
  .extend({
    baseVersion: z.number().int().min(1).max(2_147_483_646),
    baseControlGeneration: generation,
    reason: approvalReasonSchema,
    change: marketMakerControlChangeSchema,
  })
  .strict()
  .meta({ id: 'RequestMarketMakerControlBody' });
export type RequestMarketMakerControlBody = z.infer<typeof requestMarketMakerControlBodySchema>;
export const decideMarketMakerControlBodySchema = expectedAccountBodySchema
  .extend({ reason: approvalReasonSchema })
  .strict()
  .meta({ id: 'DecideMarketMakerControlBody' });
export type DecideMarketMakerControlBody = z.infer<typeof decideMarketMakerControlBodySchema>;
export const marketMakerControlPayloadSchema = requestMarketMakerControlBodySchema
  .omit({ expectedAccountId: true, reason: true })
  .extend({
    beforeConfig: marketLiquiditySettingsSchema,
    beforeDesiredEnabled: z.boolean(),
    demandSnapshot: marketMakerDemandSnapshotSchema.nullable(),
  })
  .strict();
export type MarketMakerControlPayload = z.infer<typeof marketMakerControlPayloadSchema>;
export const MARKET_MAKER_CONTROL_REFUSALS = [
  'not_found',
  'not_allocated',
  'state',
  'close_passed',
  'held',
  'stale',
  'unchanged',
  'requester',
  'settings',
  'assets',
  'treasury',
  'insufficient_treasury',
  'capacity',
  'approval',
] as const;
export const marketMakerControlExecutionSchema = z
  .object({
    approvalId: uuidSchema,
    marketId: uuidSchema,
    action: z.enum(['stop', 'resume', 'settings', 'increase']),
    beforeVersion: z.number().int().positive(),
    afterVersion: z.number().int().positive(),
    beforeControlGeneration: generation,
    afterControlGeneration: counter,
    beforeDesiredEnabled: z.boolean(),
    afterDesiredEnabled: z.boolean(),
    additionalCoin: coinAmountSchema.nullable(),
    ledgerEntryId: counter.nullable(),
    performedAt: z.iso.datetime(),
  })
  .meta({ id: 'MarketMakerControlExecution' });
export type MarketMakerControlExecution = z.infer<typeof marketMakerControlExecutionSchema>;
export const marketMakerControlRequestSchema = z
  .object({
    id: uuidSchema,
    marketId: uuidSchema,
    payload: marketMakerControlPayloadSchema,
    requestedBy: adminAccountActorSchema,
    reason: z.string(),
    requestedAt: z.iso.datetime(),
    status: approvalStatusSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    decisionReason: z.string().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    retractedAt: z.iso.datetime().nullable(),
    execution: marketMakerControlExecutionSchema.nullable(),
  })
  .meta({ id: 'MarketMakerControlRequest' });
export type MarketMakerControlRequest = z.infer<typeof marketMakerControlRequestSchema>;
export const marketMakerControlWriteSchema = z
  .object({ request: marketMakerControlRequestSchema, marketMaker: adminMarketMakerSchema })
  .meta({ id: 'MarketMakerControlWrite' });
export type MarketMakerControlWrite = z.infer<typeof marketMakerControlWriteSchema>;
export const marketMakerControlRequestsQuerySchema = cursorQuerySchema.extend({
  status: z.enum(['pending', 'all']).default('pending'),
});
export type MarketMakerControlRequestsQuery = z.infer<typeof marketMakerControlRequestsQuerySchema>;
