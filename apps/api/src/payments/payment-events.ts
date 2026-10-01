import { schema, type Db } from '@buddha/db';
import { type PaymentEventType } from '@buddha/shared';
import { sql } from 'drizzle-orm';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Keys never stored (ADR-0042 「payment_events」): the merchant key and cancel password are ours;
 * HashData, EncData and EncryptData are derived from the merchant key. Matched
 * case-insensitively.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'merchantkey',
  'cancelpwd',
  'hashdata',
  'encdata',
  'encryptdata',
]);

/**
 * Personal data a PG echoes back (BuyerName, BuyerTel, BuyerEmail, a delivery address…).
 * `payment_events` is append-only and outlives the account — `user_contacts` is deleted with
 * it — so a copy here would be the one copy nobody can erase.
 */
const PERSONAL_KEY = /^(buyer|receiver|delivery|parent)/i;

/** Bounds on what a public callback can make us store. */
const MAX_KEYS = 64;
const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 500;
const RESULT_CODE_LENGTH = 16;

/** Postgres rejects U+0000 in text and jsonb (22021 / 22P05); a PG field is never worth a 500. */
function clean(value: string, max: number): string {
  const stripped = value.replaceAll('\u0000', '');
  return stripped.length <= max ? stripped : stripped.slice(0, max);
}

/**
 * A PG exchange as `payment_events.payload` stores it: secrets and personal fields dropped,
 * scalars kept, anything nested flattened to (bounded) JSON text, at most 64 keys.
 */
export function sanitizePayload(
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (kept >= MAX_KEYS) break;
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) continue;
    if (SECRET_KEYS.has(key.toLowerCase()) || PERSONAL_KEY.test(key)) continue;
    const cleanKey = clean(key, MAX_KEY_LENGTH);
    if (typeof value === 'string') payload[cleanKey] = clean(value, MAX_VALUE_LENGTH);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      payload[cleanKey] = value;
    } else if (value !== undefined) {
      payload[cleanKey] = clean(JSON.stringify(value) ?? '', MAX_VALUE_LENGTH);
    } else continue;
    kept += 1;
  }
  return payload;
}

export interface PaymentEventInput {
  paymentId: string;
  type: PaymentEventType;
  resultCode?: string | null;
  resultMessage?: string | null;
  /** Sanitised here; pass the PG's fields as they came. */
  payload?: Readonly<Record<string, unknown>>;
}

/** Appends one exchange to the payment's PG history (append-only: INSERT is all buddha_app has). */
export async function recordPaymentEvent(db: Db | Tx, event: PaymentEventInput): Promise<void> {
  await db.insert(schema.paymentEvents).values({
    paymentId: event.paymentId,
    type: event.type,
    resultCode:
      event.resultCode === undefined || event.resultCode === null
        ? null
        : clean(event.resultCode, RESULT_CODE_LENGTH),
    resultMessage:
      event.resultMessage === undefined || event.resultMessage === null
        ? null
        : clean(event.resultMessage, MAX_VALUE_LENGTH),
    payload: sanitizePayload(event.payload ?? {}),
  });
}

/** A PG message as `payments.result_message` stores it (shown to the payer). */
export function resultMessageOf(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const cleaned = clean(value, MAX_VALUE_LENGTH).trim();
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Whether the `payments` row a query reads has a net cancel the PG confirmed: a `net_cancel`
 * event whose outcome is `cancelled` — the PG's own answer, its cancel 재통보, or an admin's
 * settle after checking the merchant admin. As SQL over `schema.payments`, for a list; one
 * payment's is netCancelOutcome (payment-transitions), which asks the same question.
 */
export const netCancelConfirmed = sql<boolean>`exists (
  select 1 from ${schema.paymentEvents}
  where ${schema.paymentEvents.paymentId} = ${schema.payments.id}
    and ${schema.paymentEvents.type} = 'net_cancel'
    and ${schema.paymentEvents.payload}->>'outcome' = 'cancelled')`;
