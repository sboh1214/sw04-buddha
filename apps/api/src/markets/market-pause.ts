import { schema, type Db } from '@buddha/db';
import {
  MARKET_PAUSE_DECISION_APPROVAL_KIND,
  decodeKeyset,
  encodeKeyset,
  marketPauseDecisionRequestPayloadSchema,
  type AdminAccountActor,
  type AdminMarketPause,
  type AdminMarketPauseDecisionItem,
  type AdminMarketPauseState,
  type ApprovalStatus,
  type CursorQuery,
  type MarketPauseDecisionLogEntry,
  type MarketPauseDecisionRequestPayload,
} from '@buddha/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { type Page } from '../wallet/wallet.service.js';
import { type Executor } from './market-item-rules.js';

/**
 * 거래 일시 중단·재개·조기 마감 (#114, ADR-0102; market-pause.ts in @buddha/shared and @buddha/db)
 * as the admin screens read it: a market's pauses (`market_pauses`) and its
 * `market_pause_decision` requests (`AdminMarket.pause`), and the 일시 중단 결정 대기 queue.
 * MarketPauseService's writes read the requests here too, under the market lock.
 *
 * An account is named as every admin record names one (`AdminAccountActor`, as market-review.ts):
 * its id and its current nickname, read from `profiles` — null once its member closed it (#140).
 * The joins are LEFT, so a missing profile hides no row. Nothing here is public: the public
 * judging record reads the pauses from #24 (ADR-0093 decision 1 #173 item 13), naming nobody.
 */

const { approvalRequests, marketPauses, markets, profiles } = schema;

/** An account as the admin screen names it (see the module doc). */
const actor = (id: string, nickname: string | null): AdminAccountActor => ({ id, nickname });

/** The `market_pause_decision` requests about `marketId` (target `market`, its id as text). */
function pauseDecisionRequestsOf(marketId: string) {
  return and(
    eq(approvalRequests.kind, MARKET_PAUSE_DECISION_APPROVAL_KIND),
    eq(approvalRequests.targetType, 'market'),
    eq(approvalRequests.targetId, marketId),
  );
}

/** A next-path request as the writes and the detail read it. */
export interface PauseDecisionRequest {
  id: string;
  requestedBy: string;
  requestReason: string;
  requestedAt: Date;
  status: ApprovalStatus;
  payload: Record<string, unknown> | null;
}

/**
 * A next-path request's payload (`approval_requests.payload`, frozen at the insert): `{pauseId,
 * path, reviewResult}` as MarketPauseService wrote it. Anything else is a broken invariant —
 * INTERNAL, never an answer.
 */
export function pauseDecisionPayloadOf(
  request: Pick<PauseDecisionRequest, 'id' | 'payload'>,
): MarketPauseDecisionRequestPayload {
  const parsed = marketPauseDecisionRequestPayloadSchema.safeParse(request.payload);
  if (!parsed.success) {
    throw new AppError('INTERNAL', {
      message: `Pause decision request ${request.id} has a malformed payload`,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * The market's `market_pause_decision` request `requestId`, or null when the market has none by
 * that id — another market's, another kind's or no request at all.
 */
export async function pauseDecisionRequestOf(
  executor: Executor,
  marketId: string,
  requestId: string,
): Promise<PauseDecisionRequest | null> {
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
    .where(and(pauseDecisionRequestsOf(marketId), eq(approvalRequests.id, requestId)))
    .limit(1);
  return row ?? null;
}

/**
 * Whether a `market_pause_decision` request of the market waits: read under the market lock, which
 * every pause write holds, so at most one ever does (MarketPauseService.request).
 */
export async function hasPendingPauseDecision(
  executor: Executor,
  marketId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(and(pauseDecisionRequestsOf(marketId), eq(approvalRequests.status, 'pending')))
    .limit(1);
  return row !== undefined;
}

const pausedByProfile = alias(profiles, 'pause_paused_by');
const endedByProfile = alias(profiles, 'pause_ended_by');
const decisionRequester = alias(profiles, 'pause_decision_requester');
const decisionDecider = alias(profiles, 'pause_decision_decider');

/**
 * `AdminMarket.pause` (#114, every status), through `executor` so a write answers with what it
 * wrote: every pause of the market, the newest first (`paused_at`, then `id`, as
 * `readMarketPauses` of @buddha/db) — the first is the current one while it has no end — with who
 * paused and who approved its end (null for the worker's close at `close_at`); every
 * `market_pause_decision` request of the market, the newest first, with how it ended — the
 * decider, the decision's instant and reason, the 철회's instant — and the one waiting, if any.
 * One statement each.
 */
export async function readMarketPause(
  executor: Executor,
  marketId: string,
): Promise<AdminMarketPauseState> {
  const pauses = await executor
    .select({
      pause: marketPauses,
      pausedByNickname: pausedByProfile.nickname,
      endedByNickname: endedByProfile.nickname,
    })
    .from(marketPauses)
    .leftJoin(pausedByProfile, eq(pausedByProfile.userId, marketPauses.pausedBy))
    .leftJoin(endedByProfile, eq(endedByProfile.userId, marketPauses.endedBy))
    .where(eq(marketPauses.marketId, marketId))
    .orderBy(desc(marketPauses.pausedAt), desc(marketPauses.id));
  const history = pauses.map(({ pause, pausedByNickname, endedByNickname }): AdminMarketPause => ({
    id: pause.id,
    reason: pause.reason,
    note: pause.note,
    resultPublishedAt: pause.resultPublishedAt?.toISOString() ?? null,
    pausedAt: pause.pausedAt.toISOString(),
    pausedBy: pause.pausedBy === null ? null : actor(pause.pausedBy, pausedByNickname),
    reviewResult: pause.reviewResult,
    endKind: pause.endKind,
    endedAt: pause.endedAt?.toISOString() ?? null,
    endedBy: pause.endedBy === null ? null : actor(pause.endedBy, endedByNickname),
  }));

  const requests = await executor
    .select({
      id: approvalRequests.id,
      requestedBy: approvalRequests.requestedBy,
      requesterNickname: decisionRequester.nickname,
      requestReason: approvalRequests.requestReason,
      requestedAt: approvalRequests.requestedAt,
      status: approvalRequests.status,
      payload: approvalRequests.payload,
      decidedBy: approvalRequests.decidedBy,
      deciderNickname: decisionDecider.nickname,
      decidedAt: approvalRequests.decidedAt,
      decisionReason: approvalRequests.decisionReason,
      retractedAt: approvalRequests.retractedAt,
    })
    .from(approvalRequests)
    .leftJoin(decisionRequester, eq(decisionRequester.userId, approvalRequests.requestedBy))
    .leftJoin(decisionDecider, eq(decisionDecider.userId, approvalRequests.decidedBy))
    .where(pauseDecisionRequestsOf(marketId))
    .orderBy(desc(approvalRequests.requestedAt), desc(approvalRequests.id));
  const log = requests.map((row): MarketPauseDecisionLogEntry => {
    const payload = pauseDecisionPayloadOf(row);
    return {
      requestId: row.id,
      pauseId: payload.pauseId,
      path: payload.path,
      reviewResult: payload.reviewResult,
      reason: row.requestReason,
      requestedBy: actor(row.requestedBy, row.requesterNickname),
      requestedAt: row.requestedAt.toISOString(),
      status: row.status,
      decidedBy: row.decidedBy === null ? null : actor(row.decidedBy, row.deciderNickname),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionReason: row.decisionReason,
      retractedAt: row.retractedAt?.toISOString() ?? null,
    };
  });
  const pending = log.find((entry) => entry.status === 'pending');
  return {
    history,
    pending:
      pending === undefined
        ? null
        : {
            requestId: pending.requestId,
            pauseId: pending.pauseId,
            path: pending.path,
            reviewResult: pending.reviewResult,
            reason: pending.reason,
            requestedBy: pending.requestedBy,
            requestedAt: pending.requestedAt,
          },
    log,
  };
}

const queueRequester = alias(profiles, 'pause_queue_requester');

/**
 * `GET /admin/market-pause-decisions` (일시 중단 결정 대기, #114): every waiting
 * `market_pause_decision` request with its market and the reason of the pause it decides, in any
 * status — one still waiting at the close shows until its 반려 or 철회 — the oldest request first
 * over `(requested_at, id)` ascending, the order of `approval_requests_pending_requested_at_idx`
 * (migration 0042), with the request's keyset as the cursor (as the 규칙 보충 대기 queue).
 */
export async function listMarketPauseDecisions(
  db: Db,
  query: CursorQuery,
): Promise<Page<AdminMarketPauseDecisionItem>> {
  const { cursor, limit } = query;
  const keyset = decodeKeyset(cursor, 'uuid');
  const rows = await db
    .select({
      id: approvalRequests.id,
      requestedBy: approvalRequests.requestedBy,
      requesterNickname: queueRequester.nickname,
      requestedAt: approvalRequests.requestedAt,
      payload: approvalRequests.payload,
      marketId: markets.id,
      slug: markets.slug,
      title: markets.title,
      marketStatus: markets.status,
      closeAt: markets.closeAt,
      pauseReason: marketPauses.reason,
    })
    .from(approvalRequests)
    // `target_id` is text: the market's id is cast, never the target (another kind's target need
    // not be a uuid); so is the pause's against the payload's `pauseId`.
    .innerJoin(markets, eq(sql`${markets.id}::text`, approvalRequests.targetId))
    .innerJoin(
      marketPauses,
      eq(sql`${marketPauses.id}::text`, sql`${approvalRequests.payload} ->> 'pauseId'`),
    )
    .leftJoin(queueRequester, eq(queueRequester.userId, approvalRequests.requestedBy))
    .where(
      and(
        eq(approvalRequests.status, 'pending'),
        eq(approvalRequests.kind, MARKET_PAUSE_DECISION_APPROVAL_KIND),
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
    items: kept.map((row) => {
      const payload = pauseDecisionPayloadOf(row);
      return {
        requestId: row.id,
        marketId: row.marketId,
        slug: row.slug,
        title: row.title,
        status: row.marketStatus,
        closeAt: row.closeAt.toISOString(),
        pauseId: payload.pauseId,
        reason: row.pauseReason,
        path: payload.path,
        reviewResult: payload.reviewResult,
        requestedBy: actor(row.requestedBy, row.requesterNickname),
        requestedAt: row.requestedAt.toISOString(),
      };
    }),
    nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.requestedAt, id: last.id }) : null,
  };
}
