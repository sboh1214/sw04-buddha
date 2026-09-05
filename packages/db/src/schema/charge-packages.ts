import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgTable, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns.js';

/**
 * What a user may buy (owner decision 2026-09-04, ADR-0026): a fixed amount of P for a fixed
 * KRW price. The discount is `1 - price_krw / amount_p`, derived rather than stored, and the
 * CHECK keeps P from ever being sold above face value. Admins add, edit and remove rows at
 * runtime; `payments` snapshots both numbers, so removing a package never rewrites history.
 */
export const chargePackages = pgTable(
  'charge_packages',
  {
    id: uuid().primaryKey().defaultRandom(),
    amountP: bigint({ mode: 'bigint' }).notNull(),
    priceKrw: integer().notNull(),
    sortOrder: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('charge_packages_amount_p_check', sql`${t.amountP} > 0`),
    check('charge_packages_price_krw_check', sql`${t.priceKrw} > 0`),
    // P is sold at a discount or at par, never above face value.
    check('charge_packages_price_within_face_value_check', sql`${t.priceKrw} <= ${t.amountP}`),
    index('charge_packages_active_sort_idx').on(t.isActive, t.sortOrder),
  ],
);
