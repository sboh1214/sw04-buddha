import {
  OUTCOMES,
  type BookOrder,
  type HoldingFacts,
  type MarketTradingFacts,
} from '@buddha/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { readLiveBook } from './orders.js';
import { markets, positions } from './schema/index.js';
import { clockTimestamp } from './tx-helpers.js';

/*
 * 공개 호가와 견적의 읽기 (#179, ADR-0114): what the public book, the quote and a holder's sellable figures
 * read — the market's status, width and close (with the DB clock, #120), its live book without the
 * owners' account types, and one holder's two position rows. Readers only: no lock (never
 * `lockMarket`, so a read never waits on an intake or delays one) and no write. The API runs them
 * in one REPEATABLE READ READ ONLY transaction, so the status, the width, the book and the rows are
 * one snapshot: every writer of a market's status or orders holds its `lockMarket` and commits
 * whole, so the snapshot sees each intake, cancel or transition whole or not at all, and Postgres
 * refuses any write in it.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Db | Tx;

/**
 * A public market's trading facts (@buddha/shared `quoteOrder`, `orderBookOf`): its status, its
 * 가격 보호 폭, its 거래 마감 시각 and the DB clock read right after them, for
 * `marketTradingRejectReason`'s `close_at` refusal (#120); null for no such market and for one not
 * public yet (DRAFT, REVIEW → NOT_FOUND). In the API's snapshot transaction the SELECT is its first
 * statement and fixes the snapshot, and the clock read after it can only be later: a close the
 * snapshot sees committed (at or after `close_at`) always reads 'closed', and a read a moment
 * early errs toward 'closed'. Not `now()`, which is the transaction's start and can precede it.
 */
export async function readMarketTradingFacts(
  executor: Reader,
  marketId: string,
): Promise<MarketTradingFacts | null> {
  const [row] = await executor
    .select({
      status: markets.status,
      widthTicks: markets.priceProtectionTicks,
      closeAt: markets.closeAt,
    })
    .from(markets)
    .where(eq(markets.id, marketId));
  if (!row || row.status === 'draft' || row.status === 'review') return null;
  const now = await clockTimestamp(executor);
  return { status: row.status, widthTicks: row.widthTicks, closeAt: row.closeAt, now };
}

/**
 * The live book as the matcher and the public reads take it (`readLiveBook` without the owners'
 * account types): each field copied by name, so an account type cannot ride a spread into an
 * answer (ADR-0107 결정 5 '#179·#119'). The owners stay inside the walk (its self-trade rule).
 */
export async function readPublicBook(executor: Reader, marketId: string): Promise<BookOrder[]> {
  return (await readLiveBook(executor, marketId)).map((order) => ({
    id: order.id,
    owner: { id: order.owner.id, human: order.owner.human },
    outcome: order.outcome,
    side: order.side,
    priceCoin: order.priceCoin,
    remainingQty: order.remainingQty,
    arrival: order.arrival,
  }));
}

/**
 * `userId`'s two position rows of `marketId`, YES then NO — the held quantity and the part in
 * resting sells (`locked_qty`, #118) — a missing row as 0 and 0. Keyed by the holder alone: no
 * other account's row is read.
 */
export async function readHoldings(
  executor: Reader,
  userId: string,
  marketId: string,
): Promise<HoldingFacts[]> {
  const rows = await executor
    .select({ outcome: positions.outcome, qty: positions.qty, lockedQty: positions.lockedQty })
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.marketId, marketId)));
  return OUTCOMES.map((outcome) => {
    const row = rows.find((candidate) => candidate.outcome === outcome);
    return { outcome, qty: row?.qty ?? 0, lockedQty: row?.lockedQty ?? 0 };
  });
}
