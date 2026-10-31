import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  MarketTransitionError,
  schema,
  transitionMarket,
  type Db,
  type MarketTransition,
} from '@buddha/db';
import {
  categoryUnselectableReason,
  decodeKeyset,
  encodeKeyset,
  MARKET_TAGS_MIN,
  marketSlugSchema,
  missingOpenItems,
  missingRuleItems,
  rulesEditedPayload,
  serializeCoinAmount,
  SETTLEMENT_STEPS,
  slugify,
  tagKey,
  type AdminMarket,
  type AdminMarketListQuery,
  type AdminSettlementStep,
  type CategoryUnselectableReason,
  type CreateMarketBody,
  type MarketRuleItems,
  type MarketStatus,
  type MarketSummary,
  type OpenItem,
  type ResolveMarketBody,
  type RuleItem,
  type UpdateMarketBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { and, count, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  readCategorySelectability,
  type CategorySelectability,
} from '../categories/category-selectability.js';
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
  readMarketSources,
  replaceMarketSources,
  sameSources,
  type MarketSources,
} from './market-sources.js';
import {
  likePattern,
  marketTagNames,
  marketWithCategory,
  ruleItemsOf,
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

/**
 * Lower-case alphanumerics: the slug alphabet without '-', so a suffix never ends a slug in '-'.
 * (The slug's random suffix, not a market's 태그 — #17's tags are `linkTags` below.)
 */
const SLUG_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_SUFFIX_LENGTH = 4;

function slugSuffix(): string {
  const bytes = randomBytes(SLUG_SUFFIX_LENGTH);
  let suffix = '';
  for (const byte of bytes) suffix += SLUG_SUFFIX_ALPHABET[byte % SLUG_SUFFIX_ALPHABET.length];
  return suffix;
}

/**
 * `<slugify(title)>-<suffix>`, or `market-<suffix>` when nothing of the title survives (design
 * 3.4). Regenerated until `marketSlugSchema` accepts it — the suffix makes a uuid shape
 * impossible in practice, but the schema is the contract, not the alphabet.
 */
export function generateSlug(title: string): string {
  const stem = slugify(title) || 'market';
  for (;;) {
    const candidate = `${stem}-${slugSuffix()}`;
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

/**
 * PLAN 12: a market trades against its rules, so an edit may not leave a rule item missing on an
 * open market that it had filled (#23, ADR-0097): one issue per such item, in RULE_ITEMS order. An
 * item missing already — every one, on a market opened before #23 — blocks no other edit. (Opening
 * without them is the open-items check's, `openItemsMissing`.)
 */
function rulesRequired(items: readonly RuleItem[]): AppError {
  return new AppError('RULES_REQUIRED', {
    message: `Rule items cannot be left missing while the market is open: ${items.join(', ')}`,
    details: items.map((item) => ({ path: [item], message: 'required while open' })),
  });
}

/** The rule items a create sends none of start as these: blank, null or none (#23). */
const BLANK_RULE_ITEMS: MarketRuleItems = {
  description: null,
  yesCondition: '',
  noCondition: '',
  eventDeadline: null,
  primarySource: null,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: null,
  delayHandling: '',
};

/** The rule-item fields of a create or update body (`marketFields`, #23). */
type RuleItemsBody = Pick<WithoutExpectedAccount<UpdateMarketBody>, RuleItem>;

/**
 * The rule items a write leaves (#23): the body's value of each item it sends, the stored one of
 * each it does not — null clears a nullable item, and `fallbackSources` replaces the whole ordered
 * list. The event deadline as an ISO instant, as `ruleItemsOf` reads it back.
 */
function withRuleItems(stored: MarketRuleItems, body: RuleItemsBody): MarketRuleItems {
  const { eventDeadline } = body;
  return {
    description: body.description === undefined ? stored.description : body.description,
    yesCondition: body.yesCondition ?? stored.yesCondition,
    noCondition: body.noCondition ?? stored.noCondition,
    eventDeadline:
      eventDeadline === undefined
        ? stored.eventDeadline
        : eventDeadline === null
          ? null
          : new Date(eventDeadline).toISOString(),
    primarySource: body.primarySource === undefined ? stored.primarySource : body.primarySource,
    fallbackSources: body.fallbackSources ?? stored.fallbackSources,
    fallbackCondition: body.fallbackCondition ?? stored.fallbackCondition,
    longDelayDays: body.longDelayDays === undefined ? stored.longDelayDays : body.longDelayDays,
    delayHandling: body.delayHandling ?? stored.delayHandling,
  };
}

/** The `markets` columns of the rule items; the sources are `market_sources` rows. */
function ruleItemColumns(items: MarketRuleItems) {
  return {
    description: items.description,
    yesCondition: items.yesCondition,
    noCondition: items.noCondition,
    eventDeadline: items.eventDeadline === null ? null : new Date(items.eventDeadline),
    fallbackCondition: items.fallbackCondition,
    longDelayDays: items.longDelayDays,
    delayHandling: items.delayHandling,
  };
}

/**
 * A switch condition says when the judgement moves to a fallback source (#172 item 9), so a write
 * whose result has one and no fallback is refused naming it (#23): the body's items over the
 * stored ones. The caller asks only when the write sends either, so a row stored that way by
 * another writer blocks no unrelated edit.
 */
function assertFallbackCondition(items: MarketRuleItems): void {
  if (items.fallbackSources.length === 0 && items.fallbackCondition.trim() !== '') {
    throw fieldError(
      'fallbackCondition',
      'A switch condition needs a fallback source to switch to',
      'no fallback source',
    );
  }
}

/** The top-level message of a category refusal, per reason; the detail is the reason itself. */
const CATEGORY_REFUSAL_MESSAGES: Readonly<Record<CategoryUnselectableReason, string>> = {
  inactive: 'This category is disabled',
  parent_inactive: 'This category is under a disabled category',
  subcategories: 'This category has sub-categories: file the market under one of them',
};

/**
 * The open-items check refused the open (#17): one issue per missing item in OPEN_ITEMS order,
 * its path the item — `category`'s message is why it cannot hold a new market
 * (`categoryUnselectableReason`), the others' 'required'.
 */
function openItemsMissing(missing: OpenItem[], category: CategorySelectability): AppError {
  return new AppError('OPEN_ITEMS_MISSING', {
    message: `The market misses what it needs to open: ${missing.join(', ')}`,
    details: missing.map((item) => ({
      path: [item],
      message:
        item === 'category'
          ? category.found
            ? (category.reason ?? 'required')
            : 'not found'
          : 'required',
    })),
  });
}

/** Two tag lists are one when they name the same tags in the same order (`tagKey`). */
function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => tagKey(name) === tagKey(b[index]!));
}

/**
 * Links `names` to the market as its tags, `position` 1..n in the order given, and answers each
 * as its tag's stored spelling (#17, ADR-0093 decision 2 #172 item 2). A name no tag has makes
 * the tag; one that differs from an existing tag only in case or spaces links that tag and keeps
 * its first spelling. The market has no `market_tags` rows when this runs (a new market, or an
 * edit that deleted them first).
 *
 * `tags` takes no UPDATE (migration 0049), so the upsert is `ON CONFLICT (name_key) DO NOTHING`
 * and the ids are selected afterwards — under READ COMMITTED that statement sees a tag another
 * transaction committed while this one waited on its index entry. The rows are inserted in key
 * order, so two writers making the same new tags wait on each other's entries in one order and
 * never in a cycle.
 */
async function linkTags(tx: Tx, marketId: string, names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const keys = names.map(tagKey);
  const inKeyOrder = names
    .map((name, index) => ({ name, key: keys[index]! }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  await tx
    .insert(schema.tags)
    .values(inKeyOrder.map(({ name }) => ({ name })))
    .onConflictDoNothing({ target: schema.tags.nameKey });
  const stored = await tx
    .select({ id: schema.tags.id, name: schema.tags.name, nameKey: schema.tags.nameKey })
    .from(schema.tags)
    .where(inArray(schema.tags.nameKey, keys));
  const byKey = new Map(stored.map((tag) => [tag.nameKey, tag]));
  const ordered = keys.map((key) => {
    const tag = byKey.get(key);
    if (!tag) throw new AppError('INTERNAL', { message: 'Tag upsert failed' });
    return tag;
  });
  await tx
    .insert(schema.marketTags)
    .values(ordered.map((tag, index) => ({ marketId, tagId: tag.id, position: index + 1 })));
  return ordered.map((tag) => tag.name);
}

/**
 * Refuses a category no new market may be filed under (#17, ADR-0093 decision 2 #172 item 1), as
 * `readCategorySelectability` found it: unknown is NOT_FOUND naming `categoryId`; one that cannot
 * hold a new market — hidden, under a hidden parent, or a top level with sub-categories — is
 * VALIDATION_ERROR naming it, the reason as the detail's message. The caller read it inside its
 * transaction before its clock, and the rows stay held FOR SHARE until the transaction ends, so a
 * hide cannot slip in before the market row is written.
 */
function assertSelectableCategory(category: CategorySelectability): void {
  if (!category.found) {
    throw new AppError('NOT_FOUND', {
      message: 'Category not found',
      details: [{ path: ['categoryId'], message: 'not found' }],
    });
  }
  if (category.reason !== null) {
    throw fieldError('categoryId', CATEGORY_REFUSAL_MESSAGES[category.reason], category.reason);
  }
}

function assertFutureCloseAt(closeAt: Date, now: Date): void {
  if (closeAt.getTime() <= now.getTime()) {
    throw fieldError('closeAt', 'closeAt must be in the future', 'must be in the future');
  }
}

/**
 * What an `admin_actions` payload records about a market (jsonb: Coin as strings, dates as ISO,
 * never bigint). `tags` are its tag names in order (`marketTagNames`; #17) and `sources` its
 * sources (`readMarketSources`; #23): the row holds neither, so the caller hands them in — a tag or
 * source edit is then a `market_update` with its before and after (ADR-0093 decision 2 #172 item
 * 14). The rule items (`ruleItemsOf`) are in it whole, so an edit of any of them moves it.
 */
function snapshot(
  row: MarketRow,
  tags: readonly string[],
  sources: MarketSources,
): Record<string, unknown> {
  return {
    slug: row.slug,
    title: row.title,
    ...ruleItemsOf(row, sources),
    categoryId: row.categoryId,
    tags: [...tags],
    imageUrl: row.imageUrl,
    status: row.status,
    lastPrice: row.lastPrice,
    volumeCoin: serializeCoinAmount(row.volumeCoin),
    tradeCount: row.tradeCount,
    traderCount: row.traderCount,
    openAt: row.openAt?.toISOString() ?? null,
    closeAt: row.closeAt.toISOString(),
  };
}

function toMarketEvent(row: MarketEventRow): AdminMarket['events'][number] {
  return {
    id: row.id.toString(),
    // varchar column; the DTO narrows it to MARKET_EVENT_TYPES.
    type: row.type as AdminMarket['events'][number]['type'],
    actorId: row.actorId,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
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
 * The three transitions are the interim admin actions ADR-0047 result 3 and ADR-0093 result 2
 * keep until the issues that replace them land: draft → open (#21), open → closed by one admin
 * (#114) and closed → resolved (#152). Each writes the status through `transitionMarket`
 * (@buddha/db, #174), the one writer of `markets.status` both apps share: it refuses a pair the
 * lifecycle does not list (`canTransitionMarket`), records who, when, from and to on the
 * `market_events` row, and stores that row's id in `markets.status_event_id` in the same
 * UPDATE. The id is drawn while the transaction holds the row FOR UPDATE, so it is the market's
 * commit order, and it is the key `market:status` and the market DTOs are ordered by (A-M3-19,
 * Q-M3-8 (3)) — the status rank is no total order (PAUSED → OPEN goes back), and an edit still
 * republishes an unchanged status (A-M4-36). Each action checks its own `from` first, so its
 * refusal keeps the code it always had; the table is the backstop. A `rules_edited` event is not
 * a transition and leaves the key alone.
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
   * VALIDATION_ERROR naming `slug` (the unique index decides). The category must be one a new
   * market may be filed under (`assertSelectableCategory`); the tags are linked in the order
   * sent, none when absent (#17). A rule item not sent starts blank (#23): a draft may save any
   * missing, and the open-items check names them; a switch condition with no fallback source is
   * refused naming `fallbackCondition` before anything else is read.
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
    const items = withRuleItems(BLANK_RULE_ITEMS, body);
    assertFallbackCondition(items);
    // Every instant this service writes or compares comes from the database clock, read inside
    // the transaction AFTER the last lock it queues on (clock.ts). The category's rows are taken
    // FOR SHARE first (`readCategorySelectability`), a read that can wait behind a category write
    // (a show, a hide, a new sub-category), so the market's rows sort after a write this create
    // already saw. Its refusal is thrown after the close time's, so the error precedence is
    // unchanged: a past closeAt is named before the category.
    const category = await readCategorySelectability(tx, body.categoryId);
    const now = await clockTimestamp(tx);
    assertFutureCloseAt(closeAt, now);
    assertSelectableCategory(category);
    let inserted: MarketRow | undefined;
    try {
      [inserted] = await tx
        .insert(schema.markets)
        .values({
          slug,
          title: body.title,
          ...ruleItemColumns(items),
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
    const tags = await linkTags(tx, inserted.id, body.tags ?? []);
    const sources: MarketSources = {
      primarySource: items.primarySource,
      fallbackSources: items.fallbackSources,
    };
    await replaceMarketSources(tx, inserted.id, sources);
    // The event references the market and the market keys on the event, so the row is
    // inserted, then the event, then the key written back: two statements, one transaction,
    // and the row that leaves it has the key every other transition writes in its UPDATE. No
    // `transitionMarket`: nothing is left, so the row names only the status it starts in.
    const [event] = await tx
      .insert(schema.marketEvents)
      .values({
        marketId: inserted.id,
        type: 'created',
        actorId: adminId,
        toStatus: 'draft',
        // The body is JSON-safe as parsed: strings, numbers, nulls, the tag names and the sources
        // as sent.
        payload: { ...body, slug },
        createdAt: now,
      })
      .returning({ id: schema.marketEvents.id });
    if (!event) throw new AppError('INTERNAL', { message: 'Market event insert failed' });
    const [row] = await tx
      .update(schema.markets)
      .set({ statusEventId: event.id })
      .where(eq(schema.markets.id, inserted.id))
      .returning();
    if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });
    await tx.insert(schema.adminActions).values({
      adminId,
      type: 'market_create',
      targetType: 'market',
      targetId: row.id,
      payload: { after: snapshot(row, tags, sources) },
      createdAt: now,
    });
    // Read the detail inside the transaction, as every other write path does: after the
    // commit it would be a fresh snapshot on the pool and could already show somebody
    // else's write in the answer to "here is what you created".
    return await this.toAdminMarket(tx, row, tags, sources);
  }

  /**
   * PATCH per status: a draft accepts every field; an open market accepts the descriptive
   * fields, the rule items, the close time, the category and the tags, and refuses `slug` naming
   * the field; any other status — REVIEW, SCHEDULED and PAUSED too, whose edits #78, #21 and #114
   * define — refuses everything naming `status`. An open market's rule items stay editable until
   * #80's supplements replace the path (ADR-0096, ADR-0097), but an edit that would leave one
   * missing that the market had filled is RULES_REQUIRED naming each (`rulesRequired`). Refusals
   * come in this order: status, slug, a switch condition with no fallback source
   * (`assertFallbackCondition`), RULES_REQUIRED, tags, category, close time.
   *
   * A change of any rule item (`changedRuleItems`: 배경 included, the title not) is also a
   * `rules_edited` market event (PLAN 12: allowed after a warning, which is the web's dialog)
   * whose payload names the items changed with each one's before and after
   * (`rulesEditedPayload`, #23). It changes no status: its `from_status`/`to_status` stay null.
   *
   * `primarySource` and `fallbackSources` are the market's `market_sources` rows (#23): sending
   * either writes the whole set again (`replaceMarketSources`) unless it is the stored one; the
   * other keeps its stored value.
   *
   * `tags` replace the whole ordered set (#17, ADR-0093 decision 2 #172 items 2 and 14): the
   * market's `market_tags` rows are deleted and the new ones linked — unless they name the same
   * tags in the same order, which is no change. Absent, the stored ones stay. A category change
   * must name a category a new market may be filed under; the market's current category is no
   * change and is not checked, so a market keeps a category hidden after it was filed (#172
   * item 1). Both land in the `market_update` record's before and after (`snapshot`).
   *
   * An edit that MOVES an open market publishes `market:status` after COMMIT. No live event can
   * carry a descriptive field: `market:tick` and `market:status` carry absolute numbers, and a
   * client takes `title`, the rule items, `category` and `closeAt` from a REST answer alone
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
      } else if (current.status !== 'draft') {
        throw wrongStatus(current.status);
      }
      // Under the row lock every writer of a market's sources holds, so the set read is the set
      // replaced.
      const currentSources = await readMarketSources(tx, id);
      const before = ruleItemsOf(current, currentSources);
      const items = withRuleItems(before, body);
      if (body.fallbackSources !== undefined || body.fallbackCondition !== undefined) {
        assertFallbackCondition(items);
      }
      if (current.status === 'open') {
        // What open() required must hold for as long as the market trades: a draft may keep
        // rule items missing or no tags, a live market may not be edited down to them.
        const missingBefore = missingRuleItems(before);
        const newlyMissing = missingRuleItems(items).filter(
          (item) => !missingBefore.includes(item),
        );
        if (newlyMissing.length > 0) throw rulesRequired(newlyMissing);
        if (body.tags !== undefined && body.tags.length < MARKET_TAGS_MIN) {
          throw fieldError(
            'tags',
            'Tags cannot be removed while the market is open',
            'required while open',
          );
        }
      }

      // A category change takes the new category's rows FOR SHARE (`readCategorySelectability`)
      // before the clock is read: that read can wait behind a category write, and this edit's rows
      // must sort after it too. The refusal is thrown below, where the check has always stood
      // (after the status checks, before the close time's), so the error precedence is unchanged.
      const categoryChange =
        body.categoryId !== undefined && body.categoryId !== current.categoryId
          ? {
              id: body.categoryId,
              selectability: await readCategorySelectability(tx, body.categoryId),
            }
          : null;
      // After the row lock and the category's this transaction waited on: a transition (or
      // another PATCH, or a category write) may have committed meanwhile, and this edit's rows
      // must sort after it (clock.ts).
      const now = await clockTimestamp(tx);
      const set: Partial<typeof schema.markets.$inferInsert> = { updatedAt: now };
      if (body.title !== undefined) set.title = body.title;
      // The rule items the body sends, as `items` holds them; the sources are written below.
      const columns = ruleItemColumns(items);
      if (body.description !== undefined) set.description = columns.description;
      if (body.yesCondition !== undefined) set.yesCondition = columns.yesCondition;
      if (body.noCondition !== undefined) set.noCondition = columns.noCondition;
      if (body.eventDeadline !== undefined) set.eventDeadline = columns.eventDeadline;
      if (body.fallbackCondition !== undefined) set.fallbackCondition = columns.fallbackCondition;
      if (body.longDelayDays !== undefined) set.longDelayDays = columns.longDelayDays;
      if (body.delayHandling !== undefined) set.delayHandling = columns.delayHandling;
      if (body.imageUrl !== undefined) set.imageUrl = body.imageUrl ?? null;
      if (body.slug !== undefined) set.slug = body.slug;
      if (categoryChange) {
        assertSelectableCategory(categoryChange.selectability);
        set.categoryId = categoryChange.id;
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

      // Under the row lock every writer of a market's tags holds, so the set read is the set
      // replaced.
      const currentTags = await marketTagNames(tx, id);
      let tags = currentTags;
      if (body.tags !== undefined && !sameTags(body.tags, currentTags)) {
        await tx.delete(schema.marketTags).where(eq(schema.marketTags.marketId, id));
        tags = await linkTags(tx, id, body.tags);
      }
      let sources = currentSources;
      const nextSources: MarketSources = {
        primarySource: items.primarySource,
        fallbackSources: items.fallbackSources,
      };
      if (!sameSources(nextSources, currentSources)) {
        await replaceMarketSources(tx, id, nextSources);
        sources = nextSources;
      }

      const edited = rulesEditedPayload(before, ruleItemsOf(row, sources));
      if (edited) {
        await tx.insert(schema.marketEvents).values({
          marketId: id,
          type: 'rules_edited',
          actorId: adminId,
          payload: { ...edited },
          createdAt: now,
        });
      }
      const beforeSnapshot = snapshot(current, currentTags, currentSources);
      const afterSnapshot = snapshot(row, tags, sources);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_update',
        targetType: 'market',
        targetId: current.id,
        payload: { before: beforeSnapshot, after: afterSnapshot },
        createdAt: now,
      });
      // Gated twice, so a no-op PATCH costs no viewer a request. Of the two statuses an edit
      // reaches, only OPEN has viewers — a draft is on no public route — and only a row that
      // actually MOVED leaves one holding something stale. The gate is the AUDIT projection
      // rather than "the body was non-empty": `snapshot` carries every column a PATCH can reach
      // and not `updatedAt`, so resaving identical text differs nowhere, and the gate stays exact
      // when the next editable column is added.
      return {
        market: await this.toAdminMarket(tx, row, tags, sources),
        moved:
          current.status === 'open' &&
          JSON.stringify(beforeSnapshot) !== JSON.stringify(afterSnapshot),
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
   * draft → open, the interim edge until #78's review and #21's scheduled open replace it
   * (`INTERIM_MARKET_TRANSITIONS`). Any other status — REVIEW and SCHEDULED included — is refused
   * naming `status`. A draft the open-items check finds wanting (#17, #23: the title and every
   * rule item, never without them — PLAN 0.2; a category a new market may be filed under; 1..5
   * tags) is refused with OPEN_ITEMS_MISSING naming every missing item, before the past close time
   * is: what the market lacks comes first, as RULES_REQUIRED did. The category is read FOR SHARE
   * (`readCategorySelectability`), so a hide that commits meanwhile either precedes this read or
   * waits for the open to commit. Writes the 'opened' event, then publishes
   * `market:status` and registers the delayed `market.close` job for `closeAt` (PLAN 5.5). No
   * price tick: a market has no price before its first fill (N02 §5). Opening stays allowed
   * while no route takes orders (#125): until the CLOB (#119) an open market is shown, not traded.
   */
  async open(adminId: string, id: string): Promise<AdminMarket> {
    const { market, now } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await this.lockedRow(tx, id);
      if (current.status !== 'draft') throw wrongStatus(current.status);
      const tags = await marketTagNames(tx, id);
      const sources = await readMarketSources(tx, id);
      const category = await readCategorySelectability(tx, current.categoryId);
      const missing = missingOpenItems({
        title: current.title,
        ...ruleItemsOf(current, sources),
        categorySelectable: category.found && category.reason === null,
        tagCount: tags.length,
      });
      if (missing.length > 0) throw openItemsMissing(missing, category);
      // The database clock after the market lock and the category's (clock.ts): this transaction
      // may have waited behind another writer of the market, and its rows must sort after that
      // one's.
      const now = await clockTimestamp(tx);
      assertFutureCloseAt(current.closeAt, now);

      const row = await this.transition(tx, current, {
        to: 'open',
        type: 'opened',
        actorId: adminId,
        payload: { openAt: now.toISOString(), closeAt: current.closeAt.toISOString() },
        at: now,
        set: { openAt: now },
      });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_open',
        targetType: 'market',
        targetId: current.id,
        payload: { before: snapshot(current, tags, sources), after: snapshot(row, tags, sources) },
        createdAt: now,
      });
      return { market: await this.toAdminMarket(tx, row, tags, sources), now };
    });
    await Promise.all([
      this.publishStatus(market),
      this.jobs.scheduleClose(market.id, new Date(market.closeAt), now),
    ]);
    return market;
  }

  /**
   * open → closed by one admin (the manual form of the M5 close job), kept until #114 replaces
   * it with an early close from PAUSED that another admin approves. Anything else — PAUSED
   * included — is MARKET_NOT_OPEN. The delayed close job registered for `closeAt` is cancelled
   * after COMMIT; were it left, the worker would find a closed market and skip it, so the cancel
   * is hygiene, not safety.
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
      const tags = await marketTagNames(tx, id);
      const sources = await readMarketSources(tx, id);
      const row = await this.transition(tx, current, {
        to: 'closed',
        type: 'closed',
        actorId: adminId,
        payload: { closedAt: now.toISOString() },
        at: now,
      });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_close',
        targetType: 'market',
        targetId: current.id,
        payload: { before: snapshot(current, tags, sources), after: snapshot(row, tags, sources) },
        createdAt: now,
      });
      return {
        market: await this.toAdminMarket(tx, row, tags, sources),
        closeAt: current.closeAt,
      };
    });
    await Promise.all([this.publishStatus(market), this.jobs.cancelClose(market.id, closeAt)]);
    return market;
  }

  /**
   * The judgement (PLAN 5.5, 7.3; ADR-0046): closed → resolved, final at once — the interim edge
   * until #152's judgement, which another admin approves and which publishes a PROVISIONAL
   * result first (`INTERIM_MARKET_TRANSITIONS`). The result is YES or NO (VOID is chosen in
   * #152's judgement and paid by #126). Any other status — `provisional` and `resolved`
   * included, whatever the result sent — is refused naming `status`; there is no way to change a
   * judgement here (a correction is #176's, in PROVISIONAL only).
   *
   * One transaction writes the `resolved` event (its id is the new `status_event_id`), the
   * market row (`resolved_result`, `resolved_at`), one `pending` `market_settlement_steps` row
   * per SETTLEMENT_STEPS step — the worker's to-do list, so the step table never lags the
   * status — and the `admin_actions` row. After COMMIT the `market.finalize` job is registered
   * with no delay: the worker moves the market to `settling` and pays it out at once, and its
   * per-minute scan picks up any `resolved` market whose job never made it to Redis.
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
      const tags = await marketTagNames(tx, id);
      const sources = await readMarketSources(tx, id);
      const detail = {
        result: body.result,
        note: body.note ?? null,
        evidenceUrl: body.evidenceUrl ?? null,
      };
      const row = await this.transition(tx, current, {
        to: 'resolved',
        type: 'resolved',
        actorId: adminId,
        payload: detail,
        at: now,
        set: { resolvedResult: body.result, resolvedAt: now },
      });
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
        payload: {
          ...detail,
          before: snapshot(current, tags, sources),
          after: snapshot(row, tags, sources),
        },
        createdAt: now,
      });
      return { market: await this.toAdminMarket(tx, row, tags, sources), now };
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
   * Every status, DRAFT and REVIEW included; newest first over (created_at DESC, id DESC). `q`
   * narrows it to the titles holding the term, as the public list's search does (`ILIKE`,
   * wildcards literal): the 관련 시장 picker of the admin detail finds the market to link by it
   * (#65, ADR-0068).
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
    const tags = await marketTagNames(this.db, id);
    return this.toAdminMarket(this.db, row, tags, await readMarketSources(this.db, id));
  }

  /**
   * `current` → `to` through `transitionMarket` (class doc), under the market lock the caller
   * holds, with `from` the status it read FOR UPDATE; answers the row as the transition left it.
   * The caller has refused every `from` it does not take with its own code already, so a pair
   * the lifecycle refuses here is a status the action does not take either: the same `status`
   * refusal, never a 500.
   */
  private async transition(
    tx: Tx,
    current: MarketRow,
    change: Omit<MarketTransition, 'marketId' | 'from'>,
  ): Promise<MarketRow> {
    try {
      await transitionMarket(tx, { marketId: current.id, from: current.status, ...change });
    } catch (error) {
      if (error instanceof MarketTransitionError) throw wrongStatus(current.status);
      throw error;
    }
    const [row] = await tx
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, current.id))
      .limit(1);
    if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });
    return row;
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
   * The admin detail: the public shape plus exposure figures, settlement steps, the event log
   * and what the open-items check finds missing (#17, #23, every status). Reads through
   * `executor` so a transition returns the state it just committed; `tags` are the market's names
   * in order (`marketTagNames`) and `sources` its sources (`readMarketSources`), which every
   * caller holds already.
   *
   * The category's selectability is read in the same statement as its name and WITHOUT the
   * FOR SHARE locks of `readCategorySelectability`: the detail is also read on the pool (`get`),
   * where a lock would last one statement and guard nothing — it reports, and the writes that act
   * on the answer (create, a category change, the open) read it locked themselves.
   */
  private async toAdminMarket(
    executor: Executor,
    row: MarketRow,
    tags: string[],
    sources: MarketSources,
  ): Promise<AdminMarket> {
    const parent = alias(schema.categories, 'parent');
    const child = alias(schema.categories, 'child');
    const activeChildren = executor
      .select({ n: count() })
      .from(child)
      .where(and(eq(child.parentId, schema.categories.id), eq(child.isActive, true)));
    const [category] = await executor
      .select({
        slug: schema.categories.slug,
        nameKo: schema.categories.nameKo,
        isActive: schema.categories.isActive,
        parentActive: parent.isActive,
        activeChildCount: sql<number>`(${activeChildren})`.mapWith(Number),
      })
      .from(schema.categories)
      .leftJoin(parent, eq(parent.id, schema.categories.parentId))
      .where(eq(schema.categories.id, row.categoryId))
      .limit(1);
    if (!category) throw new AppError('INTERNAL', { message: 'Category row missing' });
    const unselectable = categoryUnselectableReason({
      isActive: category.isActive,
      // The FK keeps a sub-category's parent, so a null here is a top-level category.
      parentActive: category.parentActive,
      activeChildCount: category.activeChildCount,
    });

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
    // judgement or for a cancelled market). Ordered here rather than in SQL: SETTLEMENT_STEPS is
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
      ...toMarket(row, { slug: category.slug, nameKo: category.nameKo }, tags, sources),
      createdBy: row.createdBy,
      updatedAt: row.updatedAt.toISOString(),
      // sum() over bigint is numeric, which pg hands over as a string of digits.
      netCollectedCoin: serializeCoinAmount(BigInt(collected?.net ?? '0')),
      openInterest,
      settlementSteps: toSettlementSteps(stepRows),
      events: events.map(toMarketEvent),
      missingOpenItems: missingOpenItems({
        title: row.title,
        ...ruleItemsOf(row, sources),
        categorySelectable: unselectable === null,
        tagCount: tags.length,
      }),
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
