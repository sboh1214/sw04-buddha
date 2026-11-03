import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  MarketTransitionError,
  openScheduledMarket,
  ruleContentOf,
  schema,
  transitionMarket,
  type Db,
  type MarketTransition,
  type OpenSource,
} from '@buddha/db';
import {
  categoryUnselectableReason,
  changedRuleVersionItems,
  decodeKeyset,
  encodeKeyset,
  LEAD_CLOSE_GAP_SETTING,
  MARKET_REVIEW_APPROVAL_KIND,
  MARKET_REVIEW_CHECKLIST,
  MARKET_REVIEW_REQUEST_REASON,
  MARKET_TAGS_MIN,
  marketReviewExclusion,
  marketSlugSchema,
  missingOpenItems,
  rulesEditedPayload,
  sameTimeItem,
  serializeCoinAmount,
  SETTLEMENT_STEPS,
  slugify,
  SUPPLEMENT_ONLY_WHILE_OPEN,
  tagKey,
  timeRelationMessage,
  timeRuleViolations,
  type AdminMarket,
  type AdminMarketListQuery,
  type AdminMarketReviewItem,
  type AdminSettlementStep,
  type ApproveMarketReviewBody,
  type CategoryUnselectableReason,
  type CreateMarketBody,
  type CursorQuery,
  type MarketApprovedPayload,
  type MarketRejectedPayload,
  type MarketRevertedPayload,
  type MarketRuleItems,
  type MarketStatus,
  type MarketSubmittedPayload,
  type MarketSummary,
  type MarketTimeItems,
  type OpenItem,
  type RejectMarketReviewBody,
  type RescheduleMarketOpenBody,
  type ResolveMarketBody,
  type RevertMarketBody,
  type RuleVersionItem,
  type RulesEditedValues,
  type TimeRuleViolation,
  type UpdateMarketBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { and, count, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  ApprovalService,
  approvalNotAllowed,
  type ApprovalRequest,
} from '../approvals/approval.service.js';
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
import { ReleaseSettingsService } from '../release-settings/release-settings.service.js';
import { type Page } from '../wallet/wallet.service.js';
import {
  assertFallbackCondition,
  assertFutureCloseAt,
  assertTimeOrder,
  fieldError,
  lockedMarketRow,
  ruleItemColumns,
  sentTimeFields,
  timeColumns,
  withContent,
  withRuleItems,
  withTimes,
  wrongStatus,
} from './market-item-rules.js';
import { lockMarket } from './market-lock.js';
import {
  approvedReviewRequestId,
  listMarketReviews,
  marketEditors,
  pendingReviewRequests,
  readMarketReview,
  reviewRequestStatus,
  type ReviewRequest,
} from './market-review.js';
import {
  readMarketSources,
  replaceMarketSources,
  sameSources,
  type MarketSources,
} from './market-sources.js';
import { readMarketPause } from './market-pause.js';
import { readAdminRuleVersions, readMarketSupplement } from './market-supplement.js';
import {
  likePattern,
  marketTagNames,
  marketWithCategory,
  ruleItemsOf,
  timesOf,
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

/**
 * An edit of an open or paused market (`status`, #114) that changes a version item (#80,
 * ADR-0101; ADR-0093 decision 2 #172 item 14): after the open they change by an approved
 * supplement alone — and on a market opened before rule versions (`ruleVersion` null, D4), which
 * takes no supplement, not at all until the close, which the message says instead. One issue per
 * item, in RULE_VERSION_ITEMS order, SUPPLEMENT_ONLY_WHILE_OPEN either way (the detail a client
 * maps).
 */
function supplementOnlyWhileOpen(
  items: readonly RuleVersionItem[],
  ruleVersion: number | null,
  status: MarketStatus,
): AppError {
  const named = items.join(', ');
  return new AppError('VALIDATION_ERROR', {
    message:
      ruleVersion === null
        ? `${named} cannot change until the close: the market opened before rule versions`
        : `${named} change by a supplement alone while the market is ${status}`,
    details: items.map((item) => ({ path: [item], message: SUPPLEMENT_ONLY_WHILE_OPEN })),
  });
}

/**
 * What `rules_edited` compares (RULES_EDITED_ITEMS, #23, #22): the rule items and the two time
 * items that are 판정 항목 — the announcement time and the judgement time zone.
 */
function rulesEditedValues(
  items: MarketRuleItems,
  times: Pick<MarketTimeItems, 'scheduledAnnouncementAt' | 'judgementTimeZone'>,
): RulesEditedValues {
  return {
    ...items,
    scheduledAnnouncementAt: times.scheduledAnnouncementAt,
    judgementTimeZone: times.judgementTimeZone,
  };
}

/** The top-level message of a category refusal, per reason; the detail is the reason itself. */
const CATEGORY_REFUSAL_MESSAGES: Readonly<Record<CategoryUnselectableReason, string>> = {
  inactive: 'This category is disabled',
  parent_inactive: 'This category is under a disabled category',
  subcategories: 'This category has sub-categories: file the market under one of them',
};

/**
 * The open-items check refused the review submission or the approval (#17, #78): one issue per
 * missing item in OPEN_ITEMS order, its path the item — `category`'s message is why it cannot hold
 * a new market (`categoryUnselectableReason`); `timeOrder`'s the order rules the times break and
 * `leadClose`'s 'leadClose', or 'gap undecided' while the release setting is
 * (`timeRelationMessage`, #22, from the check's own `violations`); the others' 'required'.
 */
function openItemsMissing(
  missing: OpenItem[],
  category: CategorySelectability,
  violations: readonly TimeRuleViolation[],
): AppError {
  return new AppError('OPEN_ITEMS_MISSING', {
    message: `The market misses what it needs to open: ${missing.join(', ')}`,
    details: missing.map((item) => ({
      path: [item],
      message:
        item === 'category'
          ? category.found
            ? (category.reason ?? 'required')
            : 'not found'
          : item === 'timeOrder' || item === 'leadClose'
            ? timeRelationMessage(item, violations)
            : 'required',
    })),
  });
}

/**
 * The open-items check of `row` as it is stored (#17, #23, #22): the title and every rule item, the
 * scheduled open and judgement, the judgement time zone, the times in order, the lead close at
 * `gapMinutes`, a category a new market may be filed under (`category`, read FOR SHARE by the
 * caller) and 1..5 tags. OPEN_ITEMS_MISSING naming every missing item (`openItemsMissing`). The
 * gate of the review submission and the approval (#78, ADR-0099); the open itself does not check it
 * again — the approval was the last gate (#21, ADR-0100; `openScheduledMarket`).
 */
function assertOpenItems(
  row: MarketRow,
  tags: readonly string[],
  sources: MarketSources,
  category: CategorySelectability,
  gapMinutes: number | null,
): void {
  const input = {
    title: row.title,
    ...ruleItemsOf(row, sources),
    ...timesOf(row),
    closeAt: row.closeAt.toISOString(),
    categorySelectable: category.found && category.reason === null,
    tagCount: tags.length,
    leadCloseGapMinutes: gapMinutes,
  };
  const missing = missingOpenItems(input);
  if (missing.length > 0) {
    throw openItemsMissing(missing, category, timeRuleViolations(input, gapMinutes));
  }
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

/**
 * The market's pending `market_review` request (#78), read under the market lock: exactly one
 * while it is in REVIEW, which every review write keeps (they all hold that lock), so anything
 * else is a broken invariant — INTERNAL, never an answer.
 */
async function pendingReview(tx: Tx, marketId: string): Promise<ReviewRequest> {
  const pending = await pendingReviewRequests(tx, marketId);
  if (pending.length !== 1) {
    throw new AppError('INTERNAL', {
      message: `Market ${marketId} in review has ${String(pending.length)} pending review requests`,
    });
  }
  return pending[0]!;
}

/**
 * Who may not approve or reject a review (#78, ADR-0093 decision 2 #172 item 5), checked before
 * ApprovalService's own rule so the refusal names the first that holds, in MARKET_REVIEW_EXCLUSIONS
 * order (`marketReviewExclusion`): the creator, then an admin with a `market_update` or
 * `market_reschedule` record on the market at any time (`marketEditors`), then the submitter — APPROVAL_NOT_ALLOWED `creator`,
 * `editor` or `requester`. Under the market lock, so no edit lands between the check and the
 * decision (an edit needs a draft, and the market is in REVIEW).
 */
async function assertMayDecide(
  tx: Tx,
  adminId: string,
  row: MarketRow,
  request: ReviewRequest,
): Promise<void> {
  const editors = await marketEditors(tx, row.id);
  const exclusion = marketReviewExclusion(adminId, {
    createdBy: row.createdBy,
    editorIds: editors.map((editor) => editor.id),
    requestedBy: request.requestedBy.id,
  });
  if (exclusion !== null) throw approvalNotAllowed(exclusion);
}

/**
 * The decision names the request its admin reviewed (`requestId`; Codex review of #78): a market
 * sent back and submitted again since holds a new request on content that admin never saw, so a
 * dialog left open on the old one decides nothing. That request ended as ApprovalService would
 * answer a decision on it — 'retracted' (its submitter's 되돌리기) or 'decided' (another admin's
 * 되돌리기, a 반려); an id that is no request of this market's review is VALIDATION_ERROR on
 * `requestId`.
 */
async function assertReviewedRequest(
  tx: Tx,
  marketId: string,
  pending: ReviewRequest,
  requestId: string,
): Promise<void> {
  if (pending.id === requestId) return;
  const status = await reviewRequestStatus(tx, marketId, requestId);
  if (status === null) {
    throw fieldError('requestId', 'Not a review request of this market', 'unknown');
  }
  throw approvalNotAllowed(status === 'retracted' ? 'retracted' : 'decided');
}

/**
 * The instant ApprovalService decided `request` at, read after its locks (MarketSupplementService's
 * decisions too).
 */
export function decisionInstant(request: ApprovalRequest): Date {
  if (request.decidedAt === null) {
    throw new AppError('INTERNAL', { message: 'Approval decision has no instant' });
  }
  return request.decidedAt;
}

/**
 * What an `admin_actions` payload records about a market (jsonb: Coin as strings, dates as ISO,
 * never bigint). `tags` are its tag names in order (`marketTagNames`; #17) and `sources` its
 * sources (`readMarketSources`; #23): the row holds neither, so the caller hands them in — a tag or
 * source edit is then a `market_update` with its before and after (ADR-0093 decision 2 #172 item
 * 14). The rule items (`ruleItemsOf`) and the times (`timesOf`, #22) are in it whole, with the
 * lead-close gap the market was last checked against, so an edit of any of them moves it. A
 * supplement's approval records the market before and after with it too (#80).
 */
export function snapshot(
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
    ...timesOf(row),
    closeAt: row.closeAt.toISOString(),
    leadCloseGapMinutes: row.leadCloseGapMinutes,
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
 * transition, its `market_events` row; resolve and the review's writes take the market's
 * advisory lock first (`lockMarket`) so nothing interleaves with another writer of the same
 * market — the worker's open, close and finalize jobs among them.
 * Realtime events are published, and the worker's jobs registered or cancelled, only after
 * COMMIT, best effort (MarketPublisher, MarketJobs).
 *
 * Resolve is the interim admin action ADR-0047 result 3 and ADR-0093 result 2 keep until #152's
 * judgement replaces it (closed → resolved). The interim draft → open went with #21 (ADR-0100): a
 * market opens from SCHEDULED alone, by `openScheduledMarket` (@buddha/db) — the worker's job at
 * its scheduled open, or the approval or the reschedule that finds that instant come, in its own
 * transaction. The interim one-admin open → closed went with #114 (ADR-0102): a market closes at
 * its close (the worker's job, OPEN or PAUSED), or early from PAUSED by another admin's approval
 * (MarketPauseService, which pauses and resumes it too). Every transition writes
 * the status through `transitionMarket` (@buddha/db, #174), the one writer of `markets.status`
 * both apps share: it refuses a pair the lifecycle does not list (`canTransitionMarket`), records
 * who, when, from and to on the `market_events` row, and stores that row's id in
 * `markets.status_event_id` in the same UPDATE. The id is drawn while the transaction holds the
 * row FOR UPDATE, so it is the market's commit order, and it is the key `market:status` and the
 * market DTOs are ordered by (A-M3-19, Q-M3-8 (3)) — the status rank is no total order (PAUSED →
 * OPEN goes back), and an edit still republishes an unchanged status (A-M4-36). Each action checks
 * its own `from` first, so its refusal keeps the code it always had; the table is the backstop. A
 * `rules_edited` event is not a transition and leaves the key alone.
 *
 * 개설 검수 (#78, ADR-0099; market-review.ts in @buddha/shared): the submission (draft → review),
 * the approval (review → scheduled), the 반려 (review → draft), the 되돌리기 (review or scheduled →
 * draft) and a SCHEDULED market's new scheduled open, each a `market_events` row and an
 * `admin_actions` row. The two-person control is a `market_review` approval request (#171,
 * ApprovalService) that the submission opens and the approval, the 반려 or the 되돌리기 ends, in the
 * same transaction as the market's change. Lock order: the market lock, the market row (and the
 * category's rows, FOR SHARE, where the open-items check runs), then ApprovalService's shared
 * admin-roles lock and the request row. Nothing takes the admin-roles lock and then a market lock
 * (a role grant or revoke, and an account closure, lock no market), so the order cannot cycle; a
 * request row of this kind is written under its market's lock alone, so it never waits. The
 * instant such a write records is the one ApprovalService reads for its step, after every lock
 * the write queued on — the request's, the decision's or the retraction's — so the market's event,
 * its record and the request say the same time (as #139's decisions do, ADR-0085); a write with
 * no request step reads the clock after the market lock.
 */
@Injectable()
export class MarketAdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly publisher: MarketPublisher,
    private readonly jobs: MarketJobs,
    private readonly settings: ReleaseSettingsService,
    private readonly approvals: ApprovalService,
  ) {}

  /**
   * A new market is always a draft, with no price until its first fill (`last_price` null,
   * N02 §5). The slug is the admin's or derived from the title; a taken slug is a
   * VALIDATION_ERROR naming `slug` (the unique index decides). The category must be one a new
   * market may be filed under (`assertSelectableCategory`); the tags are linked in the order
   * sent, none when absent (#17). A rule item not sent starts blank (#23), and so does a time item
   * but the close (#22): a draft may save any missing, and the open-items check names them; a
   * switch condition with no fallback source is refused naming `fallbackCondition` before anything
   * else is read. Times out of order are refused last (`assertTimeOrder`), after the past close and
   * the category; the lead close is never refused here (the open-items check's `leadClose`).
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
    const times = withTimes(
      {
        scheduledOpenAt: null,
        closeAt: closeAt.toISOString(),
        scheduledAnnouncementAt: null,
        scheduledJudgementAt: null,
        judgementTimeZone: null,
      },
      body,
    );
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
    assertTimeOrder({ ...times, eventDeadline: items.eventDeadline }, sentTimeFields(body));
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
          ...timeColumns(times),
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
   * PATCH per status: a draft accepts every field; an OPEN or PAUSED market accepts its category,
   * tags and image, and refuses `slug` naming the field; any other status refuses everything naming
   * `status`. PAUSED is after the open as OPEN is (#114, ADR-0102; ADR-0093 decision 2 #172 item
   * 14: '개장 뒤', 일시 중단 중 included), so what follows of an open market holds for a paused one
   * too. REVIEW and SCHEDULED are refused because the content locks at the review submission
   * (#78, ADR-0099; ADR-0093 decision 2 #172 item 6 (a)): what was reviewed is what opens, so a
   * change sends the market back to a draft (`revert`) to be reviewed again, and a SCHEDULED
   * market's scheduled open, the one exception, moves by its own write with a reason
   * (`reschedule`). The later statuses are past trading.
   *
   * After the open the version items — the title, the rule items and the times (RULE_VERSION_ITEMS,
   * #80, ADR-0101; ADR-0093 decision 2 #172 item 14) — change by an approved supplement alone
   * (MarketSupplementService), which took over the open market's checks this edit made until #80
   * (RULES_REQUIRED, the fixed times, the close later only and up to the scheduled judgement, the
   * lead close). An open market's edit that changes one is refused naming each, in
   * RULE_VERSION_ITEMS order, SUPPLEMENT_ONLY_WHILE_OPEN ('supplement only while open'); the stored
   * value again is no change (`changedRuleVersionItems`: a text by its trimmed value, an instant by
   * its moment), so a form that sends every field back is refused only for what it changed. A
   * market opened before #80 (no rule version, D4) is held the same, and takes no supplement
   * either: its refusal's message says the items cannot change until the close (the details are
   * the same).
   *
   * The times of a draft (#22, ADR-0098): a write whose result breaks the order is refused naming
   * both ends (`assertTimeOrder`); its lead close is never refused: the open-items check names it.
   *
   * Refusals come in this order: status, slug after the open, a version item changed after the
   * open, tags, a switch condition with no fallback source (`assertFallbackCondition`), category,
   * a close time not in the future, the order, and last a taken slug (the unique index, at the
   * UPDATE).
   *
   * A change of any rule item (`changedRuleItems`: 배경 included, the title not) or of the
   * announcement time or the judgement time zone (#22: 판정 항목 of #172 item 7) is also a
   * `rules_edited` market event (PLAN 12: allowed after a warning, which is the web's dialog)
   * whose payload names the items changed with each one's before and after
   * (`rulesEditedPayload`, #23, RULES_EDITED_ITEMS) — a draft's alone since #80. The scheduled
   * open, the close and the scheduled judgement are in the `market_update` record only, as the
   * title is. It changes no status: its `from_status`/`to_status` stay null.
   *
   * `primarySource` and `fallbackSources` are the market's `market_sources` rows (#23): sending
   * either writes the whole set again (`replaceMarketSources`) unless it is the stored one; the
   * other keeps its stored value.
   *
   * `tags` replace the whole ordered set (#17, ADR-0093 decision 2 #172 items 2 and 14): the
   * market's `market_tags` rows are deleted and the new ones linked — unless they name the same
   * tags in the same order, which is no change. Absent, the stored ones stay; an open or paused
   * market keeps one at least ('required while open'). A category change must name a category a
   * new market may be filed under; the market's current category is no change and is not checked,
   * so a market keeps a category hidden after it was filed (#172 item 1). Both land in the
   * `market_update` record's before and after (`snapshot`), its admin, its time and both values: an
   * open or paused market's category and tags change directly, with that record (#172 item 14).
   *
   * An edit that MOVES an open or paused market publishes `market:status` after COMMIT (both are
   * public, with viewers). No live event can
   * carry a descriptive field: `market:tick` and `market:status` carry absolute numbers, and a
   * client takes `category`, the tags and the image from a REST answer alone (`joinMarket`,
   * market-live.ts), so without it a viewer would keep the old ones until something else made it
   * refetch (A-M4-36).
   */
  async update(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<UpdateMarketBody>,
  ): Promise<AdminMarket> {
    const { market, moved } = await this.db.transaction(async (tx) => {
      const current = await lockedMarketRow(tx, id);
      // OPEN or PAUSED (#114): the market's edits after the open, whichever of the two it is in.
      const afterOpen = current.status === 'open' || current.status === 'paused';
      if (afterOpen) {
        if (body.slug !== undefined) {
          throw fieldError(
            'slug',
            `slug cannot change while the market is ${current.status}`,
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
      const storedTimes: MarketTimeItems = {
        ...timesOf(current),
        closeAt: current.closeAt.toISOString(),
      };
      if (afterOpen) {
        // #80: the rule version's items stay as the open recorded them or a supplement since made
        // them, and a live market keeps the tags its review required.
        const stored = ruleContentOf(current, currentSources);
        const changed = changedRuleVersionItems(stored, withContent(stored, body));
        if (changed.length > 0) {
          throw supplementOnlyWhileOpen(changed, current.ruleVersion, current.status);
        }
        if (body.tags !== undefined && body.tags.length < MARKET_TAGS_MIN) {
          throw fieldError(
            'tags',
            `Tags cannot be removed while the market is ${current.status}`,
            'required while open',
          );
        }
      }
      // An open or paused market's version items are its stored ones (refused above otherwise),
      // so what follows writes them for a draft alone.
      const items = afterOpen ? before : withRuleItems(before, body);
      const times = afterOpen ? storedTimes : withTimes(storedTimes, body);
      if (
        !afterOpen &&
        (body.fallbackSources !== undefined || body.fallbackCondition !== undefined)
      ) {
        assertFallbackCondition(items);
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
      if (body.imageUrl !== undefined) set.imageUrl = body.imageUrl ?? null;
      if (body.slug !== undefined) set.slug = body.slug;
      if (categoryChange) {
        assertSelectableCategory(categoryChange.selectability);
        set.categoryId = categoryChange.id;
      }
      if (!afterOpen) {
        if (body.title !== undefined) set.title = body.title;
        // The rule items the body sends, as `items` holds them; the sources are written below.
        const columns = ruleItemColumns(items);
        if (body.description !== undefined) set.description = columns.description;
        if (body.yesCondition !== undefined) set.yesCondition = columns.yesCondition;
        if (body.noCondition !== undefined) set.noCondition = columns.noCondition;
        if (body.eventDeadline !== undefined) set.eventDeadline = columns.eventDeadline;
        if (body.fallbackCondition !== undefined) {
          set.fallbackCondition = columns.fallbackCondition;
        }
        if (body.longDelayDays !== undefined) set.longDelayDays = columns.longDelayDays;
        if (body.delayHandling !== undefined) set.delayHandling = columns.delayHandling;
        const timeSet = timeColumns(times);
        if (body.closeAt !== undefined) {
          assertFutureCloseAt(timeSet.closeAt, now);
          set.closeAt = timeSet.closeAt;
        }
        assertTimeOrder({ ...times, eventDeadline: items.eventDeadline }, sentTimeFields(body));
        if (body.scheduledOpenAt !== undefined) set.scheduledOpenAt = timeSet.scheduledOpenAt;
        if (body.scheduledAnnouncementAt !== undefined) {
          set.scheduledAnnouncementAt = timeSet.scheduledAnnouncementAt;
        }
        if (body.scheduledJudgementAt !== undefined) {
          set.scheduledJudgementAt = timeSet.scheduledJudgementAt;
        }
        if (body.judgementTimeZone !== undefined) {
          set.judgementTimeZone = timeSet.judgementTimeZone;
        }
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

      const edited = rulesEditedPayload(
        rulesEditedValues(before, storedTimes),
        rulesEditedValues(ruleItemsOf(row, sources), timesOf(row)),
      );
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
      // Gated twice, so a no-op PATCH costs no viewer a request. Of the statuses an edit reaches,
      // OPEN and PAUSED have viewers — a draft is on no public route — and only a row that
      // actually MOVED leaves one holding something stale. The gate is the AUDIT projection
      // rather than "the body was non-empty": `snapshot` carries every column a PATCH can reach
      // and not `updatedAt`, so resaving identical text differs nowhere, and the gate stays exact
      // when the next editable column is added.
      return {
        market: await this.toAdminMarket(tx, row, tags, sources),
        moved: afterOpen && JSON.stringify(beforeSnapshot) !== JSON.stringify(afterSnapshot),
      };
    });
    // Outside the transaction, exactly as the transitions publish: a subscriber answers
    // `market:status` with a REFETCH, and one issued before COMMIT would read the row this
    // transaction has not written yet. No job moves: a draft has none, and an open market's
    // close moves by a supplement alone (MarketSupplementService).
    if (moved) await this.publishStatus(market);
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
      const current = await lockedMarketRow(tx, id);
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
   * 검수 제출 (#78, ADR-0099; ADR-0093 decision 2 #172 item 6): draft → review, by any admin. Any
   * other status is refused naming `status`. The gate is the open-items check at the gap in force
   * (`assertOpenItems`, `leadCloseGap`; #17, #23: the title and every rule item, never without them
   * — PLAN 0.2; #22: the scheduled open and judgement, the judgement time zone, the times in order
   * and the lead close; a category a new market may be filed under; 1..5 tags), OPEN_ITEMS_MISSING
   * naming every missing item; then a close still ahead (`closeAt`, 'must be in the future'): what
   * the market lacks comes first. The scheduled open is not asked: a market approved after it opens
   * at the approval (#21, ADR-0100). Opens the `market_review` request (#171; payload `{title}`),
   * moves the market with a `submitted` event naming the request and the gap the check used — which
   * the market keeps (`lead_close_gap_minutes`), so the approval checks with the same one and the
   * open keeps it — and writes `market_submit` with the market as submitted. From here the content
   * is locked (`update`). A market in REVIEW is not public: nothing is published.
   */
  async submit(adminId: string, id: string): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      if (current.status !== 'draft') throw wrongStatus(current.status);
      const tags = await marketTagNames(tx, id);
      const sources = await readMarketSources(tx, id);
      const category = await readCategorySelectability(tx, current.categoryId);
      const leadCloseGapMinutes = await this.leadCloseGap(tx, current);
      assertOpenItems(current, tags, sources, category, leadCloseGapMinutes);
      const request = await this.approvals.request(
        {
          kind: MARKET_REVIEW_APPROVAL_KIND,
          targetType: 'market',
          targetId: id,
          payload: { title: current.title },
          requestedBy: adminId,
          reason: MARKET_REVIEW_REQUEST_REASON,
        },
        tx,
      );
      // The request's instant, read after every lock this write queued on (class doc). A past
      // close refused after the INSERT rolls it back with the rest.
      const now = request.requestedAt;
      assertFutureCloseAt(current.closeAt, now);
      const row = await this.transition(tx, current, {
        to: 'review',
        type: 'submitted',
        actorId: adminId,
        payload: { approvalId: request.id, leadCloseGapMinutes } satisfies MarketSubmittedPayload,
        at: now,
        set: { leadCloseGapMinutes },
      });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_submit',
        targetType: 'market',
        targetId: id,
        payload: { approvalId: request.id, after: snapshot(row, tags, sources) },
        createdAt: now,
      });
      return await this.toAdminMarket(tx, row, tags, sources);
    });
  }

  /**
   * 승인 (#78; #172 items 4·5): review → scheduled. Anything but REVIEW is refused naming `status`
   * — so of an approval and another write at once, the second finds what the first left. Then the
   * request the admin reviewed, which must still be the pending one (`assertReviewedRequest`: a
   * market sent back and submitted again is a new request), then the deciding admin's exclusions,
   * before the two-person rule's own (`assertMayDecide`), then the open-items check again at the
   * gap the submission stored — a category hidden since refuses it (OPEN_ITEMS_MISSING) — and a
   * close still ahead (`closeAt`). The checklist was complete when the body parsed
   * (VALIDATION_ERROR on `checklist` before anything is read); the `approved` event and
   * `market_approve` keep it in MARKET_REVIEW_CHECKLIST order, with the request and the reason the
   * request's decision keeps too.
   *
   * Approved at or after its scheduled open, the market opens in the same transaction at the
   * decision instant (#21, ADR-0100; ADR-0093 decision 2 #172 item 6 '승인하는 즉시 연다'):
   * `openScheduledMarket` — the `opened` event after the `approved` one, its actor the approving
   * admin and its source `approval`, `open_at` that instant. The answer is then the OPEN market;
   * the `market_approve` record and the `opened` event say who opened it, so it has no record of
   * its own. After COMMIT, `market:status` once, with the status the approval left and its last
   * key — SCHEDULED is public too (#173 item 12) — and the jobs: `market.close` at the close
   * (locked from here on; registered before the open it is harmless, since the worker closes only
   * an open market) and, when the scheduled open is still ahead, `market.open` at it.
   */
  async approve(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<ApproveMarketReviewBody>,
  ): Promise<AdminMarket> {
    const { market, now, closeAt, openJobAt } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      if (current.status !== 'review') throw wrongStatus(current.status);
      const request = await pendingReview(tx, id);
      await assertReviewedRequest(tx, id, request, body.requestId);
      await assertMayDecide(tx, adminId, current, request);
      const tags = await marketTagNames(tx, id);
      const sources = await readMarketSources(tx, id);
      const category = await readCategorySelectability(tx, current.categoryId);
      assertOpenItems(current, tags, sources, category, current.leadCloseGapMinutes);
      const decided = await this.approvals.approve(adminId, request.id, body.reason, tx);
      const now = decisionInstant(decided);
      assertFutureCloseAt(current.closeAt, now);
      const detail = {
        approvalId: request.id,
        checklist: MARKET_REVIEW_CHECKLIST.filter((item) => body.checklist.includes(item)),
        reason: body.reason,
      } satisfies MarketApprovedPayload;
      const scheduled = await this.transition(tx, current, {
        to: 'scheduled',
        type: 'approved',
        actorId: adminId,
        payload: detail,
        at: now,
      });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_approve',
        targetType: 'market',
        targetId: id,
        payload: detail,
        createdAt: now,
      });
      const opening = await this.openIfDue(tx, scheduled, now, adminId, 'approval');
      return {
        market: await this.toAdminMarket(tx, opening ?? scheduled, tags, sources),
        now,
        closeAt: scheduled.closeAt,
        openJobAt: opening ? null : scheduled.scheduledOpenAt,
      };
    });
    await Promise.all([
      this.publishStatus(market),
      this.jobs.scheduleClose(id, closeAt, now),
      openJobAt ? this.jobs.scheduleOpen(id, openJobAt, now) : undefined,
    ]);
    return market;
  }

  /**
   * 반려 (#78; #173 item 1, #172 item 4): review → draft, with one of MARKET_REJECT_REASONS and the
   * description the creator reads in the 검수 기록. Refused as the approval is: `status`, then the
   * request the admin reviewed (`assertReviewedRequest`), then the deciding admin's exclusions
   * (`assertMayDecide`); nothing else is asked. Rejects the request
   * with the description as its reason and clears the stored lead-close gap: the draft is checked
   * again against the setting in force at its next submission. Not public before or after: nothing
   * is published.
   */
  async reject(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<RejectMarketReviewBody>,
  ): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      if (current.status !== 'review') throw wrongStatus(current.status);
      const request = await pendingReview(tx, id);
      await assertReviewedRequest(tx, id, request, body.requestId);
      await assertMayDecide(tx, adminId, current, request);
      const decided = await this.approvals.reject(adminId, request.id, body.reason, tx);
      const now = decisionInstant(decided);
      const detail = {
        approvalId: request.id,
        rejectReason: body.rejectReason,
        reason: body.reason,
      } satisfies MarketRejectedPayload;
      const row = await this.transition(tx, current, {
        to: 'draft',
        type: 'rejected',
        actorId: adminId,
        payload: detail,
        at: now,
        set: { leadCloseGapMinutes: null },
      });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_reject',
        targetType: 'market',
        targetId: id,
        payload: detail,
        createdAt: now,
      });
      const tags = await marketTagNames(tx, id);
      return await this.toAdminMarket(tx, row, tags, await readMarketSources(tx, id));
    });
  }

  /**
   * 되돌리기 (#78; #172 item 6): review or scheduled → draft, by any admin — the creator, an editor
   * and the submitter too — with a reason, so the market can be edited and reviewed again. Any
   * other status is refused naming `status`. In REVIEW the pending request ends: the submitter's
   * own 되돌리기 retracts it, anyone else's rejects it with the 되돌리기's reason, so the request
   * records who ended it and why. In SCHEDULED the approved request stays as decided. The
   * `reverted` event and `market_revert` name that request; the stored lead-close gap is cleared,
   * as a 반려 clears it. A SCHEDULED market whose close passed before it opened is sent back here
   * too: the open skips it (`close_passed`), and #172 item 6 has an admin fix its times as a draft
   * (#21, ADR-0100). After COMMIT, when it left SCHEDULED, `market:status` with `draft` — a
   * viewer's detail refetches and finds the market gone (404), and a list drops it on its next
   * read — and the approval's jobs cancelled: `market.open` at the scheduled open and
   * `market.close` at the close, which the 되돌리기 leaves as they were. Hygiene, as an early close's
   * cancel (MarketPauseService): either job finds a draft under the market lock and skips it.
   */
  async revert(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<RevertMarketBody>,
  ): Promise<AdminMarket> {
    const { market, from, registered } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const from = current.status;
      if (from !== 'review' && from !== 'scheduled') throw wrongStatus(from);
      let approvalId: string;
      let now: Date;
      if (from === 'review') {
        const request = await pendingReview(tx, id);
        const ended =
          request.requestedBy.id === adminId
            ? await this.approvals.retract(adminId, request.id, tx)
            : await this.approvals.reject(adminId, request.id, body.reason, tx);
        approvalId = request.id;
        now = ended.retractedAt ?? decisionInstant(ended);
      } else {
        const approved = await approvedReviewRequestId(tx, id);
        if (approved === null) {
          throw new AppError('INTERNAL', { message: `Scheduled market ${id} has no approval` });
        }
        approvalId = approved;
        // After the market lock (clock.ts): no request step reads the clock here.
        now = await clockTimestamp(tx);
      }
      const detail = { approvalId, reason: body.reason } satisfies MarketRevertedPayload;
      const row = await this.transition(tx, current, {
        to: 'draft',
        type: 'reverted',
        actorId: adminId,
        payload: detail,
        at: now,
        set: { leadCloseGapMinutes: null },
      });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_revert',
        targetType: 'market',
        targetId: id,
        payload: { ...detail, from },
        createdAt: now,
      });
      const tags = await marketTagNames(tx, id);
      const sources = await readMarketSources(tx, id);
      return {
        market: await this.toAdminMarket(tx, row, tags, sources),
        from,
        // The instants the approval (or a reschedule) registered the jobs under.
        registered: { scheduledOpenAt: current.scheduledOpenAt, closeAt: current.closeAt },
      };
    });
    if (from === 'scheduled') {
      await Promise.all([
        this.publishStatus(market),
        registered.scheduledOpenAt
          ? this.jobs.cancelOpen(id, registered.scheduledOpenAt)
          : undefined,
        this.jobs.cancelClose(id, registered.closeAt),
      ]);
    }
    return market;
  }

  /**
   * 예정 개장 시각 변경 (#78; #172 item 6, ADR-0093 decision 3 '#78 수정 기록의 사유' and '#21 앞당긴
   * 개장'): a SCHEDULED market's scheduled open moved without a new review, by any admin, with a
   * reason — the one change the review's lock lets through (ADR-0099 takes it from ADR-0098 결과 5's
   * #21). Any other status is refused naming `status`; a close already passed is refused as the
   * approval refuses it (`closeAt`, 'must be in the future'): #172 item 6 sends such a market back
   * to a draft to fix its times and be reviewed again. The stored instant again is VALIDATION_ERROR
   * on `scheduledOpenAt`, 'unchanged'; an instant at or after the close in whole minutes is the
   * order refusal the PATCH gives (`assertTimeOrder`: both ends, `scheduledOpenAt` first), the
   * only rule the scheduled open is an end of. An `open_rescheduled` event (no status change, as
   * `rules_edited`) and `market_reschedule`, each `{before, after, reason}`; its admin counts as an
   * editor in a later review cycle (`marketEditors`).
   *
   * An instant at or before now is allowed, and opens the market in the same transaction (#21,
   * ADR-0100): there is no early-open action — to open sooner an admin moves the scheduled open
   * earlier (decision 3 '#21 앞당긴 개장'). `openScheduledMarket` writes the `opened` event after the
   * `open_rescheduled` one, its actor the admin and its source `reschedule`, and the answer is the
   * OPEN market. After COMMIT `market:status`: the OPEN status with the `opened` event's key, or —
   * still SCHEDULED — the status and key unchanged, as an edit of an open market republishes it, so
   * a viewer refetches the time. The open job moves with the instant: the one under the old
   * scheduled open is cancelled, and one under the new instant registered unless the market opened.
   */
  async reschedule(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<RescheduleMarketOpenBody>,
  ): Promise<AdminMarket> {
    const { market, now, before, openJobAt } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      if (current.status !== 'scheduled') throw wrongStatus(current.status);
      // After the market lock (clock.ts): the change sorts after whatever committed meanwhile.
      const now = await clockTimestamp(tx);
      assertFutureCloseAt(current.closeAt, now);
      const stored: MarketTimeItems = {
        ...timesOf(current),
        closeAt: current.closeAt.toISOString(),
      };
      const times = withTimes(stored, { scheduledOpenAt: body.scheduledOpenAt });
      if (sameTimeItem('scheduledOpenAt', times.scheduledOpenAt, stored.scheduledOpenAt)) {
        throw fieldError('scheduledOpenAt', 'The scheduled open is unchanged', 'unchanged');
      }
      assertTimeOrder(
        { ...times, eventDeadline: current.eventDeadline?.toISOString() ?? null },
        new Set(['scheduledOpenAt']),
      );
      const [moved] = await tx
        .update(schema.markets)
        .set({ scheduledOpenAt: new Date(body.scheduledOpenAt), updatedAt: now })
        .where(eq(schema.markets.id, id))
        .returning();
      if (!moved) throw new AppError('INTERNAL', { message: 'Market update failed' });
      // `before` is null only for a SCHEDULED market written outside the review (a test factory's).
      const detail = {
        before: stored.scheduledOpenAt,
        after: times.scheduledOpenAt,
        reason: body.reason,
      };
      await tx.insert(schema.marketEvents).values({
        marketId: id,
        type: 'open_rescheduled',
        actorId: adminId,
        payload: detail,
        createdAt: now,
      });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_reschedule',
        targetType: 'market',
        targetId: id,
        payload: detail,
        createdAt: now,
      });
      const opened = await this.openIfDue(tx, moved, now, adminId, 'reschedule');
      const tags = await marketTagNames(tx, id);
      const sources = await readMarketSources(tx, id);
      return {
        market: await this.toAdminMarket(tx, opened ?? moved, tags, sources),
        now,
        before: current.scheduledOpenAt,
        openJobAt: opened ? null : moved.scheduledOpenAt,
      };
    });
    await Promise.all([
      this.publishStatus(market),
      before ? this.jobs.cancelOpen(id, before) : undefined,
      openJobAt ? this.jobs.scheduleOpen(id, openJobAt, now) : undefined,
    ]);
    return market;
  }

  /** `GET /admin/market-reviews` (검수 대기, #78): `listMarketReviews`, the oldest request first. */
  listReviews(query: CursorQuery): Promise<Page<AdminMarketReviewItem>> {
    return listMarketReviews(this.db, query);
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
    // One read-only REPEATABLE READ snapshot (Codex review of #78): the content and the pending
    // review request it is shown with come from one moment, so a 되돌리기, an edit and a new
    // submission committing between two reads cannot pair the old content with the new request —
    // the `requestId` a 승인 names would then approve what the reviewer never saw. So do the rule
    // versions and the waiting supplement (#80): an approval between the reads would otherwise
    // show the new text beside the old history and request — and the pause and its waiting next
    // path (#114), which an approval moves with the status.
    return this.db.transaction(
      async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.markets)
          .where(eq(schema.markets.id, id))
          .limit(1);
        if (!row) throw new AppError('NOT_FOUND', { message: 'Market not found' });
        const tags = await marketTagNames(tx, id);
        return this.toAdminMarket(tx, row, tags, await readMarketSources(tx, id));
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
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

  /**
   * SCHEDULED → OPEN by an admin's write that has just left `row` SCHEDULED — the approval or the
   * reschedule — when its scheduled open has come (#21, ADR-0100; ADR-0093 decision 2 #172 item 6,
   * decision 3 '#21 앞당긴 개장'): `openScheduledMarket` under the market lock the caller holds, at
   * the caller's instant `now`, the admin as its actor. Answers the OPEN row, or null while the
   * scheduled open is still ahead (`not_due`). The caller checked on the same clock that the close
   * is ahead, so any other skip is a broken invariant — INTERNAL, never an answer.
   */
  private async openIfDue(
    tx: Tx,
    row: MarketRow,
    now: Date,
    adminId: string,
    source: Exclude<OpenSource, 'job'>,
  ): Promise<MarketRow | null> {
    const result = await openScheduledMarket(tx, { market: row, now, actorId: adminId, source });
    if (result.opened) return result.row;
    if (result.reason === 'not_due') return null;
    throw new AppError('INTERNAL', {
      message: `Market ${row.id} was not opened by its ${source}: ${result.reason}`,
    });
  }

  /**
   * The release setting `market.lead_close_gap` in minutes (#22, LEAD_CLOSE_GAP_SETTING): its value
   * in any status (proposal, test or approved, as the start grant's), null while undecided. Read
   * through `executor` once per write, which keeps what it read (docs/SETTINGS.md). A supplement's
   * lead-close check reads it too (MarketSupplementService, #80).
   */
  async leadCloseGapSetting(executor: Executor): Promise<number | null> {
    const reading = await this.settings.get(LEAD_CLOSE_GAP_SETTING, executor);
    return reading.status === 'undecided' ? null : reading.value;
  }

  /**
   * The 선행 마감 gap `row` is held to (#22, ADR-0098; `AdminMarket.leadCloseGapMinutes`): the one
   * its lead close was last checked against (`lead_close_gap_minutes`, which the review submission
   * stores, the open keeps (#21) and a 반려 or 되돌리기 clears, ADR-0099) once it has one, else the
   * setting's current reading (`leadCloseGapSetting`).
   */
  private async leadCloseGap(executor: Executor, row: MarketRow): Promise<number | null> {
    return row.leadCloseGapMinutes ?? (await this.leadCloseGapSetting(executor));
  }

  /**
   * The admin detail: the public shape plus exposure figures, settlement steps, the event log,
   * what the open-items check finds missing (#17, #23, #22, every status) at the lead-close gap
   * the market is held to (`leadCloseGap`, which it reports too), the review (#78,
   * `readMarketReview`: its request, creator, editors, same-condition markets and 검수 기록), and
   * the rule versions with who asked for and made each and the supplement requests (#80,
   * `readAdminRuleVersions`, `readMarketSupplement`: one statement each), and the pauses with the
   * next-path requests (#114, `readMarketPause`: one statement each). Reads through `executor` so a
   * transition returns the state it just committed; `tags` are the market's names in order
   * (`marketTagNames`) and `sources` its sources (`readMarketSources`), which every caller holds
   * already. MarketSupplementService's and MarketPauseService's writes answer with it too.
   *
   * The category's selectability is read in the same statement as its name and WITHOUT the
   * FOR SHARE locks of `readCategorySelectability`: the detail is also read on the pool (`get`),
   * where a lock would last one statement and guard nothing — it reports, and the writes that act
   * on the answer (create, a category change, the submission, the approval) read it locked
   * themselves.
   */
  async toAdminMarket(
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

    const leadCloseGapMinutes = await this.leadCloseGap(executor, row);
    const ruleVersions = await readAdminRuleVersions(executor, row.id);
    return {
      ...toMarket(row, { slug: category.slug, nameKo: category.nameKo }, tags, sources, []),
      // The admin's form of the history, in the public list's place (`AdminMarket.ruleVersions`).
      ruleVersions,
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
        ...timesOf(row),
        closeAt: row.closeAt.toISOString(),
        categorySelectable: unselectable === null,
        tagCount: tags.length,
        leadCloseGapMinutes,
      }),
      leadCloseGapMinutes,
      review: await readMarketReview(executor, row),
      supplement: await readMarketSupplement(executor, row.id, ruleVersions),
      pause: await readMarketPause(executor, row.id),
    };
  }

  /**
   * `market:status` on the market's channel, after COMMIT (best effort).
   *
   * Sent by every transition that a member can see — to or from a public status: not a review's
   * submission, 반려 or 되돌리기 from REVIEW, which no member sees; an approval or a reschedule that
   * opens the market sends one, the OPEN status with the `opened` event's key (#21); a pause, and
   * the approval of its next path — the OPEN status of a resume, which goes back in rank, or the
   * CLOSED of an early close (#114, MarketPauseService) — and by an edit that moves an open or
   * paused market's category, tags or image, a SCHEDULED market's open-time change that leaves it
   * SCHEDULED (#78) and a supplement's approval, which moves an open or paused market's rules to a
   * new version (#80, MarketSupplementService), where the status is
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
  async publishStatus(market: AdminMarket): Promise<void> {
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
