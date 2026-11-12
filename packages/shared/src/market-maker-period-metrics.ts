import * as z from 'zod';

const count = z.string().regex(/^(0|[1-9]\d*)$/);
const ratio = count.nullable();

/** Admin-only, opening-to-observation totals. No personal history or automatic control. */
export const marketMakerPeriodMetricsSchema = z
  .object({
    window: z.object({ from: z.iso.datetime().nullable(), to: z.iso.datetime() }),
    activity: z.object({
      basis: z.literal('recorded_orders'),
      coverage: z.enum(['complete', 'partial', 'unavailable']),
      bot: z.object({ postedQty: count, filledQty: count, fillBp: ratio }).nullable(),
      humanIoc: z.object({ orders: count, filledOrders: count, fillBp: ratio }).nullable(),
    }),
    supply: z.object({
      basis: z.literal('posted_book'),
      coverage: z.enum(['complete', 'partial', 'unavailable']),
      observedFrom: z.iso.datetime().nullable(),
      observedTo: z.iso.datetime().nullable(),
      openMs: count.nullable(),
      botGapMs: count.nullable(),
      combinedGapMs: count.nullable(),
    }),
  })
  .meta({ id: 'MarketMakerPeriodMetrics' });
export type MarketMakerPeriodMetrics = z.infer<typeof marketMakerPeriodMetricsSchema>;
