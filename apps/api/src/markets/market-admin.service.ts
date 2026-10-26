import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { schema, type Db } from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  marketSlugSchema,
  serializeCoinAmount,
  SETTLEMENT_STEPS,
  slugify,
  type AdminMarket,
  type AdminMarketListQuery,
  type AdminSettlementStep,
  type CreateMarketBody,
  type MarketEventType,
  type MarketStatus,
  type MarketSummary,
  type ResolveMarketBody,
  type UpdateMarketBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { type Page } from '../wallet/wallet.service.js';
import { lockMarket } from './market-lock.js';
import {
  likePattern,
  marketWithCategory,
  toMarket,
  toMarketSummary,
  type MarketRow,
} from './market.service.js';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Reads that run either inside a transaction or on the pool. */
type Executor = Db | Tx;

type MarketEventRow = typeof schema.marketEvents.$inferSelect;
type SettlementStepRow = typeof schema.marketSettlementSteps.$inferSelect;

/** UNIQUE (slug) on markets (migration 0000). */
export const MARKET_SLUG_UNIQUE = 'markets_slug_unique';

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
 * What an `admin_actions` payload records about a market (jsonb: Coin as strings, dates as ISO,
 * never bigint).
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
    lastPrice: row.lastPrice,
    volumeCoin: serializeCoinAmount(row.volumeCoin),
    tradeCount: row.tradeCount,
    traderCount: row.traderCount,
    openAt: row.openAt?.toISOString() ?? null,
    closeAt: row.closeAt.toISOString(),
    voidedAt: row.voidedAt?.toISOString() ?? null,
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

/**
 * The `market_settlement_steps` rows of one market in SETTLEMENT_STEPS order (the order the
 * worker runs them in). A row whose step is not in SETTLEMENT_STEPS — one written by a later
 * release this build does not know — is left out rather than failing the whole detail.
 */
function toSettlementSteps(rows: SettlementStepRow[]): AdminSettlementStep[] {
  const byStep = new Map(rows.map((row) => [row.step, row]));
  const steps: AdminSettlementStep[] = [];
  for (const step of SETTLEMENT_STEPS) {
    const row = byStep.get(step);
    if (!row) continue;
    steps.push({
      step,
      // varchar column; the DTO narrows it to SETTLEMENT_STEP_STATUSES.
      status: row.status as AdminSettlementStep['status'],
      attempts: row.attempts,
      completedAt: row.completedAt?.toISOString() ?? null,
      lastError: row.lastError,
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return steps;
}

/**
 * Admin market CRUD and transitions (PLAN 5.2, 5.5, 7.3, 12; M3 design 3.4, M5 design 3.3,
 * ADR-0046). Every write is one transaction with its `admin_actions` row and, for a
 * transition, its `market_events` row; open, close and resolve take the market's advisory
 * lock first (`lockMarket`) so nothing interleaves with another writer of the same market.
 * Realtime events are published, and the worker's jobs registered or cancelled, only after
 * COMMIT, best effort (MarketPublisher, MarketJobs).
 *
 * Every transition inserts its event row FIRST and stores that row's id in
 * `markets.status_event_id` in the same UPDATE (`recordEvent`): the id is drawn while the
 * transaction holds the row FOR UPDATE, so it is the market's commit order, and it is the key
 * `market:status` and the market DTOs are ordered by (A-M3-19, Q-M3-8 (3)) — the status rank
 * stopped being a total order the day M5's (since removed) `result_changed` repeated a status,
 * and an edit still republishes an unchanged one (A-M4-36). A `rules_edited` event is not a
 * transition and leaves the key alone.
 */
@Injectable()
export class MarketAdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly publisher: MarketPublisher,
    private readonly jobs: MarketJobs,
  ) {}

  /**
   * A new market is always a draft, with no price until its first fill (`last_price` null,
   * N02 §5). The slug is the admin's or derived from the title; a taken slug is a
   * VALIDATION_ERROR naming `slug` (the unique index decides).
   */
  async create(
    adminId: string,
    body: WithoutExpectedAccount<CreateMarketBody>,
  ): Promise<AdminMarket> {
    return this.db.transaction((tx) => this.createIn(tx, adminId, body));
  }

  /**
   * `create`'s work inside the caller's transaction, for a caller whose own write must commit
   * together with the draft: a proposal's 채택 (#77) makes a draft from the proposal and records
   * the 채택 in one transaction, so neither exists without the other. The same rows as `create` —
   * the market, its `created` event and its `market_create` record — and the same refusals; a draft
   * is not public, so nothing is published or scheduled.
   */
  async createIn(
    tx: Tx,
    adminId: string,
    body: WithoutExpectedAccount<CreateMarketBody>,
  ): Promise<AdminMarket> {
    const closeAt = new Date(body.closeAt);
    const slug = body.slug ?? generateSlug(body.title);
    // Every instant this service writes or compares comes from the database clock, read
    // inside the transaction (and after the locks, where there are any) — see clock.ts.
    // The close time is checked before the category so the error precedence is unchanged.
    const now = await clockTimestamp(tx);
    assertFutureCloseAt(closeAt, now);
    await this.requireActiveCategory(tx, body.categoryId);
    let inserted: MarketRow | undefined;
    try {
      [inserted] = await tx
        .insert(schema.markets)
        .values({
          slug,
          title: body.title,
          description: body.description ?? null,
          rules: body.rules,
          resolutionSource: body.resolutionSource ?? null,
          categoryId: body.categoryId,
          imageUrl: body.imageUrl ?? null,
          status: 'draft',
          openAt: null,
          closeAt,
          createdBy: adminId,
        })
        .returning();
    } catch (error) {
      // The insert is the one statement the slug's unique index can refuse; the transaction is
      // rolled back by the throw either way.
      if (isPgError(error, PG_UNIQUE_VIOLATION, MARKET_SLUG_UNIQUE)) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'This slug is already taken',
          details: [{ path: ['slug'], message: 'already exists' }],
          cause: error,
        });
      }
      throw error;
    }
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
  }

  /**
   * PATCH per status: a draft accepts every field; an open market accepts the descriptive
   * fields, the close time and the category, and refuses `slug` naming the field; any other
   * status refuses everything naming `status`. A rules change is also a `rules_edited` market
   * event (PLAN 12: allowed after a warning, which is the web's dialog).
   *
   * An edit that MOVES an open market publishes `market:status` after COMMIT. No live event can
   * carry a descriptive field: `market:tick` and `market:status` carry absolute numbers, and a
   * client takes `title`, `rules`, `category` and `closeAt` from a REST answer alone
   * (`joinMarket`, market-live.ts), so without it a viewer would keep the old text and close
   * time until something else made it refetch (A-M4-36).
   */
  async update(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<UpdateMarketBody>,
  ): Promise<AdminMarket> {
    const { market, moved, closeMoved, now } = await this.db.transaction(async (tx) => {
      const current = await this.lockedRow(tx, id);
      if (current.status === 'open') {
        if (body.slug !== undefined) {
          throw fieldError(
            'slug',
            'slug cannot change while the market is open',
            'immutable while open',
          );
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
    // Outside the transaction, exactly as open/close/resolve publish: a subscriber answers
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
   * draft → open (PLAN 0.2: never without rules). Writes the 'opened' event, then publishes
   * `market:status` and registers the delayed `market.close` job for `closeAt` (PLAN 5.5). No
   * price tick: a market has no price before its first fill (N02 §5). Opening stays allowed
   * while no route takes orders (#125): until the CLOB (#119) an open market is shown, not traded.
   */
  async open(adminId: string, id: string): Promise<AdminMarket> {
    const { market, now } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await this.lockedRow(tx, id);
      if (current.status !== 'draft') throw wrongStatus(current.status);
      if (current.rules.trim() === '') {
        throw rulesRequired('Rules are required before a market opens');
      }
      // The database clock after the market lock (clock.ts): this transaction may have waited
      // behind another writer of the market, and its rows must sort after that one's.
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
      // The database clock after the market lock (clock.ts): a PATCH or the worker's close job
      // may have committed while this transaction queued, and every row it writes must sort
      // after it.
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
   * The judgement (PLAN 5.5, 7.3; ADR-0046): closed → resolved, final at once. Any other
   * status — `resolved` included, whatever the result sent — is refused naming `status`; there
   * is no way to change a judgement (#26 decides re-judgement).
   *
   * One transaction writes the `resolved` event (its id is the new `status_event_id`), the
   * market row (`resolved_result`, `resolved_at`), one `pending` `market_settlement_steps` row
   * per SETTLEMENT_STEPS step — the worker's to-do list, so the step table never lags the
   * status — and the `admin_actions` row. After COMMIT the `market.finalize` job is registered
   * with no delay: the worker settles the market at once, and its per-minute scan picks up any
   * `resolved` market whose job never made it to Redis.
   *
   * No price tick is written: the chart ends at the last trade, and a settlement is not a
   * price (PRICE_TICK_TRIGGERS 'resolve' stays unused — Q-M5).
   */
  async resolve(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<ResolveMarketBody>,
  ): Promise<AdminMarket> {
    const { market, now } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await this.lockedRow(tx, id);
      if (current.status !== 'closed') throw wrongStatus(current.status);
      // After the market lock (clock.ts): the judgement sorts after whatever committed on this
      // market while the transaction queued, and the job id carries this instant.
      const now = await clockTimestamp(tx);
      const detail = {
        result: body.result,
        note: body.note ?? null,
        evidenceUrl: body.evidenceUrl ?? null,
      };
      const eventId = await this.recordEvent(tx, {
        marketId: id,
        type: 'resolved',
        actorId: adminId,
        payload: detail,
        createdAt: now,
      });
      const [row] = await tx
        .update(schema.markets)
        .set({
          status: 'resolved',
          resolvedResult: body.result,
          resolvedAt: now,
          statusEventId: eventId,
          updatedAt: now,
        })
        .where(eq(schema.markets.id, id))
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });
      // A closed market has never been judged, so no step row exists yet: a plain insert, and
      // the primary key (market_id, step) turns any surprise into a rollback, not a duplicate.
      await tx.insert(schema.marketSettlementSteps).values(
        SETTLEMENT_STEPS.map((step) => ({
          marketId: id,
          step,
          status: 'pending',
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        })),
      );
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_resolve',
        targetType: 'market',
        targetId: current.id,
        payload: { ...detail, before: snapshot(current), after: snapshot(row) },
        createdAt: now,
      });
      return { market: await this.toAdminMarket(tx, row), now };
    });
    // `resolved_at` was written as `now`, so the job is due at once; its id carries the
    // judgement instant (marketFinalizeJobId).
    await Promise.all([
      this.publishStatus(market),
      this.jobs.scheduleFinalize(market.id, now, now),
    ]);
    return market;
  }

  /**
   * Every status, draft included; newest first over (created_at DESC, id DESC). `q` narrows it to
   * the titles holding the term, as the public list's search does (`ILIKE`, wildcards literal):
   * the 관련 시장 picker of the admin detail finds the market to link by it (#65, ADR-0068).
   */
  async list(query: AdminMarketListQuery): Promise<Page<MarketSummary>> {
    const { markets, categories } = schema;
    const { status, cursor, limit, q } = query;
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.db
      .select(marketWithCategory)
      .from(markets)
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .where(
        and(
          status ? eq(markets.status, status) : undefined,
          q ? ilike(markets.title, likePattern(q)) : undefined,
          keyset ? keysetPredicate(markets.createdAt, markets.id, keyset, 'uuid') : undefined,
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
   * The admin detail: the public shape plus exposure figures, settlement steps and the event
   * log. Reads through `executor` so a transition returns the state it just committed.
   */
  private async toAdminMarket(executor: Executor, row: MarketRow): Promise<AdminMarket> {
    const [category] = await executor
      .select({ slug: schema.categories.slug, nameKo: schema.categories.nameKo })
      .from(schema.categories)
      .where(eq(schema.categories.id, row.categoryId))
      .limit(1);
    if (!category) throw new AppError('INTERNAL', { message: 'Category row missing' });

    // Σ buy amounts − Σ sell amounts over the market's fills.
    const [collected] = await executor
      .select({
        net: sql<string>`coalesce(sum(case when ${schema.fills.side} = 'buy' then ${schema.fills.amountCoin} else -${schema.fills.amountCoin} end), 0)`,
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

    // ADR-0046: where the worker stands on a judged market, one row per step (none before the
    // judgement or for a voided market). Ordered here rather than in SQL: SETTLEMENT_STEPS is
    // the order the worker runs them in, which no column of the table records.
    const stepRows = await executor
      .select()
      .from(schema.marketSettlementSteps)
      .where(eq(schema.marketSettlementSteps.marketId, row.id));

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
      createdBy: row.createdBy,
      updatedAt: row.updatedAt.toISOString(),
      // sum() over bigint is numeric, which pg hands over as a string of digits.
      netCollectedCoin: serializeCoinAmount(BigInt(collected?.net ?? '0')),
      openInterest,
      settlementSteps: toSettlementSteps(stepRows),
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
   * answer already in flight and the detail would flip between 마감 and open by arrival order. A
   * repeat of the KEYED event cannot lose that race — it patches nothing and asks for the truth
   * instead, and a `closed` that overtakes it still wins on its key.
   *
   * The key is `statusEventId`, the transition's `market_events.id` (A-M3-19, Q-M3-8 (3)): an
   * edit repeats the UNCHANGED key, so `statusSupersedes` drops it as not newer, while a
   * transition carries a higher one and is applied. A subscriber still pays up to two extra
   * requests per edit — the handler restarts the row AND its ticks series — bounded by editors
   * rather than traders and only for a MOUNTED observer.
   */
  private async publishStatus(market: AdminMarket): Promise<void> {
    await this.publisher.publishMarket(market.id, {
      type: 'market:status',
      marketId: market.id,
      status: market.status,
      resolvedResult: market.resolvedResult,
      statusEventId: market.statusEventId,
      ts: market.updatedAt,
    });
  }
}
