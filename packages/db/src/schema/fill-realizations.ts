import { sql } from 'drizzle-orm';
import { bigint, check, pgTable } from 'drizzle-orm/pg-core';
import { fills } from './fills.js';

/**
 * What a human seller realised on one trade fill (#124, ADR-0143): the net proceeds, the cost the
 * sale released from the position and their difference, as `applyTradeFill` (@buddha/db
 * contracts.ts) computed them when it moved the seller's position. A trade fill has one seller,
 * so the fill is the key (1:0..1) and names the owner; there is no `user_id` here. No row means
 * 'not recorded' — a pair mint, a buy, a 운영 마켓메이커 seller (its pair burns change cost and
 * realised P&L without a fill) — and a row never carries NULL. `fills` itself cannot take the
 * columns: `fills_keep_record` refuses UPDATE, so filling old rows would rewrite them.
 * Migration 0076 binds a row to its fill at INSERT (a `trade` fill, `proceeds_coin` =
 * `amount_coin − fee_coin`, a `member` seller) and refuses UPDATE and DELETE
 * (`fill_realizations_keep_record`); it also backfills the fills that came before it.
 */
export const fillRealizations = pgTable(
  'fill_realizations',
  {
    /** `fills.id` is a bigserial read as a number; the same mode keeps the two keys one type. */
    fillId: bigint({ mode: 'number' })
      .primaryKey()
      .references(() => fills.id, { onDelete: 'restrict' }),
    /** Net sale proceeds: the fill's `amount_coin − fee_coin` (the fee is 0 today). */
    proceedsCoin: bigint({ mode: 'bigint' }).notNull(),
    /** The cost basis the sale took out of the seller's position. */
    costReleasedCoin: bigint({ mode: 'bigint' }).notNull(),
    /** Realised P&L of this fill; negative when the contracts sold below their cost. */
    realizedPnlCoin: bigint({ mode: 'bigint' }).notNull(),
  },
  (t) => [
    // A sale pays nothing negative and releases no negative cost; only the P&L has a sign.
    check('fill_realizations_proceeds_coin_check', sql`${t.proceedsCoin} >= 0`),
    check('fill_realizations_cost_released_coin_check', sql`${t.costReleasedCoin} >= 0`),
    // The three amounts are one fact: a row whose P&L is not its proceeds minus its cost is
    // refused, so a reader may show any two and derive the third.
    check(
      'fill_realizations_realized_pnl_coin_check',
      sql`${t.realizedPnlCoin} = ${t.proceedsCoin} - ${t.costReleasedCoin}`,
    ),
  ],
);
