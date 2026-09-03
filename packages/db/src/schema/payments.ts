import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('payments_amount_p_check', sql`${t.amountP} > 0`),
    check('payments_price_krw_check', sql`${t.priceKrw} > 0`),
  ],
);
