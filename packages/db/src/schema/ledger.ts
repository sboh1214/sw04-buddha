import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt } from './columns.js';
import { ledgerEntryTypeEnum } from './enums.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { markets } from './markets.js';

/**
 * Append-only ledger (PLAN 5.6), one row per event (#116, ADR-0109): `amount_coin` (positive)
 * moves from `from_account_id` to `to_account_id` — a mint has no from-account, a burn no
 * to-account. Which pairs a type takes is LEDGER_ENTRY_RULES (@buddha/shared), repeated by
 * migration 0060's BEFORE INSERT trigger with the market, the chain of totals and the closed
 * accounts. Each side's `*_balance_after_coin` is that account's ledger total right after the
 * event — its balance row's `ledger_coin`, which is available + locked unless an owner-level write
 * left a gap (ADR-0109 결정 12-8) — so an account's latest entry says what its ledger holds. Written
 * only by `recordLedgerEntry` (@buddha/db); buddha_app holds INSERT/SELECT only (migration 0001),
 * and no role may UPDATE or DELETE a row (0060's trigger).
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    type: ledgerEntryTypeEnum().notNull(),
    amountCoin: bigint({ mode: 'bigint' }).notNull(),
    fromAccountId: bigint({ mode: 'number' }).references(() => ledgerAccounts.id, {
      onDelete: 'restrict',
    }),
    toAccountId: bigint({ mode: 'number' }).references(() => ledgerAccounts.id, {
      onDelete: 'restrict',
    }),
    fromBalanceAfterCoin: bigint({ mode: 'bigint' }),
    toBalanceAfterCoin: bigint({ mode: 'bigint' }),
    /** The event's market: every market event's, and only theirs (LEDGER_ENTRY_RULES `market`). */
    marketId: uuid().references(() => markets.id, { onDelete: 'restrict' }),
    /** LEDGER_REF_TYPES in @buddha/shared: what `ref_id` points at, the event's source. */
    refType: varchar({ length: 32 }).notNull(),
    refId: text().notNull(),
    /**
     * Unique per type (`ledgerKeys`, @buddha/db): the same source recorded twice is one event — a
     * request id, a fill id, a settlement key (#116 수용 기준).
     */
    idempotencyKey: text().notNull(),
    /** Written by code only (a settlement's market title); never names an account. */
    memo: text(),
    createdAt: createdAt(),
  },
  (t) => [
    check('ledger_entries_amount_coin_check', sql`${t.amountCoin} > 0`),
    check(
      'ledger_entries_sides_check',
      sql`(${t.fromAccountId} IS NOT NULL OR ${t.toAccountId} IS NOT NULL)
        AND ${t.fromAccountId} IS DISTINCT FROM ${t.toAccountId}`,
    ),
    check(
      'ledger_entries_balance_after_check',
      sql`(${t.fromAccountId} IS NULL) = (${t.fromBalanceAfterCoin} IS NULL)
        AND (${t.toAccountId} IS NULL) = (${t.toBalanceAfterCoin} IS NULL)
        AND (${t.fromBalanceAfterCoin} IS NULL OR ${t.fromBalanceAfterCoin} >= 0)
        AND (${t.toBalanceAfterCoin} IS NULL OR ${t.toBalanceAfterCoin} >= 0)`,
    ),
    check('ledger_entries_idempotency_key_check', sql`${t.idempotencyKey} <> ''`),
    uniqueIndex('ledger_entries_type_idempotency_key_unique').on(t.type, t.idempotencyKey),
    /** An account's events as listed, from either side: its ledger, the audit's sums. */
    index('ledger_entries_from_account_created_at_idx').on(t.fromAccountId, t.createdAt, t.id),
    index('ledger_entries_to_account_created_at_idx').on(t.toAccountId, t.createdAt, t.id),
    /**
     * An account's latest event, from either side: its chain of totals, which 0060's guards follow
     * by id — commit order for one account, drawn under its balance lock — and never by the clock,
     * which may step back.
     */
    index('ledger_entries_from_account_id_idx').on(t.fromAccountId, t.id),
    index('ledger_entries_to_account_id_idx').on(t.toAccountId, t.id),
    index('ledger_entries_market_id_idx')
      .on(t.marketId, t.id)
      .where(sql`${t.marketId} IS NOT NULL`),
    index('ledger_entries_ref_type_ref_id_idx').on(t.refType, t.refId),
    /**
     * One forfeiture per closed account (#140, '탈퇴 소멸'): its entry refers to the account itself
     * (`account_closure`), so a second closure — two requests at once — cannot forfeit twice.
     * Migrations 0043 and 0060's triggers hold the rest: such an entry is the CLOSURE_FORFEIT of
     * the account it names, and nothing is written for a closed account after it.
     */
    uniqueIndex('ledger_entries_account_closure_unique')
      .on(t.refId)
      .where(sql`${t.refType} = 'account_closure'`),
  ],
);
