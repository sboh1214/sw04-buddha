import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz, updatedAt } from './columns.js';

/**
 * Admin-issued Coin grants (owner decision 2026-09-04, ADR-0026). A coupon carries an amount, an
 * optional expiry and an optional cap; `redeemed_count` is maintained inside the redemption
 * transaction, which takes the row lock, so a capped coupon can never overshoot.
 */
export const coupons = pgTable(
  'coupons',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Stored upper-case; the API upper-cases whatever the user types. */
    code: varchar({ length: 32 }).notNull().unique(),
    amountCoin: bigint({ mode: 'bigint' }).notNull(),
    /** null = unlimited redemptions. */
    maxRedemptions: integer(),
    redeemedCount: integer().notNull().default(0),
    expiresAt: timestampTz(),
    isActive: boolean().notNull().default(true),
    memo: text(),
    createdBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * `GET /admin/coupons`: the global list, ordered `(created_at DESC, id DESC)`. One of the
     * "전역 키셋 목록 넷" A-M3-10 handed to M6, and it arrives with the row-comparison cursor
     * predicate (`keysetPredicate`, apps/api) because the two are one change. This table showed
     * the largest index-alone trap of the four: measured at 2M rows the deep page was 198 ms
     * with NO index, 1158 ms with the index under the old OR-form predicate, and 0.13 ms with
     * both.
     */
    index('coupons_created_at_id_idx').on(desc(t.createdAt), desc(t.id)),
    check('coupons_amount_coin_check', sql`${t.amountCoin} > 0`),
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
    amountCoin: bigint({ mode: 'bigint' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('coupon_redemptions_coupon_id_user_id_unique').on(t.couponId, t.userId),
    index('coupon_redemptions_user_id_created_at_idx').on(t.userId, desc(t.createdAt)),
  ],
);
