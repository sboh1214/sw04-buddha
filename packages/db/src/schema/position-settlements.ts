import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { timestampTz } from './columns.js';
import { marketResultEnum, outcomeEnum } from './enums.js';
import { ledgerEntries } from './ledger.js';
import { marketJudgements } from './market-judgements.js';
import { marketRuleVersions } from './market-rule-versions.js';
import { markets } from './markets.js';

/**
 * The permanent settlement of a positive holding (#126). Zero-payout losers have a record;
 * positions already at zero do not. Its quantity and cost survive retirement of the live row.
 * A market settles once, so the primary key also refuses a second judgement's payment of it.
 * NULL judgementVersion preserves pre-version markets; their ledger key says `legacy`.
 * Migration 0064 makes these records immutable and binds them to their position and payout.
 */
export const positionSettlements = pgTable(
  'position_settlements',
  {
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    outcome: outcomeEnum().notNull(),
    judgementVersion: integer(),
    ruleVersion: integer(),
    result: marketResultEnum().notNull(),
    qty: integer().notNull(),
    costBasisCoin: bigint({ mode: 'bigint' }).notNull(),
    realizedPnlBeforeCoin: bigint({ mode: 'bigint' }).notNull(),
    payoutPerContractCoin: integer().notNull(),
    payoutCoin: bigint({ mode: 'bigint' }).notNull(),
    settlementPnlCoin: bigint({ mode: 'bigint' }).notNull(),
    ledgerEntryId: bigint({ mode: 'number' })
      .unique('position_settlements_ledger_entry_id_unique')
      .references(() => ledgerEntries.id, { onDelete: 'restrict' }),
    settledAt: timestampTz().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.marketId, t.userId, t.outcome] }),
    foreignKey({
      name: 'position_settlements_judgement_fk',
      columns: [t.marketId, t.judgementVersion],
      foreignColumns: [marketJudgements.marketId, marketJudgements.version],
    }).onDelete('restrict'),
    foreignKey({
      name: 'position_settlements_rule_fk',
      columns: [t.marketId, t.ruleVersion],
      foreignColumns: [marketRuleVersions.marketId, marketRuleVersions.version],
    }).onDelete('restrict'),
    check('position_settlements_qty_check', sql`${t.qty} > 0`),
    check('position_settlements_cost_check', sql`${t.costBasisCoin} >= 0`),
    check(
      'position_settlements_version_check',
      sql`${t.judgementVersion} > 0 AND ${t.ruleVersion} > 0`,
    ),
    check(
      'position_settlements_payout_check',
      sql`${t.payoutPerContractCoin} = CASE WHEN ${t.result} = 'VOID' THEN 50 WHEN ${t.result}::text = ${t.outcome}::text THEN 100 ELSE 0 END AND ${t.payoutCoin} = ${t.qty}::bigint * ${t.payoutPerContractCoin}`,
    ),
    check(
      'position_settlements_pnl_check',
      sql`${t.settlementPnlCoin} = ${t.payoutCoin} - ${t.costBasisCoin}`,
    ),
    check(
      'position_settlements_ledger_check',
      sql`(${t.payoutCoin} > 0) = (${t.ledgerEntryId} IS NOT NULL)`,
    ),
  ],
);
