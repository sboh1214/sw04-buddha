import { schema, type Db } from '@buddha/db';
import {
  MARKET_CANCEL_APPROVAL_KIND,
  decodeKeyset,
  encodeKeyset,
  marketCancelRequestPayloadSchema,
  type AdminAccountActor,
  type AdminMarketCancelItem,
  type AdminMarketCancelState,
  type ApprovalStatus,
  type CursorQuery,
  type MarketCancelLogEntry,
  type MarketCancelRequestPayload,
} from '@buddha/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { type Page } from '../wallet/wallet.service.js';
import { type Executor } from './market-item-rules.js';

/**
 * 시장 취소 of a SCHEDULED market (#20, ADR-0117; market-cancel.ts in @buddha/shared and
 * @buddha/db) as the admin screens read it: a market's `market_cancel` requests
 * (`AdminMarket.cancel`) and the 시장 취소 대기 queue. MarketCancelService's writes read the
 * requests here too, under the market lock.
 *
 * An account is named as every admin record names one (`AdminAccountActor`, as market-pause.ts):
 * its id and its current nickname, read from `profiles` — null once its member closed it (#140).
 * The joins are LEFT, so a missing profile hides no row. Nothing here is public: the cancel's
 * public reason is the `cancelled` event's (MarketCancelledPayload), which the public judging
 * record shows from #24, naming nobody.
 */

const { approvalRequests, markets, profiles } = schema;

/** An account as the admin screen names it (see the module doc). */
const actor = (id: string, nickname: string | null): AdminAccountActor => ({ id, nickname });

/** The `market_cancel` requests about `marketId` (target `market`, its id as text). */
function marketCancelRequestsOf(marketId: string) {
  return and(
    eq(approvalRequests.kind, MARKET_CANCEL_APPROVAL_KIND),
    eq(approvalRequests.targetType, 'market'),
    eq(approvalRequests.targetId, marketId),
  );
}

/** A cancel request as the writes read it. */
export interface MarketCancelRequestRow {
  id: string;
  requestedBy: string;
  requestReason: string;
  requestedAt: Date;
  status: ApprovalStatus;
  payload: Record<string, unknown> | null;
}

/**
 * A cancel request's payload (`approval_requests.payload`, frozen at the insert): `{statusEventId}`
 * as MarketCancelService wrote it. Anything else is a broken invariant — INTERNAL, never an answer.
 */
export function marketCancelPayloadOf(
  request: Pick<MarketCancelRequestRow, 'id' | 'payload'>,
): MarketCancelRequestPayload {
  const parsed = marketCancelRequestPayloadSchema.safeParse(request.payload);
  if (!parsed.success) {
    throw new AppError('INTERNAL', {
      message: `Market cancel request ${request.id} has a malformed payload`,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * The market's `market_cancel` request `requestId`, or null when the market has none by that id —
 * another market's, another kind's or no request at all.
 */
export async function marketCancelRequestOf(
  executor: Executor,
  marketId: string,
  requestId: string,
): Promise<MarketCancelRequestRow | null> {
  const [row] = await executor
    .select({
      id: approvalRequests.id,
      requestedBy: approvalRequests.requestedBy,
      requestReason: approvalRequests.requestReason,
      requestedAt: approvalRequests.requestedAt,
      status: approvalRequests.status,
      payload: approvalRequests.payload,
    })
    .from(approvalRequests)
    .where(and(marketCancelRequestsOf(marketId), eq(approvalRequests.id, requestId)))
    .limit(1);
  return row ?? null;
}

/**
 * Whether a `market_cancel` request of the market waits: read under the market lock, which every
 * cancel write holds, so at most one ever does (MarketCancelService.request).
 */
export async function hasPendingMarketCancel(
  executor: Executor,
  marketId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(and(marketCancelRequestsOf(marketId), eq(approvalRequests.status, 'pending')))
    .limit(1);
  return row !== undefined;
}

const cancelRequester = alias(profiles, 'cancel_requester');
const cancelDecider = alias(profiles, 'cancel_decider');

/**
 * `AdminMarket.cancel` (#20, every status), through `executor` so a write answers with what it
 * wrote: every `market_cancel` request of the market, the newest first, with how it ended — the
 * decider, the decision's instant and reason, the 철회's instant — and the one waiting, if any.
 * One statement.
 */
export async function readMarketCancel(
  executor: Executor,
  marketId: string,
): Promise<AdminMarketCancelState> {
  const requests = await executor
    .select({
      id: approvalRequests.id,
      requestedBy: approvalRequests.requestedBy,
      requesterNickname: cancelRequester.nickname,
      requestReason: approvalRequests.requestReason,
      requestedAt: approvalRequests.requestedAt,
      status: approvalRequests.status,
      decidedBy: approvalRequests.decidedBy,
      deciderNickname: cancelDecider.nickname,
      decidedAt: approvalRequests.decidedAt,
      decisionReason: approvalRequests.decisionReason,
      retractedAt: approvalRequests.retractedAt,
    })
    .from(approvalRequests)
    .leftJoin(cancelRequester, eq(cancelRequester.userId, approvalRequests.requestedBy))
    .leftJoin(cancelDecider, eq(cancelDecider.userId, approvalRequests.decidedBy))
    .where(marketCancelRequestsOf(marketId))
    .orderBy(desc(approvalRequests.requestedAt), desc(approvalRequests.id));
  const log = requests.map((row): MarketCancelLogEntry => ({
    requestId: row.id,
    reason: row.requestReason,
    requestedBy: actor(row.requestedBy, row.requesterNickname),
    requestedAt: row.requestedAt.toISOString(),
    status: row.status,
    decidedBy: row.decidedBy === null ? null : actor(row.decidedBy, row.deciderNickname),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    retractedAt: row.retractedAt?.toISOString() ?? null,
  }));
  const pending = log.find((entry) => entry.status === 'pending');
  return {
    pending:
      pending === undefined
        ? null
        : {
            requestId: pending.requestId,
            reason: pending.reason,
            requestedBy: pending.requestedBy,
            requestedAt: pending.requestedAt,
          },
    log,
  };
}

const queueRequester = alias(profiles, 'cancel_queue_requester');

/**
 * `GET /admin/market-cancel-requests` (시장 취소 대기, #20): every waiting `market_cancel` request
 * with its market, in any status — one still waiting after the market opened or went back to a
 * draft shows until its 반려 or 철회 — the oldest request first over `(requested_at, id)`
 * ascending, the order of `approval_requests_pending_requested_at_idx` (migration 0042), with the
 * request's keyset as the cursor (as the 일시 중단 결정 대기 queue).
 */
export async function listMarketCancelRequests(
  db: Db,
  query: CursorQuery,
): Promise<Page<AdminMarketCancelItem>> {
  const { cursor, limit } = query;
  const keyset = decodeKeyset(cursor, 'uuid');
  const rows = await db
    .select({
      id: approvalRequests.id,
      requestedBy: approvalRequests.requestedBy,
      requesterNickname: queueRequester.nickname,
      requestReason: approvalRequests.requestReason,
      requestedAt: approvalRequests.requestedAt,
      marketId: markets.id,
      slug: markets.slug,
      title: markets.title,
      marketStatus: markets.status,
      scheduledOpenAt: markets.scheduledOpenAt,
      closeAt: markets.closeAt,
    })
    .from(approvalRequests)
    // `target_id` is text: the market's id is cast, never the target (another kind's target need
    // not be a uuid).
    .innerJoin(markets, eq(sql`${markets.id}::text`, approvalRequests.targetId))
    .leftJoin(queueRequester, eq(queueRequester.userId, approvalRequests.requestedBy))
    .where(
      and(
        eq(approvalRequests.status, 'pending'),
        eq(approvalRequests.kind, MARKET_CANCEL_APPROVAL_KIND),
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
      requestId: row.id,
      marketId: row.marketId,
      slug: row.slug,
      title: row.title,
      status: row.marketStatus,
      scheduledOpenAt: row.scheduledOpenAt?.toISOString() ?? null,
      closeAt: row.closeAt.toISOString(),
      reason: row.requestReason,
      requestedBy: actor(row.requestedBy, row.requesterNickname),
      requestedAt: row.requestedAt.toISOString(),
    })),
    nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.requestedAt, id: last.id }) : null,
  };
}
