import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { schema, type Db } from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  initState,
  marketSlugSchema,
  maxLossP,
  priceOf,
  serializePAmount,
  serializeQuantity,
  slugify,
  voidRefund,
  type AdminMarket,
  type CreateMarketBody,
  type MarketStatus,
  type MarketSummary,
  type UpdateMarketBody,
  type UserRealtimeEvent,
  type VoidMarketBody,
} from '@buddha/shared';
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { toBalance, type Page } from '../wallet/wallet.service.js';
import { lockMarket } from './market-lock.js';
import {
  lmsrStateOf,
  marketWithCategory,
  pYesBpOf,
  toMarket,
  toMarketSummary,
  type MarketRow,
} from './market.service.js';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Reads that run either inside a transaction or on the pool. */
type Executor = Db | Tx;

type PositionRow = typeof schema.positions.$inferSelect;
type BalanceRow = typeof schema.balances.$inferSelect;
type MarketEventRow = typeof schema.marketEvents.$inferSelect;

/** UNIQUE (slug) on markets (migration 0000). */
export const MARKET_SLUG_UNIQUE = 'markets_slug_unique';

/** PLAN 5.2: only a market that took (or could have taken) orders can be voided. */
const VOIDABLE_STATUSES: ReadonlySet<MarketStatus> = new Set<MarketStatus>([
  'open',
  'closed',
  'resolving',
]);

/** Events the admin detail shows, newest first. */
const ADMIN_EVENTS_LIMIT = 100;

/** Lower-case alphanumerics: the slug alphabet without '-', so a tag never ends a slug in '-'. */
const TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const TAG_LENGTH = 4;

function slugTag(): string {
  const bytes = randomBytes(TAG_LENGTH);
  let tag = '';
  for (const byte of bytes) tag += TAG_ALPHABET[byte % TAG_ALPHABET.length];
  return tag;
}

/**
 * `<slugify(title)>-<tag>`, or `market-<tag>` when nothing of the title survives (design
 * 3.4). Regenerated until `marketSlugSchema` accepts it — the tag makes a uuid shape
 * impossible in practice, but the schema is the contract, not the alphabet.
 */
export function generateSlug(title: string): string {
  const stem = slugify(title) || 'market';
  for (;;) {
    const candidate = `${stem}-${slugTag()}`;
    if (marketSlugSchema.safeParse(candidate).success) return candidate;
  }
}

function fieldError(path: string, message: string, detail: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ path: [path], message: detail }],
  });
}

/** Any state-machine violation other than the ones with their own code names `status`. */
function wrongStatus(status: MarketStatus): AppError {
  return fieldError('status', `Market is ${status}`, `market is ${status}`);
}

function assertFutureCloseAt(closeAt: Date, now: Date): void {
  if (closeAt.getTime() <= now.getTime()) {
    throw fieldError('closeAt', 'closeAt must be in the future', 'must be in the future');
  }
}

/**
 * What an `admin_actions` payload records about a market (jsonb: P as strings, dates as ISO,
 * never bigint). The LMSR quantities are already strings.
 */
function snapshot(row: MarketRow): Record<string, unknown> {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    rules: row.rules,
    resolutionSource: row.resolutionSource,
    categoryId: row.categoryId,
    imageUrl: row.imageUrl,
    status: row.status,
    liquidityB: row.liquidityB,
    qYes: row.qYes,
    qNo: row.qNo,
    initialProbBp: row.initialProbBp,
    reserveP: serializePAmount(row.reserveP),
    lastPrice: row.lastPrice,
    volumeP: serializePAmount(row.volumeP),
    tradeCount: row.tradeCount,
    traderCount: row.traderCount,
    openAt: row.openAt?.toISOString() ?? null,
    closeAt: row.closeAt.toISOString(),
    voidedAt: row.voidedAt?.toISOString() ?? null,
  };
}

/** LMSR columns for (p0, b): the create path and a draft re-init share this (ADR-0027). */
function lmsrColumns(initialProbBp: number, liquidityB: number) {
  const p0 = initialProbBp / 10_000;
  const state = initState(p0, liquidityB);
  return {
    liquidityB: liquidityB.toFixed(6),
    qYes: serializeQuantity(state.qYes),
    qNo: serializeQuantity(state.qNo),
    initialProbBp,
    reserveP: maxLossP(p0, liquidityB),
    lastPrice: priceOf(state),
  };
}

function toMarketEvent(row: MarketEventRow): AdminMarket['events'][number] {
  return {
    id: row.id.toString(),
    // varchar column; the DTO narrows it to MARKET_EVENT_TYPES.
    type: row.type as AdminMarket['events'][number]['type'],
    actorId: row.actorId,
    payload: row.payload ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** One closed-out position and, when P moved, the balance after it (published after commit). */
interface VoidRefund {
  position: PositionRow;
  balance: BalanceRow | undefined;
}

/**
 * Admin market CRUD and transitions (PLAN 5.2, 7.3, 12; M3 design 3.4). Every write is one
 * transaction with its `admin_actions` row and, for a transition, its `market_events` row;
 * open, close and void take the market's advisory lock first (`lockMarket`) so nothing
 * interleaves with a trade on the same market. Realtime events are published only after
 * COMMIT, best effort (MarketPublisher).
 */
@Injectable()
export class MarketAdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly publisher: MarketPublisher,
  ) {}

  /**
   * A new market is always a draft with LMSR state from `initState(p0, b)` and
   * `reserve_p = maxLossP(p0, b)` (ADR-0027). The slug is the admin's or derived from the
   * title; a taken slug is a VALIDATION_ERROR naming `slug` (the unique index decides).
   */
  async create(adminId: string, body: CreateMarketBody): Promise<AdminMarket> {
    const now = new Date();
    const closeAt = new Date(body.closeAt);
    assertFutureCloseAt(closeAt, now);
    const slug = body.slug ?? generateSlug(body.title);

    try {
      const row = await this.db.transaction(async (tx) => {
        await this.requireActiveCategory(tx, body.categoryId);
        const [row] = await tx
          .insert(schema.markets)
          .values({
            slug,
            title: body.title,
            description: body.description ?? null,
            rules: body.rules,
            resolutionSource: body.resolutionSource ?? null,
            categoryId: body.categoryId,
            imageUrl: body.imageUrl ?? null,
            mechanism: 'lmsr',
            status: 'draft',
            ...lmsrColumns(body.initialProbBp, body.liquidityB),
            openAt: null,
            closeAt,
            createdBy: adminId,
          })
          .returning();
        if (!row) throw new AppError('INTERNAL', { message: 'Market insert failed' });
        await tx.insert(schema.marketEvents).values({
          marketId: row.id,
          type: 'created',
          actorId: adminId,
          // The body is JSON-safe as parsed: strings, numbers and nulls only.
          payload: { ...body, slug },
        });
        await tx.insert(schema.adminActions).values({
          adminId,
          type: 'market_create',
          targetType: 'market',
          targetId: row.id,
          payload: { after: snapshot(row) },
        });
        return row;
      });
      return await this.get(row.id);
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, MARKET_SLUG_UNIQUE)) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'This slug is already taken',
          details: [{ path: ['slug'], message: 'already exists' }],
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * PATCH per status: a draft accepts every field (a new `initialProbBp` or `liquidityB`
   * re-initialises the LMSR state); an open market accepts the descriptive fields, the close
   * time and the category, and refuses `liquidityB`, `initialProbBp` and `slug` naming the
   * field; any other status refuses everything naming `status`. A rules change is also a
   * `rules_edited` market event (PLAN 12: allowed after a warning, which is the web's dialog).
   */
  async update(adminId: string, id: string, body: UpdateMarketBody): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockedRow(tx, id);
      if (current.status === 'open') {
        for (const field of ['liquidityB', 'initialProbBp', 'slug'] as const) {
          if (body[field] !== undefined) {
            throw fieldError(
              field,
              `${field} cannot change while the market is open`,
              'immutable while open',
            );
          }
        }
      } else if (current.status !== 'draft') {
        throw wrongStatus(current.status);
      }

      const now = new Date();
      const set: Partial<typeof schema.markets.$inferInsert> = { updatedAt: now };
      if (body.title !== undefined) set.title = body.title;
      if (body.description !== undefined) set.description = body.description ?? null;
      if (body.rules !== undefined) set.rules = body.rules;
      if (body.resolutionSource !== undefined) set.resolutionSource = body.resolutionSource ?? null;
      if (body.imageUrl !== undefined) set.imageUrl = body.imageUrl ?? null;
      if (body.slug !== undefined) set.slug = body.slug;
      if (body.categoryId !== undefined) {
        await this.requireActiveCategory(tx, body.categoryId);
        set.categoryId = body.categoryId;
      }
      if (body.closeAt !== undefined) {
        const closeAt = new Date(body.closeAt);
        assertFutureCloseAt(closeAt, now);
        set.closeAt = closeAt;
      }
      if (body.initialProbBp !== undefined || body.liquidityB !== undefined) {
        // Draft only (an open market was refused above): nobody holds contracts yet, so the
        // curve can be re-initialised as if the market had been created with these values.
        Object.assign(
          set,
          lmsrColumns(
            body.initialProbBp ?? current.initialProbBp,
            body.liquidityB ?? lmsrStateOf(current).b,
          ),
        );
      }

      let row: MarketRow | undefined;
      try {
        [row] = await tx
          .update(schema.markets)
          .set(set)
          .where(eq(schema.markets.id, id))
          .returning();
      } catch (error) {
        if (isPgError(error, PG_UNIQUE_VIOLATION, MARKET_SLUG_UNIQUE)) {
          throw new AppError('VALIDATION_ERROR', {
            message: 'This slug is already taken',
            details: [{ path: ['slug'], message: 'already exists' }],
            cause: error,
          });
        }
        throw error;
      }
      if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });

      if (body.rules !== undefined && body.rules.trim() !== current.rules.trim()) {
        await tx.insert(schema.marketEvents).values({
          marketId: id,
          type: 'rules_edited',
          actorId: adminId,
          payload: { before: current.rules, after: row.rules },
        });
      }
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_update',
        targetType: 'market',
        targetId: current.id,
        payload: { before: snapshot(current), after: snapshot(row) },
      });
      return this.toAdminMarket(tx, row);
    });
  }

  /**
   * draft → open (PLAN 0.2: never without rules). Writes the 'open' price tick the chart
   * starts from and the 'opened' event, then publishes `market:status`.
   */
  async open(adminId: string, id: string): Promise<AdminMarket> {
    const market = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await this.lockedRow(tx, id);
      if (current.status !== 'draft') throw wrongStatus(current.status);
      if (current.rules.trim() === '') {
        throw new AppError('RULES_REQUIRED', {
          message: 'Rules are required before a market opens',
          details: [{ path: ['rules'], message: 'required' }],
        });
      }
      const now = new Date();
      assertFutureCloseAt(current.closeAt, now);

      const [row] = await tx
        .update(schema.markets)
        .set({ status: 'open', openAt: now, updatedAt: now })
        .where(eq(schema.markets.id, id))
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });
      await tx.insert(schema.priceTicks).values({
        marketId: id,
        ts: now,
        pYesBp: pYesBpOf(row),
        trigger: 'open',
      });
      await tx.insert(schema.marketEvents).values({
        marketId: id,
        type: 'opened',
        actorId: adminId,
        payload: { openAt: now.toISOString(), closeAt: row.closeAt.toISOString() },
      });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_open',
        targetType: 'market',
        targetId: current.id,
        payload: { before: snapshot(current), after: snapshot(row) },
      });
      return this.toAdminMarket(tx, row);
    });
    await this.publishStatus(market);
    return market;
  }

  /** open → closed (the manual form of the M5 close job). Anything else: MARKET_NOT_OPEN. */
  async close(adminId: string, id: string): Promise<AdminMarket> {
    const market = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await this.lockedRow(tx, id);
      if (current.status !== 'open') {
        throw new AppError('MARKET_NOT_OPEN', { message: `Market is ${current.status}` });
      }
      const now = new Date();
      const [row] = await tx
        .update(schema.markets)
        .set({ status: 'closed', updatedAt: now })
        .where(eq(schema.markets.id, id))
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });
      await tx.insert(schema.marketEvents).values({
        marketId: id,
        type: 'closed',
        actorId: adminId,
        payload: { closedAt: now.toISOString() },
      });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_close',
        targetType: 'market',
        targetId: current.id,
        payload: { before: snapshot(current), after: snapshot(row) },
      });
      return this.toAdminMarket(tx, row);
    });
    await this.publishStatus(market);
    return market;
  }

  /**
   * Void (PLAN 5.5): every unsettled position gets its cost basis back as a
   * MARKET_VOID_REFUND ledger entry and is closed out (qty 0, settled), the market becomes
   * `voided`. One transaction, all rows or nothing (MVP scale). The status check runs under
   * the market lock so an M5 finalize cannot interleave, and the positions are locked in
   * (user_id, outcome) order — the same order finalize will use — so two settlements touching
   * one user's balance cannot deadlock. The refund is not bounded by `reserve_p`: it returns
   * what was paid, and earlier sells may already have realised part of it (ADR-0027).
   *
   * Instants come from the database clock after the locks, as in a trade: the void's own
   * after the market lock, each refund's after that account's balance lock (see clock.ts).
   */
  async void(adminId: string, id: string, body: VoidMarketBody): Promise<AdminMarket> {
    const { market, refunds } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await this.lockedRow(tx, id);
      if (!VOIDABLE_STATUSES.has(current.status)) throw wrongStatus(current.status);

      const holders = await tx
        .select()
        .from(schema.positions)
        .where(and(eq(schema.positions.marketId, id), eq(schema.positions.settled, false)))
        .orderBy(asc(schema.positions.userId), asc(schema.positions.outcome))
        .for('update');
      // After the last lock the void as a whole can wait on (the rows above never do: they
      // are only ever written under this market's lock, but the rule holds mechanically).
      const now = await clockTimestamp(tx);

      const refunds: VoidRefund[] = [];
      const refundedAccounts = new Set<string>();
      let refundedP = 0n;
      for (const position of holders) {
        const after = voidRefund(position);
        let balance: BalanceRow | undefined;
        if (after.refundP > 0n) {
          // The balance row first, then the clock: a trade or charge of this account may have
          // committed while this transaction waited (on the market lock, or on this very row),
          // and the refund's ledger row must sort after it. Left to the column default, the
          // row would carry transaction-start `now()` — older than that trade although its
          // balance_after_p already includes it — and `/me/ledger` would show them inverted.
          const [locked] = await tx
            .select({ userId: schema.balances.userId })
            .from(schema.balances)
            .where(eq(schema.balances.userId, position.userId))
            .limit(1)
            .for('update');
          if (!locked) {
            throw new AppError('NOT_FOUND', {
              message: `Balance not found for account ${position.userId}`,
            });
          }
          const refundedAt = await clockTimestamp(tx);
          [balance] = await tx
            .update(schema.balances)
            .set({
              availableP: sql`${schema.balances.availableP} + ${after.refundP}`,
              updatedAt: refundedAt,
            })
            .where(eq(schema.balances.userId, position.userId))
            .returning();
          if (!balance) {
            throw new AppError('NOT_FOUND', {
              message: `Balance not found for account ${position.userId}`,
            });
          }
          await tx.insert(schema.ledgerEntries).values({
            userId: position.userId,
            type: 'MARKET_VOID_REFUND',
            amountP: after.refundP,
            balanceAfterP: balance.availableP,
            refType: 'market',
            refId: current.id,
            memo: `무효 환불: ${current.title}`,
            createdAt: refundedAt,
          });
          refundedAccounts.add(position.userId);
          refundedP += after.refundP;
        }
        const [updated] = await tx
          .update(schema.positions)
          .set({ qty: after.qty, costBasisP: after.costBasisP, settled: true, updatedAt: now })
          .where(
            and(
              eq(schema.positions.userId, position.userId),
              eq(schema.positions.marketId, id),
              eq(schema.positions.outcome, position.outcome),
            ),
          )
          .returning();
        if (!updated) throw new AppError('INTERNAL', { message: 'Position update failed' });
        refunds.push({ position: updated, balance });
      }

      const [row] = await tx
        .update(schema.markets)
        .set({ status: 'voided', voidedAt: now, updatedAt: now })
        .where(eq(schema.markets.id, id))
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });
      const summary = {
        reason: body.reason,
        refundedAccounts: refundedAccounts.size,
        refundedP: serializePAmount(refundedP),
      };
      await tx.insert(schema.marketEvents).values({
        marketId: id,
        type: 'voided',
        actorId: adminId,
        payload: summary,
      });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_void',
        targetType: 'market',
        targetId: current.id,
        payload: { ...summary, before: snapshot(current), after: snapshot(row) },
      });
      return { market: await this.toAdminMarket(tx, row), refunds };
    });

    await this.publishStatus(market);
    const ts = market.voidedAt ?? market.updatedAt;
    // The last balance seen per account wins: a holder of both outcomes was credited twice.
    const balances = new Map<string, BalanceRow>();
    for (const { position, balance } of refunds) {
      if (balance) balances.set(position.userId, balance);
    }
    const events: [string, UserRealtimeEvent][] = [];
    for (const [userId, balance] of balances) {
      // Stamped with the account's own refund instant (its `updated_at`), not the void's: a
      // trade of this account elsewhere may sit between the two, and a client that keeps the
      // newest `user:balance` by ts must keep this one.
      events.push([
        userId,
        { type: 'user:balance', ...toBalance(balance), ts: balance.updatedAt.toISOString() },
      ]);
    }
    for (const { position } of refunds) {
      events.push([
        position.userId,
        {
          type: 'user:position',
          marketId: position.marketId,
          outcome: position.outcome,
          qty: position.qty,
          costBasisP: serializePAmount(position.costBasisP),
          realizedPnlP: serializePAmount(position.realizedPnlP),
          ts,
        },
      ]);
    }
    for (const [userId, event] of events) await this.publisher.publishUser(userId, event);
    return market;
  }

  /** Every status, draft included; newest first over (created_at DESC, id DESC). */
  async list(
    status: MarketStatus | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<MarketSummary>> {
    const { markets, categories } = schema;
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.db
      .select(marketWithCategory)
      .from(markets)
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .where(
        and(
          status ? eq(markets.status, status) : undefined,
          keyset
            ? or(
                lt(markets.createdAt, keyset.createdAt),
                and(eq(markets.createdAt, keyset.createdAt), lt(markets.id, keyset.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(markets.createdAt), desc(markets.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => toMarketSummary(row.market, row.category)),
      nextCursor:
        hasMore && last
          ? encodeKeyset({ createdAt: last.market.createdAt, id: last.market.id })
          : null,
    };
  }

  async get(id: string): Promise<AdminMarket> {
    const [row] = await this.db
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, id))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Market not found' });
    return this.toAdminMarket(this.db, row);
  }

  /** The row under `FOR UPDATE`, or NOT_FOUND. Callers hold the market lock when it matters. */
  private async lockedRow(tx: Tx, id: string): Promise<MarketRow> {
    const [row] = await tx
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, id))
      .limit(1)
      .for('update');
    if (!row) throw new AppError('NOT_FOUND', { message: 'Market not found' });
    return row;
  }

  /**
   * Unknown category: NOT_FOUND naming `categoryId`; a disabled one: VALIDATION_ERROR naming
   * it. FOR KEY SHARE so the row cannot vanish before the market row that references it is
   * written (the FK is ON DELETE RESTRICT, but a race would surface as a 500).
   */
  private async requireActiveCategory(tx: Tx, categoryId: number): Promise<void> {
    const [category] = await tx
      .select({ isActive: schema.categories.isActive })
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId))
      .limit(1)
      .for('key share');
    if (!category) {
      throw new AppError('NOT_FOUND', {
        message: 'Category not found',
        details: [{ path: ['categoryId'], message: 'not found' }],
      });
    }
    if (!category.isActive) {
      throw fieldError('categoryId', 'This category is disabled', 'inactive');
    }
  }

  /**
   * The admin detail: the public shape plus the LMSR state, exposure figures and the event
   * log. Reads through `executor` so a transition returns the state it just committed.
   */
  private async toAdminMarket(executor: Executor, row: MarketRow): Promise<AdminMarket> {
    const [category] = await executor
      .select({ slug: schema.categories.slug, nameKo: schema.categories.nameKo })
      .from(schema.categories)
      .where(eq(schema.categories.id, row.categoryId))
      .limit(1);
    if (!category) throw new AppError('INTERNAL', { message: 'Category row missing' });

    // Σ buy amounts − Σ sell amounts: what the AMM has collected net of what it paid out.
    const [collected] = await executor
      .select({
        net: sql<string>`coalesce(sum(case when ${schema.fills.side} = 'buy' then ${schema.fills.amountP} else -${schema.fills.amountP} end), 0)`,
      })
      .from(schema.fills)
      .where(eq(schema.fills.marketId, row.id));

    const interest = await executor
      .select({
        outcome: schema.positions.outcome,
        qty: sql<string>`coalesce(sum(${schema.positions.qty}), 0)`,
      })
      .from(schema.positions)
      .where(and(eq(schema.positions.marketId, row.id), eq(schema.positions.settled, false)))
      .groupBy(schema.positions.outcome);
    const openInterest = { yes: 0, no: 0 };
    for (const line of interest) {
      if (line.outcome === 'YES') openInterest.yes = Number(line.qty);
      else openInterest.no = Number(line.qty);
    }

    const events = await executor
      .select()
      .from(schema.marketEvents)
      .where(eq(schema.marketEvents.marketId, row.id))
      .orderBy(desc(schema.marketEvents.createdAt), desc(schema.marketEvents.id))
      .limit(ADMIN_EVENTS_LIMIT);

    return {
      ...toMarket(row, category),
      liquidityB: row.liquidityB,
      qYes: row.qYes,
      qNo: row.qNo,
      initialProbBp: row.initialProbBp,
      reserveP: serializePAmount(row.reserveP),
      createdBy: row.createdBy,
      updatedAt: row.updatedAt.toISOString(),
      // sum() over bigint is numeric, which pg hands over as a string of digits.
      netCollectedP: serializePAmount(BigInt(collected?.net ?? '0')),
      openInterest,
      events: events.map(toMarketEvent),
    };
  }

  /** `market:status` on the market's channel, after COMMIT (best effort). */
  private async publishStatus(market: AdminMarket): Promise<void> {
    await this.publisher.publishMarket(market.id, {
      type: 'market:status',
      marketId: market.id,
      status: market.status,
      resolvedResult: market.resolvedResult,
      disputeUntil: market.disputeUntil,
      ts: market.updatedAt,
    });
  }
}
