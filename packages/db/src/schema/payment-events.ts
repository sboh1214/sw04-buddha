import { bigserial, index, jsonb, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt } from './columns.js';
import { payments } from './payments.js';

/**
 * Append-only log of every exchange with a PG about one payment (ADR-0042): the browser's
 * return, the approval and its inquiry, a stop, a 재통보, a net cancel, a refund cancel. It is
 * what reconstructs an outcome the logs deliberately leave out (no PG payload is logged).
 * buddha_app holds INSERT/SELECT only (migration 0015). `type`: PAYMENT_EVENT_TYPES in
 * @buddha/shared.
 *
 * `payload` is the PG's answer with the secrets taken out (merchant keys, passwords, signatures
 * derived from them) and the payer's personal fields.
 */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    /** RESTRICT: a payment with a PG history is never deleted (payments are never deleted). */
    paymentId: uuid()
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    type: varchar({ length: 32 }).notNull(),
    /** The PG's ResultCode (3001, 2001, …); null when the exchange carried none. */
    resultCode: varchar({ length: 16 }),
    resultMessage: text(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  // One payment's history in the order it happened.
  (t) => [index('payment_events_payment_id_id_idx').on(t.paymentId, t.id)],
);
