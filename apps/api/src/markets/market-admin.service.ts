import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  type MarketEventType,
  type MarketStatus,
  type MarketSummary,
  type ResolveMarketBody,
  type UpdateMarketBody,
  type UserRealtimeEvent,
  type VoidMarketBody,
} from '@buddha/shared';
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { type Env } from '../config/env.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
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

/** PLAN 12: a market trades against its rules, so it cannot open — or stay open — without them. */
function rulesRequired(message: string): AppError {
  return new AppError('RULES_REQUIRED', {
    message,
    details: [{ path: ['rules'], message: 'required' }],
  });
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
  /** The MARKET_VOID_REFUND row's id: the account's order key for its `user:balance` event. */
  ledgerEntryId: number | undefined;
}

/**
 * Admin market CRUD and transitions (PLAN 5.2, 5.5, 7.3, 12; M3 design 3.4, M5 design 3.3).
 * Every write is one transaction with its `admin_actions` row and, for a transition, its
 * `market_events` row; open, close, resolve and void take the market's advisory lock first
 * (`lockMarket`) so nothing interleaves with a trade on the same market. Realtime events are
 * published, and the worker's delayed jobs registered or cancelled, only after COMMIT, best
 * effort (MarketPublisher, MarketJobs).
 *
 * Every transition inserts its event row FIRST and stores that row's id in
 * `markets.status_event_id` in the same UPDATE (`recordEvent`): the id is drawn while the
 * transaction holds the row FOR UPDATE, so it is the market's commit order, and it is the key
 * `market:status` and the market DTOs are ordered by (A-M3-19, Q-M3-8 (3)) — the status rank
 * stopped being a total order the day `result_changed` repeated `resolving`. A `rules_edited`
 * event is not a transition and leaves the key alone.
 */
@Injectable()
export class MarketAdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly publisher: MarketPublisher,
    private readonly jobs: MarketJobs,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * A new market is always a draft with LMSR state from `initState(p0, b)` and
   * `reserve_p = maxLossP(p0, b)` (ADR-0027). The slug is the admin's or derived from the
   * title; a taken slug is a VALIDATION_ERROR naming `slug` (the unique index decides).
   */
  async create(adminId: string, body: CreateMarketBody): Promise<AdminMarket> {
    const closeAt = new Date(body.closeAt);
    const slug = body.slug ?? generateSlug(body.title);

    try {
      return await this.db.transaction(async (tx) => {
        // Every instant this service writes or compares comes from the database clock, read
        // inside the transaction (and after the locks, where there are any) — see clock.ts.
        // The close time is checked before the category so the error precedence is unchanged.
        const now = await clockTimestamp(tx);
        assertFutureCloseAt(closeAt, now);
        await this.requireActiveCategory(tx, body.categoryId);
        const [inserted] = await tx
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
        if (!inserted) throw new AppError('INTERNAL', { message: 'Market insert failed' });
        // The event references the market and the market keys on the event, so the row is
        // inserted, then the event, then the key written back: two statements, one transaction,
        // and the row that leaves it has the key every other transition writes in its UPDATE.
        const eventId = await this.recordEvent(tx, {
          marketId: inserted.id,
          type: 'created',
          actorId: adminId,
          // The body is JSON-safe as parsed: strings, numbers and nulls only.
          payload: { ...body, slug },
          createdAt: now,
        });
        const [row] = await tx
          .update(schema.markets)
          .set({ statusEventId: eventId })
          .where(eq(schema.markets.id, inserted.id))
          .returning();
        if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });
        await tx.insert(schema.adminActions).values({
          adminId,
          type: 'market_create',
          targetType: 'market',
          targetId: row.id,
          payload: { after: snapshot(row) },
          createdAt: now,
        });
        // Read the detail inside the transaction, as every other write path does: after the
        // commit it would be a fresh snapshot on the pool and could already show somebody
        // else's write in the answer to "here is what you created".
        return await this.toAdminMarket(tx, row);
      });
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
   *
   * An edit that MOVES an open market publishes `market:status` after COMMIT — the delivery
   * half this path never had. No live event can carry a descriptive field: `market:tick` and
   * `market:status` carry absolute numbers, and a client takes `title`, `rules`, `category` and
   * `closeAt` from a REST answer alone (`joinMarket`, market-live.ts). Shortening `closeAt`
   * already healed itself — the quote AND the trade are refused on the database clock (A-M3-16)
   * and the web invalidates the row on MARKET_CLOSED — but EXTENDING one did not: a panel
   * already showing 마감 asks for no quote, so it had no round trip left to be corrected by,
   * while other traders' ticks went on moving the price in the same cached row (A-M4-36).
   */
  async update(adminId: string, id: string, body: UpdateMarketBody): Promise<AdminMarket> {
    const { market, moved, closeMoved, now } = await this.db.transaction(async (tx) => {
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
        // What open() required must hold for as long as the market trades: a draft may keep
        // blank rules, a live market may not be edited down to none.
        if (body.rules !== undefined && body.rules.trim() === '') {
          throw rulesRequired('Rules cannot be blank while the market is open');
        }
      } else if (current.status !== 'draft') {
        throw wrongStatus(current.status);
      }

      // After the row lock this transaction waited on: a transition (or another PATCH) may
      // have committed meanwhile, and this edit's rows must sort after it (clock.ts).
      const now = await clockTimestamp(tx);
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
          createdAt: now,
        });
      }
      const before = snapshot(current);
      const after = snapshot(row);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_update',
        targetType: 'market',
        targetId: current.id,
        payload: { before, after },
        createdAt: now,
      });
      // Gated twice, so a no-op PATCH costs no viewer a request. Only an OPEN market has
      // viewers — a draft is on no public route — and only a row that actually MOVED leaves one
      // holding something stale. The gate is the AUDIT projection rather than "the body was
      // non-empty": `snapshot` carries every column a PATCH can reach and not `updatedAt`, so
      // resaving identical text differs nowhere, and the gate stays exact when the next editable
      // column is added.
      return {
        market: await this.toAdminMarket(tx, row),
        moved: current.status === 'open' && JSON.stringify(before) !== JSON.stringify(after),
        // The delayed close job is keyed by market AND instant (marketCloseJobId), so a moved
        // close time is a cancel of the old registration plus a new one, never an edit.
        closeMoved:
          current.status === 'open' && row.closeAt.getTime() !== current.closeAt.getTime()
            ? { from: current.closeAt, to: row.closeAt }
            : undefined,
        now,
      };
    });
    // Outside the transaction, exactly as open/close/void publish: a subscriber answers
    // `market:status` with a REFETCH, and one issued before COMMIT would read the row this
    // transaction has not written yet. The job registrations go out with it, awaited together:
    // each is bounded on its own (MarketJobs), so a Redis that stops answering costs one bound.
    await Promise.all([
      moved ? this.publishStatus(market) : undefined,
      closeMoved ? this.jobs.cancelClose(market.id, closeMoved.from) : undefined,
      closeMoved ? this.jobs.scheduleClose(market.id, closeMoved.to, now) : undefined,
    ]);
    return market;
  }

  /**
   * draft → open (PLAN 0.2: never without rules). Writes the 'open' price tick the chart
   * starts from and the 'opened' event, then publishes `market:status` and registers the
   * delayed `market.close` job for `closeAt` (PLAN 5.5).
   */
  async open(adminId: string, id: string): Promise<AdminMarket> {
    const { market, now } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await this.lockedRow(tx, id);
      if (current.status !== 'draft') throw wrongStatus(current.status);
      if (current.rules.trim() === '') {
        throw rulesRequired('Rules are required before a market opens');
      }
      // The database clock after the market lock, as a trade reads it: this transaction may
      // have waited behind one, and the open tick it writes must sort with that trade's ticks
      // on one clock (clock.ts).
      const now = await clockTimestamp(tx);
      assertFutureCloseAt(current.closeAt, now);

      const eventId = await this.recordEvent(tx, {
        marketId: id,
        type: 'opened',
        actorId: adminId,
        payload: { openAt: now.toISOString(), closeAt: current.closeAt.toISOString() },
        createdAt: now,
      });
      const [row] = await tx
        .update(schema.markets)
        .set({ status: 'open', openAt: now, statusEventId: eventId, updatedAt: now })
        .where(eq(schema.markets.id, id))
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });
      await tx.insert(schema.priceTicks).values({
        marketId: id,
        ts: now,
        pYesBp: pYesBpOf(row),
        trigger: 'open',
      });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_open',
        targetType: 'market',
        targetId: current.id,
        payload: { before: snapshot(current), after: snapshot(row) },
        createdAt: now,
      });
      return { market: await this.toAdminMarket(tx, row), now };
    });
    await Promise.all([
      this.publishStatus(market),
      this.jobs.scheduleClose(market.id, new Date(market.closeAt), now),
    ]);
    return market;
  }

  /**
   * open → closed (the manual form of the M5 close job). Anything else: MARKET_NOT_OPEN.
   * The delayed close job registered for `closeAt` is cancelled after COMMIT; were it left,
   * the worker would find a closed market and skip it, so the cancel is hygiene, not safety.
   */
  async close(adminId: string, id: string): Promise<AdminMarket> {
    const { market, closeAt } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await this.lockedRow(tx, id);
      if (current.status !== 'open') {
        throw new AppError('MARKET_NOT_OPEN', { message: `Market is ${current.status}` });
      }
      // The database clock after the market lock (clock.ts): a trade or a PATCH may have
      // committed while this transaction queued, and every row it writes must sort after it.
      const now = await clockTimestamp(tx);
      const eventId = await this.recordEvent(tx, {
        marketId: id,
        type: 'closed',
        actorId: adminId,
        payload: { closedAt: now.toISOString() },
        createdAt: now,
      });
      const [row] = await tx
        .update(schema.markets)
        .set({ status: 'closed', statusEventId: eventId, updatedAt: now })
        .where(eq(schema.markets.id, id))
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_close',
        targetType: 'market',
        targetId: current.id,
        payload: { before: snapshot(current), after: snapshot(row) },
        createdAt: now,
      });
      return { market: await this.toAdminMarket(tx, row), closeAt: current.closeAt };
    });
    await Promise.all([this.publishStatus(market), this.jobs.cancelClose(market.id, closeAt)]);
    return market;
  }

  /**
   * Propose or change the result (PLAN 5.5, 7.3; M5 design 3.3). From `closed`: the result
   * is proposed, the market becomes `resolving` and the dispute window opens —
   * `disputeUntil = now + TEST_DISPUTE_WINDOW_SECONDS` (PLAN M5 AC 2) — and the delayed
   * `market.finalize` job is registered for that instant. From `resolving`: the result is
   * CHANGED (the window restarts from this instant, the old finalize job is cancelled and a
   * new one registered), which is what an admin does after accepting a dispute; the same
   * result again is refused naming `result`, and a window that has already passed is refused
   * naming `status` — the worker's finalize is due or running, and PLAN 5.5 lets it proceed
   * ("이의가 있어도 finalize는 자동 진행된다"); an admin who still wants a different outcome
   * must void. Any other status is refused naming `status`.
   *
   * `resolving` is entered again by a change, so the status rank cannot order the two
   * `market:status` events; the event id written to `status_event_id` can (class doc).
   * No price tick is written: the chart ends at the last trade, and a settlement is not a
   * price (PRICE_TICK_TRIGGERS 'resolve' stays unused — Q-M5).
   */
  async resolve(adminId: string, id: string, body: ResolveMarketBody): Promise<AdminMarket> {
    const window = this.config.get('TEST_DISPUTE_WINDOW_SECONDS', { infer: true });
    const { market, now, disputeUntil, previousDisputeUntil } = await this.db.transaction(
      async (tx) => {
        await lockMarket(tx, id);
        const current = await this.lockedRow(tx, id);
        if (current.status !== 'closed' && current.status !== 'resolving') {
          throw wrongStatus(current.status);
        }
        // After the market lock (clock.ts): the deadline is compared and written on the clock
        // the worker's finalize will re-check it on.
        const now = await clockTimestamp(tx);
        const changing = current.status === 'resolving';
        if (changing) {
          if (current.resolvedResult === body.result) {
            throw fieldError('result', 'Result is unchanged', 'result is unchanged');
          }
          if (current.disputeUntil !== null && current.disputeUntil.getTime() <= now.getTime()) {
            throw fieldError(
              'status',
              'Dispute window has closed; finalize is pending',
              'dispute window has closed',
            );
          }
        }
        const disputeUntil = new Date(now.getTime() + window * 1_000);
        const detail = {
          note: body.note ?? null,
          evidenceUrl: body.evidenceUrl ?? null,
          disputeUntil: disputeUntil.toISOString(),
        };
        const eventId = await this.recordEvent(tx, {
          marketId: id,
          type: changing ? 'result_changed' : 'resolve_proposed',
          actorId: adminId,
          payload: changing
            ? { before: current.resolvedResult, after: body.result, ...detail }
            : { result: body.result, ...detail },
          createdAt: now,
        });
        const [row] = await tx
          .update(schema.markets)
          .set({
            status: 'resolving',
            resolvedResult: body.result,
            resolvedAt: now,
            disputeUntil,
            statusEventId: eventId,
            updatedAt: now,
          })
          .where(eq(schema.markets.id, id))
          .returning();
        if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });
        await tx.insert(schema.adminActions).values({
          adminId,
          type: 'market_resolve',
          targetType: 'market',
          targetId: current.id,
          payload: {
            changed: changing,
            result: body.result,
            previousResult: current.resolvedResult,
            ...detail,
            before: snapshot(current),
            after: snapshot(row),
          },
          createdAt: now,
        });
        return {
          market: await this.toAdminMarket(tx, row),
          now,
          disputeUntil,
          previousDisputeUntil: changing ? current.disputeUntil : null,
        };
      },
    );
    // The finalize job is keyed by market and deadline, so a change is a cancel of the old
    // registration plus a new one; the two ids differ, so their order does not matter.
    await Promise.all([
      this.publishStatus(market),
      previousDisputeUntil ? this.jobs.cancelFinalize(market.id, previousDisputeUntil) : undefined,
      this.jobs.scheduleFinalize(market.id, disputeUntil, now),
    ]);
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
   *
   * A void from `resolving` discards the proposal (A-M3-23): `resolved_result`,
   * `resolved_at` and `dispute_until` are cleared — a voided market has no result, and the
   * web renders a null result on a voided row as "—" — and the `voided` event records what
   * was discarded, so the audit trail still says which result the holders were refunded
   * instead of. Open disputes on the market are left as they are (the admin may still
   * review them). The pending job of the previous status — the close job of an open market,
   * the finalize job of a resolving one — is cancelled after COMMIT.
   */
  async void(adminId: string, id: string, body: VoidMarketBody): Promise<AdminMarket> {
    const { market, refunds, pending } = await this.db.transaction(async (tx) => {
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
        let ledgerEntryId: number | undefined;
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
          const [entry] = await tx
            .insert(schema.ledgerEntries)
            .values({
              userId: position.userId,
              type: 'MARKET_VOID_REFUND',
              amountP: after.refundP,
              balanceAfterP: balance.availableP,
              refType: 'market',
              refId: current.id,
              memo: `무효 환불: ${current.title}`,
              createdAt: refundedAt,
            })
            .returning({ id: schema.ledgerEntries.id });
          if (!entry) throw new AppError('INTERNAL', { message: 'Ledger insert failed' });
          ledgerEntryId = entry.id;
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
        refunds.push({ position: updated, balance, ledgerEntryId });
      }

      const summary = {
        reason: body.reason,
        refundedAccounts: refundedAccounts.size,
        refundedP: serializePAmount(refundedP),
        // Only when there was a proposal: a void from open or closed has nothing to discard,
        // and the web's event rows treat the pair as optional.
        ...(current.resolvedResult !== null
          ? {
              discardedResult: current.resolvedResult,
              discardedDisputeUntil: current.disputeUntil?.toISOString() ?? null,
            }
          : {}),
      };
      const eventId = await this.recordEvent(tx, {
        marketId: id,
        type: 'voided',
        actorId: adminId,
        payload: summary,
        createdAt: now,
      });
      const [row] = await tx
        .update(schema.markets)
        .set({
          status: 'voided',
          voidedAt: now,
          resolvedResult: null,
          resolvedAt: null,
          disputeUntil: null,
          statusEventId: eventId,
          updatedAt: now,
        })
        .where(eq(schema.markets.id, id))
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_void',
        targetType: 'market',
        targetId: current.id,
        payload: { ...summary, before: snapshot(current), after: snapshot(row) },
        createdAt: now,
      });
      // What the previous status had registered with the worker, to cancel after COMMIT.
      const pending: { close?: Date; finalize?: Date } =
        current.status === 'open'
          ? { close: current.closeAt }
          : current.status === 'resolving' && current.disputeUntil !== null
            ? { finalize: current.disputeUntil }
            : {};
      return { market: await this.toAdminMarket(tx, row), refunds, pending };
    });

    const ts = market.voidedAt ?? market.updatedAt;
    // The last balance seen per account wins: a holder of both outcomes was credited twice,
    // and the later refund's ledger row is the greater key.
    const balances = new Map<string, { balance: BalanceRow; ledgerEntryId: number }>();
    for (const { position, balance, ledgerEntryId } of refunds) {
      if (balance && ledgerEntryId !== undefined) {
        balances.set(position.userId, { balance, ledgerEntryId });
      }
    }
    const events: [string, UserRealtimeEvent][] = [];
    for (const [userId, { balance, ledgerEntryId }] of balances) {
      // Stamped with the account's own refund instant (its `updated_at`), not the void's: a
      // trade of this account elsewhere may sit between the two. The ledger id is what a
      // client orders by (realtime.ts); the instant is for display.
      events.push([
        userId,
        {
          type: 'user:balance',
          ...toBalance(balance),
          ledgerEntryId: String(ledgerEntryId),
          ts: balance.updatedAt.toISOString(),
        },
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
          settled: position.settled,
          version: position.version,
          ts,
        },
      ]);
    }
    // Issued back to back, awaited together (MarketPublisher): the status first, then each
    // account's events, in call order on the wire; a Redis that stops answering costs one
    // command timeout, not one per holder. The job cancel rides along on its own connection.
    await Promise.all([
      this.publishStatus(market),
      ...events.map(([userId, event]) => this.publisher.publishUser(userId, event)),
      pending.close ? this.jobs.cancelClose(market.id, pending.close) : undefined,
      pending.finalize ? this.jobs.cancelFinalize(market.id, pending.finalize) : undefined,
    ]);
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

  /**
   * The transition's `market_events` row, inserted BEFORE the market UPDATE that stores its
   * id in `status_event_id` (class doc). Returned as the number the bigserial column is read
   * as, so the caller writes it into the bigint column untranslated.
   */
  private async recordEvent(
    tx: Tx,
    values: {
      marketId: string;
      type: MarketEventType;
      actorId: string | null;
      payload: Record<string, unknown> | null;
      createdAt: Date;
    },
  ): Promise<number> {
    const [event] = await tx
      .insert(schema.marketEvents)
      .values(values)
      .returning({ id: schema.marketEvents.id });
    if (!event) throw new AppError('INTERNAL', { message: 'Market event insert failed' });
    return event.id;
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

    // PLAN 12: the detail says how many objections the proposal drew and links to the list;
    // one grouped count over disputes_market_id_status_idx rather than three lookups.
    const disputeLines = await executor
      .select({ status: schema.disputes.status, n: sql<string>`count(*)` })
      .from(schema.disputes)
      .where(eq(schema.disputes.marketId, row.id))
      .groupBy(schema.disputes.status);
    const disputeCounts = { open: 0, accepted: 0, rejected: 0 };
    for (const line of disputeLines) {
      // count() over bigint arrives as a string of digits, like the sums above.
      disputeCounts[line.status] = Number(line.n);
    }

    // By id, not by created_at: every market_events row is inserted while its writer holds
    // that market's row FOR UPDATE, so the bigserial is drawn in lock order and the newest
    // id is the newest event. created_at can only tie-break, never correct an inversion.
    const events = await executor
      .select()
      .from(schema.marketEvents)
      .where(eq(schema.marketEvents.marketId, row.id))
      .orderBy(desc(schema.marketEvents.id))
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
      disputeCounts,
      events: events.map(toMarketEvent),
    };
  }

  /**
   * `market:status` on the market's channel, after COMMIT (best effort).
   *
   * Sent by every transition and by an edit to an open market, where the status is
   * deliberately UNCHANGED. That is not a misuse of the event but the cheapest correct delivery:
   * the web answers every `market:status` by restarting `['market', id]` (realtime-provider.tsx)
   * while `applyStatus` drops an event that does not SUPERSEDE what it holds (market-live.ts) —
   * so a repeat writes nothing into a cache and still forces the REST snapshot, which is the
   * only thing that carries `closeAt`.
   *
   * A `market:edit` event carrying the new fields was rejected, and not only for its cost across
   * shared + gateway + client: an event-applied `closeAt` could not defend itself against a REST
   * answer already in flight and the panel would flip between 마감 and open by arrival order. A
   * repeat of the KEYED event cannot lose that race — it patches nothing and asks for the truth
   * instead, and a `closed` that overtakes it still wins on its key.
   *
   * The key is `statusEventId`, the transition's `market_events.id` (A-M3-19, Q-M3-8 (3)): an
   * edit repeats the UNCHANGED key, so `statusSupersedes` drops it as not newer, while a
   * `result_changed` — the same `resolving` with a higher id — is applied. The status rank,
   * which ordered this event until M5, could not tell the two `resolving`s apart. A subscriber
   * still pays up to two extra requests per edit — the handler restarts the row AND its ticks
   * series — bounded by editors rather than traders and only for a MOUNTED observer.
   */
  private async publishStatus(market: AdminMarket): Promise<void> {
    await this.publisher.publishMarket(market.id, {
      type: 'market:status',
      marketId: market.id,
      status: market.status,
      resolvedResult: market.resolvedResult,
      disputeUntil: market.disputeUntil,
      statusEventId: market.statusEventId,
      ts: market.updatedAt,
    });
  }
}
