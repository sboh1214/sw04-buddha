import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { coinAmountInputSchema, coinAmountSchema } from './api/coin-amount.js';
import { uuidSchema } from './api/uuid.js';
import { approvalReasonSchema } from './approvals.js';
import { MAX_COIN_AMOUNT, ORDER_QTY_MAX } from './constants.js';
import { expectedAccountIdSchema } from './expected-account.js';

/** The same double domain as the LMSR curve: both its reciprocal and 100·b are finite. */
export const liquidityCurveBSchema = z
  .number()
  .positive()
  .refine(
    (b) => Number.isFinite(1 / b) && Number.isFinite(100 * b),
    'must have a finite reciprocal and payout product',
  );
const ladderShape = {
  b: liquidityCurveBSchema,
  levels: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  quantity: z.number().int().min(1).max(ORDER_QTY_MAX),
  safetyTicks: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
};
const positiveCoinInput = coinAmountInputSchema.refine(
  (coin) => coin > 0n && coin <= MAX_COIN_AMOUNT,
  'must be positive and no greater than MAX_COIN_AMOUNT',
);

/** Admin-only market terms; no default is inferred for a missing field or an old market. */
export const marketLiquiditySettingsSchema = z
  .object({
    budgetCoin: coinAmountSchema,
    maxLossCoin: coinAmountSchema,
    ...ladderShape,
  })
  .meta({ id: 'MarketLiquiditySettings' });
export type MarketLiquiditySettings = z.infer<typeof marketLiquiditySettingsSchema>;

/** Explicit request input. Coin is parsed as bigint, never through a JSON number. */
export const marketLiquiditySettingsInputSchema = z
  .object({
    budgetCoin: positiveCoinInput,
    maxLossCoin: positiveCoinInput,
    ...ladderShape,
  })
  .strict()
  .refine((settings) => settings.maxLossCoin <= settings.budgetCoin, {
    path: ['maxLossCoin'],
    message: 'must not exceed budgetCoin',
  });
export type MarketLiquiditySettingsInput = z.infer<typeof marketLiquiditySettingsInputSchema>;

export const marketLiquidityVersionSchema = marketLiquiditySettingsSchema
  .extend({
    marketId: uuidSchema,
    version: z.number().int().positive(),
    reason: z.string(),
    createdAt: z.iso.datetime(),
    createdBy: adminAccountActorSchema,
  })
  .meta({ id: 'MarketLiquidityVersion' });
export type MarketLiquidityVersion = z.infer<typeof marketLiquidityVersionSchema>;

export const adminMarketLiquiditySchema = z
  .object({
    current: marketLiquidityVersionSchema.nullable(),
    openedVersion: z.number().int().positive().nullable(),
    history: z.array(marketLiquidityVersionSchema),
  })
  .meta({ id: 'AdminMarketLiquidity' });
export type AdminMarketLiquidity = z.infer<typeof adminMarketLiquiditySchema>;

export const setMarketLiquidityBodySchema = z
  .object({
    settings: marketLiquiditySettingsInputSchema,
    baseVersion: z.number().int().min(1).max(2_147_483_647).nullable(),
    reason: approvalReasonSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .strict()
  .meta({ id: 'SetMarketLiquidityBody' });
export type SetMarketLiquidityBody = z.infer<typeof setMarketLiquidityBodySchema>;

export const MARKET_LIQUIDITY_REFUSALS = [
  'not_found',
  'forbidden',
  'non_draft',
  'stale',
  'unchanged',
] as const;
export type MarketLiquidityRefusal = (typeof MARKET_LIQUIDITY_REFUSALS)[number];
