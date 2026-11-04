import { sql } from 'drizzle-orm';
import { bigserial, check, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt } from './columns.js';
import { ledgerAccountKindEnum } from './enums.js';
import { markets } from './markets.js';

/**
 * 원장 계정 (#116, ADR-0109; ADR-0107 결정 2 #73 1·11항): what the ledger moves Coin between —
 * identity only; the money is the account's `balances` row. Four kinds:
 * - `user`: a person's own, one per person's account (admins and closed accounts too), made with
 *   the account by the "user" trigger (migration 0060). The 운영 마켓메이커 has none.
 * - `treasury`: the operating treasury, one, with no owner.
 * - `market_collateral`: a market's collateral, one per market, with no owner.
 * - `market_maker_funds`: a market's 마켓메이커 자금, one per market, owned by the 운영 마켓메이커.
 * The last three are made when an event first names them (`ensureLedgerAccount`, @buddha/db).
 * A row never changes and is never deleted (migration 0060's trigger, every role); buddha_app holds
 * INSERT and SELECT. Whose an account is, is asked of `isHumanAccountSql(owner_id)` — false for
 * the treasury and the collateral (no owner) and for the 마켓메이커 자금 — never of `kind`.
 */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    /** The ledger-account key, and the order every writer locks balances in (ascending). */
    id: bigserial({ mode: 'number' }).primaryKey(),
    kind: ledgerAccountKindEnum().notNull(),
    /** The person (`user`), the 운영 마켓메이커 (`market_maker_funds`), or null. */
    ownerId: text().references(() => user.id, { onDelete: 'restrict' }),
    /** The market of a collateral or a 마켓메이커 자금 account, else null. */
    marketId: uuid().references(() => markets.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'ledger_accounts_shape_check',
      sql`(${t.kind} = 'user' AND ${t.ownerId} IS NOT NULL AND ${t.marketId} IS NULL)
        OR (${t.kind} = 'treasury' AND ${t.ownerId} IS NULL AND ${t.marketId} IS NULL)
        OR (${t.kind} = 'market_collateral' AND ${t.ownerId} IS NULL AND ${t.marketId} IS NOT NULL)
        OR (${t.kind} = 'market_maker_funds' AND ${t.ownerId} IS NOT NULL
            AND ${t.marketId} IS NOT NULL)`,
    ),
    /** One user account per person. */
    uniqueIndex('ledger_accounts_user_uidx')
      .on(t.ownerId)
      .where(sql`${t.kind} = 'user'`),
    /** One operating treasury. */
    uniqueIndex('ledger_accounts_treasury_uidx')
      .on(t.kind)
      .where(sql`${t.kind} = 'treasury'`),
    /** One collateral and one 마켓메이커 자금 per market. */
    uniqueIndex('ledger_accounts_market_uidx')
      .on(t.marketId, t.kind)
      .where(sql`${t.marketId} IS NOT NULL`),
  ],
);
