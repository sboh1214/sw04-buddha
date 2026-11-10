import { MAX_COIN_AMOUNT } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { timestampTz } from './columns.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { ledgerEntries } from './ledger.js';
import { marketEvents } from './market-events.js';
import { markets } from './markets.js';

/** One immutable terminal recall per market. Zero completion has no zero-valued ledger entry.
 * No actor/source policy here: an approved caller will wrap the internal primitive later.
 */
export const marketMakerRecalls = pgTable(
  'market_maker_recalls',
  {
    marketId: uuid()
      .primaryKey()
      .references(() => markets.id, { onDelete: 'restrict' }),
    terminalStatus: varchar({ length: 16 }).$type<'settled' | 'cancelled'>().notNull(),
    statusEventId: bigint({ mode: 'number' }).references(() => marketEvents.id, {
      onDelete: 'restrict',
    }),
    judgementVersion: integer(),
    fundsAccountId: bigint({ mode: 'number' }).references(() => ledgerAccounts.id, {
      onDelete: 'restrict',
    }),
    amountCoin: bigint({ mode: 'bigint' }).notNull(),
    ledgerEntryId: bigint({ mode: 'number' }).references(() => ledgerEntries.id, {
      onDelete: 'restrict',
    }),
    appliedTxid: text().notNull(),
    completedAt: timestampTz().notNull(),
  },
  (t) => [
    uniqueIndex('market_maker_recalls_ledger_unique').on(t.ledgerEntryId),
    check(
      'market_maker_recalls_terminal_check',
      sql`${t.terminalStatus} IN ('settled','cancelled')`,
    ),
    check(
      'market_maker_recalls_amount_check',
      sql`${t.amountCoin} BETWEEN 0 AND ${sql.raw(String(MAX_COIN_AMOUNT))}`,
    ),
    check(
      'market_maker_recalls_ledger_check',
      sql`(${t.amountCoin}>0)=(${t.ledgerEntryId} IS NOT NULL) AND (${t.fundsAccountId} IS NOT NULL OR ${t.amountCoin}=0)`,
    ),
  ],
);
