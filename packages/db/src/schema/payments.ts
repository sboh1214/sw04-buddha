import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
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
    amountP: bigint({ mode: 'bigint' }).notNull(),
    /** PAYMENT_PROVIDERS in @buddha/shared ('mock' for now); a real PG adds its own value. */
    provider: varchar({ length: 32 }).notNull(),
    providerRef: text(),
    status: paymentStatusEnum().notNull().default('pending'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('payments_amount_p_check', sql`${t.amountP} > 0`)],
);
