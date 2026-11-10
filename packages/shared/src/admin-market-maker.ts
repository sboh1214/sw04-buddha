import * as z from 'zod';
import { coinAmountSchema } from './api/coin-amount.js';
import { marketLiquidityVersionSchema } from './market-liquidity.js';
import { releaseSettingStatusSchema } from './enums.js';

const generation = z.string().regex(/^(0|[1-9]\d*)$/);
const stageReading = z.object({
  key: z.string(),
  status: releaseSettingStatusSchema,
  value: z.number().nullable(),
});
export const MARKET_MAKER_READINESS_BLOCKERS = [
  'market_not_open',
  'ledger_hold',
  'liquidity_missing',
  'risk_settings_missing',
  'risk_settings_invalid',
  'intake_closed',
  'not_allocated',
  'disabled',
] as const;

/** Private observations only: an old success is distinct from the conditions read now. */
export const adminMarketMakerSchema = z
  .object({
    marketId: z.uuid(),
    config: marketLiquidityVersionSchema.nullable(),
    openedVersion: z.number().int().positive().nullable(),
    runtime: z
      .object({
        desiredEnabled: z.boolean(),
        generation,
        completedGeneration: generation,
        state: z.enum(['ready', 'waiting', 'stopped', 'error']),
        reason: z.string().nullable(),
        lastConfigVersion: z.number().int().positive(),
        lastAttemptAt: z.iso.datetime().nullable(),
        lastSuccessAt: z.iso.datetime().nullable(),
        lastFailureAt: z.iso.datetime().nullable(),
        lastError: z.string().nullable(),
        consecutiveFailures: z.number().int().nonnegative(),
        updatedAt: z.iso.datetime(),
      })
      .nullable(),
    stageSettings: z.object({
      status: z.enum(['ready', 'undecided', 'invalid']),
      reduceAtBp: stageReading,
      haltAtBp: stageReading,
      reduceRatioBp: stageReading,
    }),
    readiness: z.object({ blockers: z.array(z.enum(MARKET_MAKER_READINESS_BLOCKERS)) }),
    lastOpenAttempt: z
      .object({
        lastAttemptAt: z.iso.datetime(),
        reason: z.string().nullable(),
        requiredCoin: coinAmountSchema.nullable(),
        availableCoin: coinAmountSchema.nullable(),
        liquidityVersion: z.number().int().positive().nullable(),
        succeededAt: z.iso.datetime().nullable(),
      })
      .nullable(),
  })
  .meta({ id: 'AdminMarketMaker' });
export type AdminMarketMaker = z.infer<typeof adminMarketMakerSchema>;
