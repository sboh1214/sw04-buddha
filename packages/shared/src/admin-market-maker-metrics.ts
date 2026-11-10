import * as z from 'zod';
import { coinAmountSchema } from './api/coin-amount.js';
import { marketStatusSchema, releaseSettingStatusSchema, marketResultSchema } from './enums.js';
import { cursorQuerySchema } from './api/pagination.js';
import { adminTreasurySchema } from './treasury.js';

/** Counts, quantities and ratios can outgrow the JSON safe-integer range, just like capital. */
const count = z.string().regex(/^(0|[1-9]\d*)$/);
const pnlByResult = z.object({
  YES: coinAmountSchema,
  NO: coinAmountSchema,
  VOID: coinAmountSchema,
});
const unavailable = z.object({ kind: z.enum(['unavailable', 'inconsistent']), reason: z.string() });
const readyRisk = z.object({
  kind: z.literal('ready'),
  assets: z.object({
    coin: count,
    availableCoin: count,
    lockedCoin: count,
    yesQty: count,
    noQty: count,
    yesLockedQty: count,
    noLockedQty: count,
  }),
  capital: z.object({ investedCoin: count, recoveredCoin: count }),
  maxLossCoin: count,
  worstLossCoin: count,
  reservedWorstLossCoin: count,
  utilizationBp: count,
  stage: z.enum(['normal', 'reduce', 'halt']).nullable(),
  stageStatus: z.enum(['ready', 'undecided', 'invalid']),
  pnl: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('scenarios'),
      holdings: pnlByResult,
      reserved: pnlByResult,
      provisionalResult: marketResultSchema.nullable(),
    }),
    z.object({
      kind: z.literal('actual'),
      amountCoin: coinAmountSchema,
      reason: z.enum(['paid', 'cancelled']),
      result: marketResultSchema.nullable(),
    }),
  ]),
});
const levels = z.array(z.object({ priceCoin: z.number().int().min(1).max(99), qty: count }));
const contractDepth = z.object({ bids: levels, asks: levels });
const depth = z.object({ YES: contractDepth, NO: contractDepth });
const concentrationSide = z.object({
  totalQty: count,
  topQty: count.nullable(),
  topShareBp: count.nullable(),
  holders: z
    .array(
      z.object({
        userId: z.string(),
        nickname: z.string().nullable(),
        qty: count,
        shareBp: count,
      }),
    )
    .nullable(),
});

/** Admin-only current observations. No historical rates, outage intervals or alert policy. */
export const adminMarketMakerMetricsSchema = z
  .object({
    marketId: z.uuid(),
    title: z.string(),
    status: marketStatusSchema,
    asOf: z.iso.datetime(),
    configVersion: z.number().int().positive().nullable(),
    openedVersion: z.number().int().positive().nullable(),
    risk: z.union([readyRisk, unavailable]),
    depth: z.object({ bot: depth, human: depth }),
    concentration: z.object({
      setting: z.object({
        key: z.string(),
        status: releaseSettingStatusSchema,
        value: z.number().int().positive().nullable(),
      }),
      YES: concentrationSide,
      NO: concentrationSide,
    }),
  })
  .meta({ id: 'AdminMarketMakerMetrics' });
export type AdminMarketMakerMetrics = z.infer<typeof adminMarketMakerMetricsSchema>;

export const adminMarketMakerMetricsListItemSchema = adminMarketMakerMetricsSchema
  .omit({ depth: true, concentration: true })
  .extend({
    runtime: z
      .object({
        desiredEnabled: z.boolean(),
        state: z.enum(['ready', 'waiting', 'stopped', 'error']),
        reason: z.string().nullable(),
      })
      .nullable(),
  })
  .meta({ id: 'AdminMarketMakerMetricsListItem' });
export type AdminMarketMakerMetricsListItem = z.infer<typeof adminMarketMakerMetricsListItemSchema>;
export const listMarketMakerMetricsQuerySchema = cursorQuerySchema
  .extend({})
  .meta({ id: 'ListMarketMakerMetricsQuery' });
export type ListMarketMakerMetricsQuery = z.infer<typeof listMarketMakerMetricsQuerySchema>;

/** All actually funded markets, including legacy/terminal ones; never a page subtotal. */
export const adminMarketMakerMetricsOverviewSchema = z
  .object({
    asOf: z.iso.datetime(),
    scope: z.literal('funded_markets'),
    marketCount: count,
    readyCount: count,
    complete: z.boolean(),
    treasury: adminTreasurySchema,
    totals: z.object({
      worstLossCoin: count,
      reservedWorstLossCoin: count,
      maxLossCoin: count,
      investedCoin: count,
      recoveredCoin: count,
      fundsCoin: count,
    }),
    missing: z.array(
      z.object({
        marketId: z.uuid(),
        kind: z.enum(['unavailable', 'inconsistent']),
        reason: z.string(),
      }),
    ),
  })
  .meta({ id: 'AdminMarketMakerMetricsOverview' });
export type AdminMarketMakerMetricsOverview = z.infer<typeof adminMarketMakerMetricsOverviewSchema>;
