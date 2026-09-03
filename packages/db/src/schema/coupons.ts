import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, updatedAt } from './columns.js';

/**
 * Admin-issued P grants (owner decision 2026-09-04, ADR-0026). A coupon carries an amount, an
 * optional expiry and an optional cap; `redeemed_count` is maintained inside the redemption
 * transaction, which takes the row lock, so a capped coupon can never overshoot.
 */
export const coupons = pgTable(
  'coupons',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Stored upper-case; the API upper-cases whatever the user types. */
    code: varchar({ length: 32 }).notNull().unique(),
    amountP: bigint({ mode: 'bigint' }).notNull(),
    /** null = unlimited redemptions. */
    maxRedemptions: integer(),
    redeemedCount: integer().notNull().default(0),
    expiresAt: timestamp({ withTimezone: true }),
    isActive: boolean().notNull().default(true),
    memo: text(),
    createdBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('coupons_amount_p_check', sql`${t.amountP} > 0`),
    check(
      'coupons_max_redemptions_check',
      sql`${t.maxRedemptions} is null or ${t.maxRedemptions} > 0`,
    ),
    check('coupons_redeemed_count_check', sql`${t.redeemedCount} >= 0`),
  ],
);

/**
 * One row per (coupon, account): the UNIQUE constraint is what stops a second redemption of
 * the same code by the same person, even under concurrent requests. `ledger_entries` points
 * at this row (`ref_type = 'coupon'`).
 */
export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    id: uuid().primaryKey().defaultRandom(),
    couponId: uuid()
      .notNull()
      .references(() => coupons.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** Snapshot of the coupon amount at redemption time. */
    amountP: bigint({ mode: 'bigint' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('coupon_redemptions_coupon_id_user_id_unique').on(t.couponId, t.userId),
    index('coupon_redemptions_user_id_created_at_idx').on(t.userId, desc(t.createdAt)),
  ],
);
