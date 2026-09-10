import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { chargePackages } from './charge-packages.js';
import { createdAt, updatedAt } from './columns.js';
import { paymentStatusEnum } from './enums.js';

/** Charges (P bought with KRW). MVP: provider 'mock' succeeds immediately (PLAN 1.2, M2). */
export const payments = pgTable(
  'payments',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** P credited to the balance. */
    amountP: bigint({ mode: 'bigint' }).notNull(),
    /** KRW actually charged (below amountP when the package carried a discount). */
    priceKrw: integer().notNull(),
    /**
     * The package bought. SET NULL on delete: an admin may retire a package, and the payment
     * keeps its own amount/price snapshot, so history survives (ADR-0026).
     */
    packageId: uuid().references(() => chargePackages.id, { onDelete: 'set null' }),
    /** PAYMENT_PROVIDERS in @buddha/shared ('mock' for now); a real PG adds its own value. */
    provider: varchar({ length: 32 }).notNull(),
    providerRef: text(),
    status: paymentStatusEnum().notNull().default('pending'),
    /**
     * The client's `Idempotency-Key` (PLAN 5.4), unique per account: a retry of a request
     * whose answer never arrived finds this row instead of buying again. The row is inserted
     * (as `pending`) before the provider is asked, so two requests racing on one key reach the
     * provider once. NOT NULL like `orders.idempotency_key` (PLAN 6.2); migration 0008 stamps
     * rows written before it with `legacy_<id>`, a key no client holds.
     */
    idempotencyKey: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // `/me/payments` is keyset-paginated per user, exactly like ledger_entries, orders and
    // coupon_redemptions; without this the page is a seq scan plus a sort over every user's
    // payments, and each cursor page costs the same again.
    index('payments_user_id_created_at_idx').on(t.userId, desc(t.createdAt)),
    /**
     * `GET /admin/payments`: the global list, ordered `(created_at DESC, id DESC)`.
     *
     * One of the "전역 키셋 목록 넷" the M2 and M3 reviews refused to index on its own and
     * handed to M6 (A-M3-10). It arrives together with the row-comparison cursor predicate
     * (`keysetPredicate`, apps/api) because the two are one change: an ordered index under the
     * old OR-form predicate pulls the planner off the bounded `Seq Scan + top-N Sort` and onto
     * an index walk whose Filter then discards every row in front of the cursor. Measured at
     * 2M rows: first page 3169 ms -> 0.34 ms, deep page 1069 ms -> 0.37 ms (64,757 -> 111
     * buffers); with the index but the OLD predicate the deep page was 679 ms.
     */
    index('payments_created_at_id_idx').on(desc(t.createdAt), desc(t.id)),
    // Per account, so one user's key can never collide with or probe another's.
    uniqueIndex('payments_user_id_idempotency_key_unique').on(t.userId, t.idempotencyKey),
    check('payments_amount_p_check', sql`${t.amountP} > 0`),
    check('payments_price_krw_check', sql`${t.priceKrw} > 0`),
  ],
);
