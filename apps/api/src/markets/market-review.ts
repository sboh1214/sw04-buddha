import { schema, type Db } from '@buddha/db';
import {
  MARKET_REJECT_REASONS,
  MARKET_REVIEW_APPROVAL_KIND,
  MARKET_REVIEW_CHECKLIST,
  MARKET_REVIEW_EVENT_TYPES,
  MARKET_REVIEW_UNFINISHED_STATUSES,
  decodeKeyset,
  encodeKeyset,
  type AdminAccountActor,
  type AdminActionType,
  type AdminMarketReview,
  type AdminMarketReviewItem,
  type CursorQuery,
  type MarketRejectReason,
  type MarketReviewChecklistItem,
  type MarketReviewEventType,
  type MarketReviewLogEntry,
  type MarketReviewSameCondition,
} from '@buddha/shared';
import { and, asc, desc, eq, inArray, min, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { keysetPredicate } from '../common/keyset.js';
import { type Page } from '../wallet/wallet.service.js';
import { type MarketRow } from './market.service.js';

/**
 * 개설 검수 (#78, ADR-0099) as the admin screens read it: the market's `market_review` requests,
 * its editors, the unfinished markets with the same conditions, its 검수 기록 and the 검수 대기
 * queue. MarketAdminService's writes read the requests and the editors here too, under the market
 * lock, so the exclusions they refuse are the ones the detail shows.
 *
 * An account is named as every admin record names one (`AdminAccountActor`): its id and its
 * current nickname, read from `profiles` — null once its member closed it (#140). The joins are
 * LEFT, as the proposals' (proposal-rows.ts), so a missing profile hides no row.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Reads that run either inside a transaction or on the pool. */
type Executor = Db | Tx;

const { adminActions, approvalRequests, categories, marketEvents, markets, profiles } = schema;

/** The 검수 기록 the admin detail shows, newest first: the cap of its event log (`events`). */
export const REVIEW_LOG_LIMIT = 100;

/** The records that make their admin an editor (`marketEditors`). */
const MARKET_EDIT_ACTIONS: AdminActionType[] = ['market_update', 'market_reschedule'];

/** The submitter and the creator in the queue: two joins of `profiles`, so two names. */
const requesterProfile = alias(profiles, 'review_requester');
const creatorProfile = alias(profiles, 'review_creator');

/** An account as the admin screen names it (see the module doc). */
const actor = (id: string, nickname: string | null): AdminAccountActor => ({ id, nickname });

/** The `market_review` requests about `marketId` (target `market`, its id as text). */
function reviewRequestsOf(marketId: string) {
  return and(
    eq(approvalRequests.kind, MARKET_REVIEW_APPROVAL_KIND),
    eq(approvalRequests.targetType, 'market'),
    eq(approvalRequests.targetId, marketId),
  );
}

/**
 * How the market's `market_review` request `requestId` stands, or null when no request of this
 * market's review has that id: what a decision naming a request no longer pending is told.
 */
export async function reviewRequestStatus(
  executor: Executor,
  marketId: string,
  requestId: string,
): Promise<string | null> {
  const [row] = await executor
    .select({ status: approvalRequests.status })
    .from(approvalRequests)
    .where(and(reviewRequestsOf(marketId), eq(approvalRequests.id, requestId)))
    .limit(1);
  return row?.status ?? null;
}

/** A `market_review` request as the review's writes and the detail use it. */
export interface ReviewRequest {
  id: string;
  requestedBy: AdminAccountActor;
  requestedAt: Date;
}

/**
 * The market's pending `market_review` requests, the oldest first: exactly one while it is in
 * REVIEW (the submission opens it, and the approval, the 반려 and the 되돌리기 end it, each under the
 * market lock), none in any other status.
 */
export async function pendingReviewRequests(
  executor: Executor,
  marketId: string,
): Promise<ReviewRequest[]> {
  const rows = await executor
    .select({
      id: approvalRequests.id,
      requestedBy: approvalRequests.requestedBy,
      nickname: profiles.nickname,
      requestedAt: approvalRequests.requestedAt,
    })
    .from(approvalRequests)
    .leftJoin(profiles, eq(profiles.userId, approvalRequests.requestedBy))
    .where(and(reviewRequestsOf(marketId), eq(approvalRequests.status, 'pending')))
    .orderBy(asc(approvalRequests.requestedAt), asc(approvalRequests.id));
  return rows.map((row) => ({
    id: row.id,
    requestedBy: actor(row.requestedBy, row.nickname),
    requestedAt: row.requestedAt,
  }));
}

/**
 * The id of the request whose approval made the market SCHEDULED: its latest approved
 * `market_review` request (a market sent back and approved again has one per cycle, each after the
 * last). Null for a market that never went through the review routes (a test factory's).
 */
export async function approvedReviewRequestId(
  executor: Executor,
  marketId: string,
): Promise<string | null> {
  const [row] = await executor
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(and(reviewRequestsOf(marketId), eq(approvalRequests.status, 'approved')))
    .orderBy(desc(approvalRequests.requestedAt), desc(approvalRequests.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The market's editors (MARKET_REVIEW_EXCLUSIONS' `editor`, ADR-0093 decision 2 #172 item 5):
 * every admin with a `market_update` or `market_reschedule` record on it (the scheduled open is
 * content, #172 item 7), at any time — an earlier review cycle's too — the first edit first. The
 * creator is among them when they edited it. Walks `admin_actions_market_target_idx` (migration
 * 0052).
 */
export async function marketEditors(
  executor: Executor,
  marketId: string,
): Promise<AdminAccountActor[]> {
  const firstEdit = min(adminActions.createdAt);
  const rows = await executor
    .select({ id: adminActions.adminId, nickname: profiles.nickname })
    .from(adminActions)
    .leftJoin(profiles, eq(profiles.userId, adminActions.adminId))
    .where(
      and(
        eq(adminActions.targetType, 'market'),
        eq(adminActions.targetId, marketId),
        inArray(adminActions.type, MARKET_EDIT_ACTIONS),
      ),
    )
    .groupBy(adminActions.adminId, profiles.nickname)
    .orderBy(firstEdit, adminActions.adminId);
  return rows.map((row) => actor(row.id, row.nickname));
}

/**
 * The checklist's 중복 aid (#172 item 4): the other markets in MARKET_REVIEW_UNFINISHED_STATUSES
 * with the same YES condition and the same event deadline (the same instant), the oldest first;
 * none while either is blank. Every writer stores the rule items trimmed (the body schema), so
 * equal stored text is equal trimmed text. An aid: the reviewer still decides.
 */
async function sameConditionMarkets(
  executor: Executor,
  row: MarketRow,
): Promise<MarketReviewSameCondition[]> {
  const yesCondition = row.yesCondition.trim();
  if (yesCondition === '' || row.eventDeadline === null) return [];
  return executor
    .select({ id: markets.id, slug: markets.slug, title: markets.title, status: markets.status })
    .from(markets)
    .where(
      and(
        ne(markets.id, row.id),
        inArray(markets.status, [...MARKET_REVIEW_UNFINISHED_STATUSES]),
        eq(markets.yesCondition, yesCondition),
        eq(markets.eventDeadline, row.eventDeadline),
      ),
    )
    .orderBy(asc(markets.createdAt), asc(markets.id));
}

const isChecklistItem = (value: unknown): value is MarketReviewChecklistItem =>
  (MARKET_REVIEW_CHECKLIST as readonly unknown[]).includes(value);
const isRejectReason = (value: unknown): value is MarketRejectReason =>
  (MARKET_REJECT_REASONS as readonly unknown[]).includes(value);

/**
 * One review event as the 검수 기록 shows it: each field from the payload its type writes
 * (enums.ts, MarketAdminService), null where the type carries none or the payload lacks it.
 */
function toLogEntry(row: {
  type: string;
  actorId: string | null;
  actorFound: string | null;
  nickname: string | null;
  fromStatus: MarketReviewLogEntry['fromStatus'];
  toStatus: MarketReviewLogEntry['toStatus'];
  payload: Record<string, unknown> | null;
  createdAt: Date;
}): MarketReviewLogEntry {
  // varchar column; the query keeps MARKET_REVIEW_EVENT_TYPES only.
  const type = row.type as MarketReviewEventType;
  const payload = row.payload ?? {};
  const text = (key: string) => {
    const value = payload[key];
    return typeof value === 'string' ? value : null;
  };
  const rescheduled = type === 'open_rescheduled';
  return {
    type,
    // The actor's account is gone when no profile names it (`actor_id` has no foreign key).
    actor:
      row.actorId === null || row.actorFound === null ? null : actor(row.actorId, row.nickname),
    at: row.createdAt.toISOString(),
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    reason: type === 'submitted' ? null : text('reason'),
    rejectReason:
      type === 'rejected' && isRejectReason(payload.rejectReason) ? payload.rejectReason : null,
    checklist:
      type === 'approved' && Array.isArray(payload.checklist)
        ? payload.checklist.filter(isChecklistItem)
        : null,
    scheduledOpenBefore: rescheduled ? text('before') : null,
    scheduledOpenAfter: rescheduled ? text('after') : null,
  };
}

/**
 * `AdminMarket.review` of `row` (#78, every status), through `executor` so a write answers with
 * what it wrote: the pending request, the creator, the editors, the same-condition markets and the
 * 검수 기록 — the market's MARKET_REVIEW_EVENT_TYPES events, newest first by id (the market's
 * commit order, as `events`), capped at REVIEW_LOG_LIMIT like the event log.
 */
export async function readMarketReview(
  executor: Executor,
  row: MarketRow,
): Promise<AdminMarketReview> {
  const [pending] = await pendingReviewRequests(executor, row.id);
  const [creator] = await executor
    .select({ nickname: profiles.nickname })
    .from(profiles)
    .where(eq(profiles.userId, row.createdBy))
    .limit(1);
  const editors = await marketEditors(executor, row.id);
  const sameCondition = await sameConditionMarkets(executor, row);
  const log = await executor
    .select({
      type: marketEvents.type,
      actorId: marketEvents.actorId,
      actorFound: profiles.userId,
      nickname: profiles.nickname,
      fromStatus: marketEvents.fromStatus,
      toStatus: marketEvents.toStatus,
      payload: marketEvents.payload,
      createdAt: marketEvents.createdAt,
    })
    .from(marketEvents)
    .leftJoin(profiles, eq(profiles.userId, marketEvents.actorId))
    .where(
      and(
        eq(marketEvents.marketId, row.id),
        inArray(marketEvents.type, [...MARKET_REVIEW_EVENT_TYPES]),
      ),
    )
    .orderBy(desc(marketEvents.id))
    .limit(REVIEW_LOG_LIMIT);
  return {
    pending:
      pending === undefined
        ? null
        : {
            requestId: pending.id,
            requestedBy: pending.requestedBy,
            requestedAt: pending.requestedAt.toISOString(),
          },
    createdBy: actor(row.createdBy, creator?.nickname ?? null),
    editors,
    sameCondition,
    log: log.map(toLogEntry),
  };
}

/**
 * `GET /admin/market-reviews` (검수 대기, #78): the markets in REVIEW with their pending
 * `market_review` request, the oldest request first over `(requested_at, id)` ascending — the
 * order of `approval_requests_pending_requested_at_idx` (migration 0042) — with the request's
 * keyset as the cursor. `categoryName` is the category's `nameKo` (the FK keeps it).
 */
export async function listMarketReviews(
  db: Db,
  query: CursorQuery,
): Promise<Page<AdminMarketReviewItem>> {
  const { cursor, limit } = query;
  const keyset = decodeKeyset(cursor, 'uuid');
  const rows = await db
    .select({
      requestId: approvalRequests.id,
      requestedBy: approvalRequests.requestedBy,
      requesterNickname: requesterProfile.nickname,
      requestedAt: approvalRequests.requestedAt,
      marketId: markets.id,
      slug: markets.slug,
      title: markets.title,
      categoryName: categories.nameKo,
      scheduledOpenAt: markets.scheduledOpenAt,
      closeAt: markets.closeAt,
      createdBy: markets.createdBy,
      creatorNickname: creatorProfile.nickname,
    })
    .from(approvalRequests)
    // `target_id` is text: the market's id is cast, never the target (another kind's target need
    // not be a uuid).
    .innerJoin(
      markets,
      and(eq(sql`${markets.id}::text`, approvalRequests.targetId), eq(markets.status, 'review')),
    )
    .innerJoin(categories, eq(categories.id, markets.categoryId))
    .leftJoin(requesterProfile, eq(requesterProfile.userId, approvalRequests.requestedBy))
    .leftJoin(creatorProfile, eq(creatorProfile.userId, markets.createdBy))
    .where(
      and(
        eq(approvalRequests.status, 'pending'),
        eq(approvalRequests.kind, MARKET_REVIEW_APPROVAL_KIND),
        eq(approvalRequests.targetType, 'market'),
        keyset
          ? keysetPredicate(
              approvalRequests.requestedAt,
              approvalRequests.id,
              keyset,
              'uuid',
              'after',
            )
          : undefined,
      ),
    )
    .orderBy(asc(approvalRequests.requestedAt), asc(approvalRequests.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept.at(-1);
  return {
    items: kept.map((row) => ({
      marketId: row.marketId,
      slug: row.slug,
      title: row.title,
      categoryName: row.categoryName,
      scheduledOpenAt: row.scheduledOpenAt?.toISOString() ?? null,
      closeAt: row.closeAt.toISOString(),
      requestedBy: actor(row.requestedBy, row.requesterNickname),
      requestedAt: row.requestedAt.toISOString(),
      createdBy: actor(row.createdBy, row.creatorNickname),
    })),
    nextCursor:
      hasMore && last ? encodeKeyset({ createdAt: last.requestedAt, id: last.requestId }) : null,
  };
}
