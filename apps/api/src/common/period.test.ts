/**
 * The recent-period predicate (#124, ADR-0143) as SQL text: no database. The edges of the window
 * are fixed here — the operator and the hours — and the integration tests of each list only show
 * one row inside and one outside it.
 */
import { schema } from '@buddha/db';
import { RECENT_PERIODS, RECENT_PERIOD_HOURS } from '@buddha/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { recentPeriodPredicate } from './period.js';

/** As the app's handle writes it: `casing` is what `createDb` (@buddha/db client.ts) passes. */
const render = (predicate: NonNullable<ReturnType<typeof recentPeriodPredicate>>) =>
  new PgDialect({ casing: 'snake_case' }).sqlToQuery(predicate);

describe('recentPeriodPredicate (#124)', () => {
  it('is no predicate without a period: the whole history', () => {
    expect(recentPeriodPredicate(schema.orders.createdAt, undefined)).toBeUndefined();
  });

  it('keeps the rows strictly newer than N × 24 hours before the database’s now()', () => {
    for (const [period, hours] of [
      ['7d', 168],
      ['30d', 720],
      ['90d', 2160],
    ] as const) {
      const { sql, params } = render(recentPeriodPredicate(schema.orders.createdAt, period)!);
      // `>`: the lower bound is open, so a row exactly N × 24 hours old is outside; no upper
      // bound, so the window ends at the read. The clock is the database's, not a parameter.
      expect(sql).toBe(`"orders"."created_at" > now() - $1::int * interval '1 hour'`);
      // The hours are bound, never spliced into the text.
      expect(params).toEqual([hours]);
      expect(RECENT_PERIOD_HOURS[period]).toBe(hours);
    }
    expect(RECENT_PERIODS).toHaveLength(3);
  });

  it('filters the column it is given: a fill’s time, a settlement’s payout time', () => {
    expect(render(recentPeriodPredicate(schema.fills.createdAt, '7d')!).sql).toBe(
      `"fills"."created_at" > now() - $1::int * interval '1 hour'`,
    );
    expect(render(recentPeriodPredicate(schema.positionSettlements.settledAt, '30d')!).sql).toBe(
      `"position_settlements"."settled_at" > now() - $1::int * interval '1 hour'`,
    );
  });
});
