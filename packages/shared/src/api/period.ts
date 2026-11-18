import * as z from 'zod';

/**
 * The period filter of a person's own lists (#124, ADR-0143; ADR-0135 G3·결과 4): the trade and
 * settlement history (`GET /me/orders`, `/me/fills`, `/me/settlements`) and, with the same
 * format, the wallet (#69). A fixed choice, sent as the query key `period`; omitted means the
 * whole history — there is no `all` value. '최근 N일' is N × 24 hours back from the instant the
 * server reads the list (the database clock), never a calendar day or a time zone, and the
 * filtered time is the one the list is ordered by.
 */
export const RECENT_PERIODS = ['7d', '30d', '90d'] as const;
export type RecentPeriod = (typeof RECENT_PERIODS)[number];

/** `period` of a list's query. */
export const recentPeriodSchema = z.enum(RECENT_PERIODS);

/** The hours each period reaches back: N days × 24. */
export const RECENT_PERIOD_HOURS = {
  '7d': 168,
  '30d': 720,
  '90d': 2160,
} as const satisfies Record<RecentPeriod, number>;
