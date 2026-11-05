/**
 * Contract test helpers (#118, ADR-0110): reads of a market's contract books and a person with a
 * Coin lock, for the tests of contracts.ts and of the issues that call it (#117, #119, #178, #120,
 * #129). Every write goes through contracts.ts, as production's does.
 */
import type { Outcome } from '@buddha/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { lockForOrder, type PositionRow } from '../contracts.js';
import { positions } from '../schema/index.js';
import { createMarket, createUser } from './factories.js';
import { ledgerAccountBalance } from './ledger.js';

/** The row of (owner, market, outcome), or undefined when there is none. */
export async function positionOf(
  db: Db,
  ownerId: string,
  marketId: string,
  outcome: Outcome,
): Promise<PositionRow | undefined> {
  const [row] = await db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.userId, ownerId),
        eq(positions.marketId, marketId),
        eq(positions.outcome, outcome),
      ),
    );
  return row;
}

/** A market's contract books: what full collateral keeps equal (`yes === no`, collateral). */
export interface ContractBook {
  /** Unsettled contracts of each outcome, every holder's. */
  yes: number;
  no: number;
  /** Of those, the contracts live sell orders hold. */
  lockedYes: number;
  lockedNo: number;
  /** The market collateral's ledger total (0 when it has no account yet). */
  collateralCoin: bigint;
}

/**
 * The contract books of `marketId`. Full collateral (ADR-0107 결정 1 #177 1항) is `yes === no` and
 * `collateralCoin === BigInt(yes) * PAYOUT_PER_CONTRACT_COIN`.
 */
export async function contractBook(db: Db, marketId: string): Promise<ContractBook> {
  const sumOf = (outcome: Outcome, column: typeof positions.qty | typeof positions.lockedQty) =>
    sql<string>`coalesce(sum(${column}) filter (where ${positions.outcome} = ${outcome}), 0)::text`;
  const [row] = await db
    .select({
      yes: sumOf('YES', positions.qty),
      no: sumOf('NO', positions.qty),
      lockedYes: sumOf('YES', positions.lockedQty),
      lockedNo: sumOf('NO', positions.lockedQty),
    })
    .from(positions)
    .where(and(eq(positions.marketId, marketId), eq(positions.settled, false)));
  const collateral = await ledgerAccountBalance(db, { kind: 'market_collateral', marketId });
  return {
    yes: Number(row!.yes),
    no: Number(row!.no),
    lockedYes: Number(row!.lockedYes),
    lockedNo: Number(row!.lockedNo),
    collateralCoin: collateral?.ledgerCoin ?? 0n,
  };
}

export interface LockedBuyerInput {
  /** The Coin the person starts with (its start grant). */
  coin: bigint;
  /** The Coin its buy locks (`lockForOrder`), at most `coin`. */
  lock: bigint;
  /** The market of the lock. Default: a new OPEN market. */
  marketId?: string;
}

/**
 * A person holding `coin`, `lock` of it locked for a buy in a market (`lockForOrder`), as #119's
 * intake will leave it — no order row is written. Returns the person's id and the market's.
 */
export async function lockedBuyer(
  db: Db,
  input: LockedBuyerInput,
): Promise<{ userId: string; marketId: string }> {
  const marketId = input.marketId ?? (await createMarket(db)).id;
  const { user } = await createUser(db, { balanceCoin: input.coin });
  const locked = await db.transaction((tx) =>
    lockForOrder(tx, {
      marketId,
      ownerId: user.id,
      lock: { kind: 'coin', amountCoin: input.lock },
    }),
  );
  if (!locked.locked) throw new Error(`lockedBuyer: ${locked.reason}`);
  return { userId: user.id, marketId };
}
