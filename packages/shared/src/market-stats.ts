import * as z from 'zod';

/** General freshness key for participant statistics, independent of price/trade count. */
export const statsRevisionSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const marketStatsEventSchema = z
  .object({
    type: z.literal('market:stats'),
    marketId: z.uuid(),
    traderCount: z.number().int().min(0),
    statsRevision: statsRevisionSchema,
  })
  .meta({ id: 'MarketStatsEvent' });
export type MarketStatsEvent = z.infer<typeof marketStatsEventSchema>;
