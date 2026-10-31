import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  RELATED_MARKET_STATUSES,
  relatedMarketPair,
  type AdminRelatedMarket,
  type MarketSummary,
} from '@buddha/shared';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';
import { marketOrder } from './market-order.js';
import { MarketService, marketWithCategory, toMarketSummary } from './market.service.js';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Reads that run either inside a transaction or on the pool. */
type Executor = Db | Tx;

/**
 * The request field that carries the other market of a pair: the body's `marketId` on a link,
 * the path's `relatedMarketId` on an unlink. A refusal about that market names it in `details`,
 * the field the request actually sent, as every other refusal here names its own field.
 */
type OtherMarketField = 'marketId' | 'relatedMarketId';

/**
 * The markets linked to `marketId`, from either end of the pair (market-links.ts): the larger id
 * of the rows where it is the smaller one — the primary key's leading column — and the smaller id
 * of the rows where it is the larger one (`market_links_high_market_id_idx`). A predicate on
 * `markets.id`, so the list query keeps the shape of every other card list and its order can be
 * `marketOrder`'s.
 */
function linkedTo(db: Executor, marketId: string) {
  const { marketLinks, markets } = schema;
  return or(
    inArray(
      markets.id,
      db
        .select({ id: marketLinks.highMarketId })
        .from(marketLinks)
        .where(eq(marketLinks.lowMarketId, marketId)),
    ),
    inArray(
      markets.id,
      db
        .select({ id: marketLinks.lowMarketId })
        .from(marketLinks)
        .where(eq(marketLinks.highMarketId, marketId)),
    ),
  );
}

/**
 * 관련 시장 (#65, ADR-0068): the links between markets, read on a detail and kept by an admin.
 *
 * Owner decisions (ADR-0061 decision 1, item 19; decision 3, the #65 rows): two-way and with no
 * cap; a detail lists the linked markets in RELATED_MARKET_STATUSES — every public status but
 * CANCELLED — whose result is not VOID (ADR-0093 decision 3, the #174 row), in the home's 추천
 * order (`marketOrder`, the one place every market order lives), as the home's cards; only an
 * admin links and unlinks, in any status of either market, and each change records its actor
 * and time alone. A link is read by nothing but these routes: no rule, order, judgement
 * or settlement path looks at `market_links`, so a link cannot change either market's.
 *
 * A link or an unlink that changes the state writes one `admin_actions` row in the same
 * transaction (`market_link` / `market_unlink`, the two ids in the payload); a repeated link or
 * an unlink of nothing writes none. Two admins racing for one pair are ordered by the primary key
 * — the second insert waits for the first and then conflicts, the second delete waits and then
 * finds nothing — so the audit log never records a change the table did not make (the rule the
 * watchlist's events follow, ADR-0064).
 */
@Injectable()
export class RelatedMarketsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly markets: MarketService,
  ) {}

  /**
   * `GET /markets/:id/related`: a public market's related markets, ordered by 추천 — the 24-hour
   * volume, then the actual open time, then the id — and keyset-paginated on 추천's own cursor,
   * whose first page fixes the window as the home's does (market-order.ts). NOT_FOUND for an
   * unknown market and for a DRAFT or REVIEW one, as the detail and its other sub-resources
   * answer. A cursor that does not decode serves the first page.
   *
   * The linked markets shown are `isRelatedMarketShown`'s: a status in RELATED_MARKET_STATUSES and
   * a result other than VOID, in whatever status it holds that result — a PROVISIONAL VOID too,
   * since the result is not a status. `IS DISTINCT FROM`, so a market with no result yet stays.
   *
   * `marketOrder`'s status is `undefined`, "every public status", for what it says about the list
   * — it can hold ended markets — which only 마감 임박 reads; 추천 does not.
   */
  async listPublic(
    marketId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<MarketSummary>> {
    await this.markets.requirePublic(marketId);
    const { markets, categories } = schema;
    const order = marketOrder(this.db, 'recommended', cursor, undefined);
    let select = this.db
      .select({ ...marketWithCategory, order: order.fields })
      .from(markets)
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .$dynamic();
    if (order.lateral) select = select.crossJoinLateral(order.lateral);
    const rows = await select
      .where(
        and(
          linkedTo(this.db, marketId),
          inArray(markets.status, [...RELATED_MARKET_STATUSES]),
          sql`${markets.resolvedResult} IS DISTINCT FROM 'VOID'`,
          order.after,
        ),
      )
      .orderBy(...order.orderBy)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => toMarketSummary(row.market, row.category)),
      nextCursor: hasMore && last ? order.cursorOf(last) : null,
    };
  }

  /**
   * `GET /admin/markets/:id/related`: every market linked to one market, whatever either's status
   * and result (DRAFT, REVIEW, CANCELLED and VOID ones included — the admin keeps the links, the
   * reader's rule filters them), the latest link first. NOT_FOUND for an unknown market.
   */
  async listAdmin(marketId: string): Promise<AdminRelatedMarket[]> {
    await this.requireMarkets(this.db, marketId);
    return this.adminRows(this.db, marketId);
  }

  /**
   * Links two markets and answers the market's links as they now stand. A market with itself is
   * refused naming `marketId`, the body's field; an unknown market is NOT_FOUND (naming `marketId`
   * when it is the body's). A pair that is linked already — from either side — changes nothing and
   * writes no audit row.
   */
  async link(
    adminId: string,
    marketId: string,
    relatedMarketId: string,
  ): Promise<AdminRelatedMarket[]> {
    const pair = this.pairOf(marketId, relatedMarketId, 'marketId');
    return this.db.transaction(async (tx) => {
      await this.requireMarkets(tx, marketId, { id: relatedMarketId, field: 'marketId' });
      const now = await clockTimestamp(tx);
      const inserted = await tx
        .insert(schema.marketLinks)
        .values({ ...pair, createdBy: adminId, createdAt: now })
        .onConflictDoNothing()
        .returning({ lowMarketId: schema.marketLinks.lowMarketId });
      if (inserted.length > 0) {
        await this.audit(tx, adminId, 'market_link', marketId, relatedMarketId, now);
      }
      return this.adminRows(tx, marketId);
    });
  }

  /**
   * Unlinks two markets and answers the market's links as they now stand. The same refusals as
   * `link`, naming the path's `relatedMarketId` where a link names the body's `marketId` — an
   * unlink has no body; a pair that is not linked changes nothing and writes no audit row.
   */
  async unlink(
    adminId: string,
    marketId: string,
    relatedMarketId: string,
  ): Promise<AdminRelatedMarket[]> {
    const pair = this.pairOf(marketId, relatedMarketId, 'relatedMarketId');
    const { marketLinks } = schema;
    return this.db.transaction(async (tx) => {
      await this.requireMarkets(tx, marketId, { id: relatedMarketId, field: 'relatedMarketId' });
      const now = await clockTimestamp(tx);
      const deleted = await tx
        .delete(marketLinks)
        .where(
          and(
            eq(marketLinks.lowMarketId, pair.lowMarketId),
            eq(marketLinks.highMarketId, pair.highMarketId),
          ),
        )
        .returning({ lowMarketId: marketLinks.lowMarketId });
      if (deleted.length > 0) {
        await this.audit(tx, adminId, 'market_unlink', marketId, relatedMarketId, now);
      }
      return this.adminRows(tx, marketId);
    });
  }

  /** The stored pair, or the refusal of a market paired with itself, naming the other's field. */
  private pairOf(marketId: string, relatedMarketId: string, field: OtherMarketField) {
    const pair = relatedMarketPair(marketId, relatedMarketId);
    if (pair === undefined) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'A market cannot be related to itself',
        details: [{ path: [field], message: 'must be another market' }],
      });
    }
    return pair;
  }

  /**
   * NOT_FOUND unless the market — and the other one, when there is one — names a market, in any
   * status (an admin links drafts too). The path's market comes first, so its absence is the plain
   * NOT_FOUND of every admin market route; the other market's NOT_FOUND names the field that
   * carried it (`OtherMarketField`).
   */
  private async requireMarkets(
    executor: Executor,
    marketId: string,
    other?: { id: string; field: OtherMarketField },
  ): Promise<void> {
    const ids = other === undefined ? [marketId] : [marketId, other.id];
    const rows = await executor
      .select({ id: schema.markets.id })
      .from(schema.markets)
      .where(inArray(schema.markets.id, ids));
    const found = new Set(rows.map((row) => row.id));
    if (!found.has(marketId)) throw new AppError('NOT_FOUND', { message: 'Market not found' });
    if (other !== undefined && !found.has(other.id)) {
      throw new AppError('NOT_FOUND', {
        message: 'Market not found',
        details: [{ path: [other.field], message: 'not found' }],
      });
    }
  }

  /** The audit row of a change (ADR-0061 decision 1, item 19: actor and time; both ends named). */
  private async audit(
    tx: Tx,
    adminId: string,
    type: 'market_link' | 'market_unlink',
    marketId: string,
    relatedMarketId: string,
    now: Date,
  ): Promise<void> {
    await tx.insert(schema.adminActions).values({
      adminId,
      type,
      targetType: 'market',
      targetId: marketId,
      payload: { marketId, relatedMarketId },
      createdAt: now,
    });
  }

  /**
   * One market's links for the admin: the other end of every pair it is in, with who linked it
   * and when, the latest link first (then the market id, so two links of one millisecond keep one
   * order). Read through `executor` so a write answers the state it just committed.
   *
   * Who linked it is the admin's id and current nickname (owner decision 2026-10-17: the screen
   * names the admin by nickname), read from `profiles` here — the link stores the id alone, as
   * every admin record does. Every account has a profile (trigger 0002) and the linking admin's
   * account cannot be deleted under a link (RESTRICT); the join is LEFT only so that a missing
   * profile could never hide a link from the one screen that unlinks it.
   */
  private async adminRows(executor: Executor, marketId: string): Promise<AdminRelatedMarket[]> {
    const { marketLinks, markets, categories, profiles } = schema;
    const other = sql`CASE WHEN ${marketLinks.lowMarketId} = ${marketId}::uuid THEN ${marketLinks.highMarketId} ELSE ${marketLinks.lowMarketId} END`;
    const rows = await executor
      .select({
        ...marketWithCategory,
        linkedBy: marketLinks.createdBy,
        linkedByNickname: profiles.nickname,
        linkedAt: marketLinks.createdAt,
      })
      .from(marketLinks)
      .innerJoin(markets, eq(markets.id, other))
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .leftJoin(profiles, eq(profiles.userId, marketLinks.createdBy))
      .where(or(eq(marketLinks.lowMarketId, marketId), eq(marketLinks.highMarketId, marketId)))
      .orderBy(desc(marketLinks.createdAt), desc(markets.id));
    return rows.map((row) => ({
      ...toMarketSummary(row.market, row.category),
      linkedBy: { id: row.linkedBy, nickname: row.linkedByNickname },
      linkedAt: row.linkedAt.toISOString(),
    }));
  }
}
