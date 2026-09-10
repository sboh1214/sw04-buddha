import { Inject, Injectable, Logger } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  type AdminDispute,
  type AdminDisputesQuery,
  type CreateDisputeBody,
  type Dispute,
  type MyDisputesQuery,
  type ReviewDisputeBody,
} from '@buddha/shared';
import { and, desc, eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Reads that run either inside a transaction or on the pool. */
type Executor = Db | Tx;

type DisputeRow = typeof schema.disputes.$inferSelect;
type MarketRow = typeof schema.markets.$inferSelect;

/** UNIQUE (market_id, user_id) on disputes (migration 0000): one objection per user per market. */
export const DISPUTE_MARKET_USER_UNIQUE = 'disputes_market_id_user_id_unique';

/**
 * What a dispute DTO needs from its market: the answer says which market, and where it stands.
 * `statusEventId` rides along for the admin row only (`toAdminDispute`): it is the order of the
 * status and result beside it (A-M3-19), and the admin list is the one reader that compares two
 * snapshots of one market.
 */
const marketColumns = {
  slug: schema.markets.slug,
  title: schema.markets.title,
  status: schema.markets.status,
  resolvedResult: schema.markets.resolvedResult,
  statusEventId: schema.markets.statusEventId,
};
type MarketColumns = Pick<
  MarketRow,
  'slug' | 'title' | 'status' | 'resolvedResult' | 'statusEventId'
>;

/** One dispute joined with its market (`GET /me/disputes`, and the answer to filing one). */
const disputeWithMarket = { dispute: schema.disputes, market: marketColumns };
/** The admin list adds who filed it: the nickname is the only name the admin UI shows. */
const disputeWithMarketAndFiler = { ...disputeWithMarket, nickname: schema.profiles.nickname };

function toDispute(row: DisputeRow, market: MarketColumns): Dispute {
  return {
    id: row.id,
    marketId: row.marketId,
    marketSlug: market.slug,
    marketTitle: market.title,
    marketStatus: market.status,
    resolvedResult: market.resolvedResult,
    reason: row.reason,
    evidenceUrl: row.evidenceUrl,
    status: row.status,
    adminNote: row.adminNote,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAdminDispute(row: DisputeRow, market: MarketColumns, nickname: string): AdminDispute {
  return {
    ...toDispute(row, market),
    userId: row.userId,
    nickname,
    reviewedBy: row.reviewedBy,
    // A bigint on the wire as a decimal string, the way `MarketSummary` carries the same column.
    statusEventId: market.statusEventId === null ? null : String(market.statusEventId),
  };
}

/** PLAN 7.4 DISPUTE_WINDOW_CLOSED: the market is past the point where an objection can matter. */
function windowClosed(message: string): AppError {
  return new AppError('DISPUTE_WINDOW_CLOSED', { message });
}

/**
 * Disputes (PLAN 5.5, 7.2, 7.3, 12; M5 design 3.4). A user objects to a proposed result while
 * the market is `resolving` and its window is open; an admin reviews the objection
 * (accepted / rejected + note). Accepting changes nothing on the market by itself — the admin
 * changes the result through `POST /admin/markets/:id/resolve`, explicitly (PLAN 12: two
 * steps), and finalize runs on `dispute_until` whether or not disputes are open (PLAN 5.5).
 *
 * Filing takes no market advisory lock, and the reason is NOT that it would queue objections
 * behind trades: a filing is legal only on `resolving` and `assertTradable` (market.service.ts)
 * refuses every status but `open` on a one-way ladder, so no trade that gets anywhere can hold
 * the lock on a disputable market. What the lock WOULD queue a filing behind is `void`
 * (market-admin.service.ts) and `finalizeMarket` (worker), which hold it across the whole
 * close-out — one transaction, all rows or nothing (A-M5-4), a handful of statements per
 * position — with only `statement_timeout` (30s, client.ts) bounding the wait, and a
 * `pg_advisory_xact_lock` killed there is a 500, not an answer.
 *
 * So the status check is a plain read inside the filing transaction (READ COMMITTED, like every
 * transaction here) and the race it leaves is a finalize OR a void committing between that read
 * and the INSERT — the void is the wider half, since an admin may void at any instant of the
 * window while the finalize variant needs the two clock reads to straddle `dispute_until`. The
 * filer gets 201 carrying the market as it was read at the top of the transaction, and the 201
 * guarantees only what it says: the filing's own `clock_timestamp()` — the clock finalize
 * compares `dispute_until` against — fell inside the window. It does not promise the market was
 * still `resolving` at COMMIT.
 *
 * That is not a loss, because it is the state the design produces with no race at all: finalize
 * runs whether or not disputes are open (PLAN 5.5) and a void leaves them as they are on purpose
 * (Q-M5-6), so an `open` dispute on a terminal market is the ordinary end of a filing nobody
 * reviewed in time. Taking the lock would not remove it — a filing that won the lock is followed
 * by the same finalize — it would only turn this one 201 into a slow 409. What reviewing such a
 * dispute cannot do is move the payout, since `resolve` refuses a terminal market; it records a
 * verdict the filer still reads (design 5.3), which is as true of every dispute left open when
 * finalize runs as it is of this race (A-M5-23).
 *
 * The one thing a filing writes that a market writer reads is a display value: the admin
 * detail's `disputeCounts`, which `resolve` and `void` count inside their own transaction
 * (`toAdminMarket`), so a filing committing beside them can leave that count one short in the
 * answer they hand back, until the next fetch re-asks the lists (A-M5-22). Nothing else in
 * apps/api or apps/worker reads this table.
 */
@Injectable()
export class DisputeService {
  private readonly logger = new Logger(DisputeService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `POST /markets/:id/disputes`. Error precedence: a draft (or unknown id) is NOT_FOUND like
   * every public route — only admins know a draft exists; `settled`/`voided`, or `resolving`
   * with the window already past on the DATABASE clock, is DISPUTE_WINDOW_CLOSED (the client
   * refetches the market and shows the closed state); `open`/`closed` is a VALIDATION_ERROR
   * naming `status` (nothing has been proposed, so there is nothing to object to). A second
   * filing by the same user is refused by the UNIQUE index as DUPLICATE_REQUEST — the index
   * decides, so two racing requests cannot both succeed.
   *
   * The clock is read after the market row, inside the transaction, and stamps `created_at`
   * (clock.ts): the window comparison and the row's own instant come from the same clock the
   * worker's finalize compares `dispute_until` against, never the API host's.
   */
  async file(userId: string, marketId: string, body: CreateDisputeBody): Promise<Dispute> {
    const dispute = await this.db.transaction(async (tx) => {
      const [market] = await tx
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, marketId))
        .limit(1);
      if (!market || market.status === 'draft') {
        throw new AppError('NOT_FOUND', { message: 'Market not found' });
      }
      if (market.status === 'settled' || market.status === 'voided') {
        throw windowClosed(`Market is ${market.status}; disputes are closed`);
      }
      if (market.status !== 'resolving') {
        throw new AppError('VALIDATION_ERROR', {
          message: 'No result has been proposed yet',
          details: [{ path: ['status'], message: `market is ${market.status}` }],
        });
      }
      const now = await clockTimestamp(tx);
      // A `resolving` row always carries `dispute_until` (resolve() writes both in one UPDATE);
      // a null one is a row written outside that path, and a window that cannot be verified
      // is treated as closed rather than open — the conservative reading of PLAN 5.5.
      if (market.disputeUntil === null || market.disputeUntil.getTime() <= now.getTime()) {
        throw windowClosed('Dispute window has closed');
      }

      let row: DisputeRow | undefined;
      try {
        [row] = await tx
          .insert(schema.disputes)
          .values({
            marketId,
            userId,
            reason: body.reason,
            evidenceUrl: body.evidenceUrl ?? null,
            status: 'open',
            createdAt: now,
          })
          .returning();
      } catch (error) {
        if (isPgError(error, PG_UNIQUE_VIOLATION, DISPUTE_MARKET_USER_UNIQUE)) {
          throw new AppError('DUPLICATE_REQUEST', {
            message: 'You already filed a dispute for this market',
            cause: error,
          });
        }
        throw error;
      }
      if (!row) throw new AppError('INTERNAL', { message: 'Dispute insert failed' });
      return toDispute(row, market);
    });
    // PLAN 5.5: the admin notification on a filing is console-only in the MVP. After COMMIT,
    // so the line is never written for a filing that rolled back.
    this.logger.log(`dispute filed market=${marketId} user=${userId} dispute=${dispute.id}`);
    return dispute;
  }

  /** `GET /me/disputes`: the caller's own, newest first over (created_at DESC, id DESC). */
  async listMine(userId: string, query: MyDisputesQuery): Promise<Page<Dispute>> {
    const { disputes, markets } = schema;
    // 'uuid': disputes.id is a uuid column, and a malformed id half would be a 22P02 (a 500)
    // rather than an empty page (pagination.ts).
    const keyset = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select(disputeWithMarket)
      .from(disputes)
      .innerJoin(markets, eq(markets.id, disputes.marketId))
      .where(
        and(
          eq(disputes.userId, userId),
          query.marketId ? eq(disputes.marketId, query.marketId) : undefined,
          keyset ? keysetPredicate(disputes.createdAt, disputes.id, keyset, 'uuid') : undefined,
        ),
      )
      .orderBy(desc(disputes.createdAt), desc(disputes.id))
      .limit(query.limit + 1);
    return page(rows, query.limit, (row) => toDispute(row.dispute, row.market));
  }

  /** `GET /admin/disputes`: every user's, newest first, optionally one status / one market. */
  async listAdmin(query: AdminDisputesQuery): Promise<Page<AdminDispute>> {
    const { disputes, markets, profiles } = schema;
    const keyset = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select(disputeWithMarketAndFiler)
      .from(disputes)
      .innerJoin(markets, eq(markets.id, disputes.marketId))
      .innerJoin(profiles, eq(profiles.userId, disputes.userId))
      .where(
        and(
          query.status ? eq(disputes.status, query.status) : undefined,
          query.marketId ? eq(disputes.marketId, query.marketId) : undefined,
          keyset ? keysetPredicate(disputes.createdAt, disputes.id, keyset, 'uuid') : undefined,
        ),
      )
      .orderBy(desc(disputes.createdAt), desc(disputes.id))
      .limit(query.limit + 1);
    return page(rows, query.limit, (row) => toAdminDispute(row.dispute, row.market, row.nickname));
  }

  /**
   * `PATCH /admin/disputes/:id`: the verdict (accepted / rejected) and the admin's note, with
   * an `admin_actions` row of type `dispute_review` recording before and after. A review may
   * be revised (accepted ↔ rejected) — the body schema is what keeps `open` out of reach, so
   * a dispute never returns to the queue. An omitted `adminNote` leaves the stored note as
   * it is and an explicit null clears it, the same reading of PATCH as the market update.
   *
   * The dispute row is taken FOR UPDATE so two admins reviewing at once serialise and each
   * audit row's `before` is the state the other left; the clock is read after that lock
   * (clock.ts) so `reviewed_at` and the audit row sort after whatever committed meanwhile.
   * No market lock: a review changes nothing on the market (PLAN 12).
   */
  async review(adminId: string, disputeId: string, body: ReviewDisputeBody): Promise<AdminDispute> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.disputes)
        .where(eq(schema.disputes.id, disputeId))
        .limit(1)
        .for('update');
      if (!current) throw new AppError('NOT_FOUND', { message: 'Dispute not found' });
      const now = await clockTimestamp(tx);

      const [row] = await tx
        .update(schema.disputes)
        .set({
          status: body.status,
          adminNote: body.adminNote === undefined ? current.adminNote : body.adminNote,
          reviewedBy: adminId,
          reviewedAt: now,
        })
        .where(eq(schema.disputes.id, disputeId))
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Dispute update failed' });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'dispute_review',
        targetType: 'dispute',
        targetId: disputeId,
        payload: {
          before: { status: current.status, adminNote: current.adminNote },
          after: { status: row.status, adminNote: row.adminNote },
          marketId: row.marketId,
          userId: row.userId,
        },
        createdAt: now,
      });
      // Read inside the transaction like every other write path: after the commit it would be
      // a fresh snapshot on the pool and could already show another admin's revision in the
      // answer to "here is what you decided".
      return await this.adminDispute(tx, row);
    });
  }

  /** The admin shape of a row this transaction just wrote: its market and filer, read through `executor`. */
  private async adminDispute(executor: Executor, row: DisputeRow): Promise<AdminDispute> {
    const [market] = await executor
      .select(marketColumns)
      .from(schema.markets)
      .where(eq(schema.markets.id, row.marketId))
      .limit(1);
    const [profile] = await executor
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, row.userId))
      .limit(1);
    // Both are FK targets (ON DELETE RESTRICT on the market; the profile cascades only with
    // the user, which the dispute's own FK restricts), so a miss is corruption, not a race.
    if (!market) throw new AppError('INTERNAL', { message: 'Market row missing' });
    if (!profile) throw new AppError('INTERNAL', { message: 'Profile row missing' });
    return toAdminDispute(row, market, profile.nickname);
  }
}

/** The `limit + 1` rows of a keyset query into a page; the extra row only says there is more. */
function page<Row extends { dispute: DisputeRow }, Item>(
  rows: Row[],
  limit: number,
  toItem: (row: Row) => Item,
): Page<Item> {
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept.at(-1);
  return {
    items: kept.map(toItem),
    nextCursor:
      hasMore && last
        ? encodeKeyset({ createdAt: last.dispute.createdAt, id: last.dispute.id })
        : null,
  };
}
