import { schema, type Db } from '@buddha/db';
import {
  MARKET_JUDGEMENT_APPROVAL_KIND,
  decodeKeyset,
  encodeKeyset,
  marketJudgementRequestPayloadSchema,
  type AdminAccountActor,
  type AdminMarketJudgement,
  type AdminMarketJudgementQueueItem,
  type AdminMarketJudgementState,
  type ApprovalStatus,
  type CursorQuery,
  type JudgementSource,
  type MarketJudgementLogEntry,
  type MarketJudgementRequestPayload,
  type MarketPauseEndKind,
  type MarketPauseReviewResult,
} from '@buddha/shared';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { type Page } from '../wallet/wallet.service.js';
import { type Executor } from './market-item-rules.js';
import { type MarketRow } from './market.service.js';

/**
 * 판정 등록과 별도 검토자 승인 (#152, ADR-0103) and 판정 정정 (#176, ADR-0105; market-judgement.ts
 * in @buddha/shared and @buddha/db) as the admin screens read it: a market's judgements
 * (`market_judgements`: the current one and the versions corrections replaced) and its
 * `market_judgement` registrations, a correction's among them (`AdminMarket.judgement`), and the
 * 판정 승인 대기 queue. MarketJudgementService's writes read the registrations, the rule's
 * sources, the last pause and a correction's accepted disputes here too, under the market lock.
 *
 * An account is named as every admin record names one (`AdminAccountActor`, as market-pause.ts):
 * its id and its current nickname, read from `profiles` — null once its member closed it (#140).
 * The joins are LEFT, so a missing profile hides no row. Nothing here is public: the public
 * judging record (#24) shows the source, the evidence, the collection instant and a VOID's reason,
 * never who registered or approved it (ADR-0093 decision 1 #173 item 13).
 */

const {
  approvalRequests,
  marketDisputes,
  marketJudgements,
  marketPauses,
  marketSources,
  markets,
  profiles,
} = schema;

/** An account as the admin screen names it (see the module doc). */
const actor = (id: string, nickname: string | null): AdminAccountActor => ({ id, nickname });

/** The `market_judgement` requests about `marketId` (target `market`, its id as text). */
function judgementRequestsOf(marketId: string) {
  return and(
    eq(approvalRequests.kind, MARKET_JUDGEMENT_APPROVAL_KIND),
    eq(approvalRequests.targetType, 'market'),
    eq(approvalRequests.targetId, marketId),
  );
}

/** A registration as the writes and the detail read it. */
export interface JudgementRequest {
  id: string;
  requestedBy: string;
  requestReason: string;
  requestedAt: Date;
  status: ApprovalStatus;
  payload: Record<string, unknown> | null;
}

/**
 * A registration's payload (`approval_requests.payload`, frozen at the insert): `{result, source,
 * fallbackReason, voidReason, evidence, ruleVersion, correction}` as MarketJudgementService wrote
 * it — `correction` null for a first judgement, and for a row written before #176, which has no
 * such key. Anything else is a broken invariant — INTERNAL, never an answer.
 */
export function judgementPayloadOf(
  request: Pick<JudgementRequest, 'id' | 'payload'>,
): MarketJudgementRequestPayload {
  const parsed = marketJudgementRequestPayloadSchema.safeParse(request.payload);
  if (!parsed.success) {
    throw new AppError('INTERNAL', {
      message: `Judgement request ${request.id} has a malformed payload`,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * The market's `market_judgement` request `requestId`, or null when the market has none by that
 * id — another market's, another kind's or no request at all.
 */
export async function judgementRequestOf(
  executor: Executor,
  marketId: string,
  requestId: string,
): Promise<JudgementRequest | null> {
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
    .where(and(judgementRequestsOf(marketId), eq(approvalRequests.id, requestId)))
    .limit(1);
  return row ?? null;
}

/**
 * Whether a registration of the market waits — a first judgement's or a correction's: read under
 * the market lock, which every judgement write holds, so at most one ever does
 * (MarketJudgementService.register).
 */
export async function hasPendingJudgement(executor: Executor, marketId: string): Promise<boolean> {
  const [row] = await executor
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(and(judgementRequestsOf(marketId), eq(approvalRequests.status, 'pending')))
    .limit(1);
  return row !== undefined;
}

/**
 * The ids of the market's disputes of judgement version `version` that are `accepted`, the oldest
 * submission first (`market_disputes`): what a 판정 정정 of that version answers (#176, its
 * payload's `correction.disputeIds`) — read under the market lock, which every dispute write
 * holds.
 */
export async function acceptedDisputeIdsOf(
  executor: Executor,
  marketId: string,
  version: number,
): Promise<string[]> {
  const rows = await executor
    .select({ id: marketDisputes.id })
    .from(marketDisputes)
    .where(
      and(
        eq(marketDisputes.marketId, marketId),
        eq(marketDisputes.judgementVersion, version),
        eq(marketDisputes.status, 'accepted'),
      ),
    )
    .orderBy(asc(marketDisputes.submittedAt), asc(marketDisputes.id));
  return rows.map((row) => row.id);
}

/**
 * The market's rule source at `priority` (`market_sources`: 0 the 1차 출처, 1..3 the 대체 출처,
 * ADR-0097) with its name and address as the registration copies them, or null when the rules
 * have none there. The rules are frozen once the market is CLOSED (ADR-0101: no supplement then),
 * so they are its rule version's sources too.
 */
export async function judgementSourceOf(
  executor: Executor,
  marketId: string,
  priority: number,
): Promise<JudgementSource | null> {
  const [row] = await executor
    .select({ name: marketSources.name, url: marketSources.url })
    .from(marketSources)
    .where(and(eq(marketSources.marketId, marketId), eq(marketSources.priority, priority)))
    .limit(1);
  return row ? { priority, name: row.name, url: row.url } : null;
}

/**
 * How the market's newest pause ended (`paused_at`, then `id`, as `readMarketPauses` of
 * @buddha/db and `AdminMarket.pause.history[0]`), or null for a market never paused: what
 * `judgementVoidOnly` reads — an early close reviewed 판정 불가 is judged VOID (ADR-0102).
 */
export async function lastMarketPause(
  executor: Executor,
  marketId: string,
): Promise<{
  endKind: MarketPauseEndKind | null;
  reviewResult: MarketPauseReviewResult | null;
} | null> {
  const [row] = await executor
    .select({ endKind: marketPauses.endKind, reviewResult: marketPauses.reviewResult })
    .from(marketPauses)
    .where(eq(marketPauses.marketId, marketId))
    .orderBy(desc(marketPauses.pausedAt), desc(marketPauses.id))
    .limit(1);
  return row ?? null;
}

/**
 * A judgement's stored source (`market_judgements`): null for none — a VOID's alone. The table's
 * CHECK holds the three columns all set or all null, so a half is a broken invariant.
 */
function storedSource(
  priority: number | null,
  name: string | null,
  url: string | null,
): JudgementSource | null {
  if (priority === null) return null;
  if (name === null || url === null) {
    throw new AppError('INTERNAL', { message: 'A judgement source lacks its name or address' });
  }
  return { priority, name, url };
}

const registrant = alias(profiles, 'judgement_registrant');
const approver = alias(profiles, 'judgement_approver');
const requester = alias(profiles, 'judgement_requester');
const decider = alias(profiles, 'judgement_decider');

/**
 * `AdminMarket.judgement` (#152, every status), through `executor` so a write answers with what it
 * wrote: the market's judgements, each with who registered and who approved it and its 정정 사유
 * (#176) — the current one, the `market_judgements` row `row.judgement_version` names (null before
 * an approval, and for a market the interim route judged before #152 (D4) or a factory wrote
 * PROVISIONAL with no row), and 판정 버전 이력, the versions before it a correction replaced, the
 * newest first, each as it was published (#173 item 13) — every `market_judgement` request of the
 * market, the newest first, with whether it is a correction (its `correction`) and how it ended
 * (the decider, the decision's instant and reason, the 철회's instant, the version an approval
 * made) and the one waiting, if any; and whether `market.dispute_window` is undecided, as the
 * caller read it in the same snapshot. One statement each.
 */
export async function readMarketJudgement(
  executor: Executor,
  row: Pick<MarketRow, 'id' | 'judgementVersion'>,
  disputeWindowUndecided: boolean,
): Promise<AdminMarketJudgementState> {
  const versions =
    row.judgementVersion === null
      ? []
      : await executor
          .select({
            judgement: marketJudgements,
            registrantNickname: registrant.nickname,
            approverNickname: approver.nickname,
          })
          .from(marketJudgements)
          .leftJoin(registrant, eq(registrant.userId, marketJudgements.registeredBy))
          .leftJoin(approver, eq(approver.userId, marketJudgements.approvedBy))
          .where(
            and(
              eq(marketJudgements.marketId, row.id),
              lte(marketJudgements.version, row.judgementVersion),
            ),
          )
          .orderBy(desc(marketJudgements.version));
  const judgements = versions.map(
    ({ judgement, registrantNickname, approverNickname }): AdminMarketJudgement => ({
      version: judgement.version,
      result: judgement.result,
      source: storedSource(judgement.sourcePriority, judgement.sourceName, judgement.sourceUrl),
      fallbackReason: judgement.fallbackReason,
      voidReason: judgement.voidReason,
      evidence: {
        links: judgement.evidenceLinks,
        collectedAt: judgement.collectedAt.toISOString(),
      },
      description: judgement.evidenceDescription,
      ruleVersion: judgement.ruleVersion,
      correctionReason: judgement.correctionReason,
      eventDeadlineConfirmed: judgement.eventDeadlineConfirmed,
      disputeWindowMinutes: judgement.disputeWindowMinutes,
      publishedAt: judgement.publishedAt.toISOString(),
      disputeDeadline: judgement.disputeDeadline.toISOString(),
      approvalId: judgement.approvalId,
      registeredBy: actor(judgement.registeredBy, registrantNickname),
      approvedBy: actor(judgement.approvedBy, approverNickname),
    }),
  );
  const current = judgements.find((judgement) => judgement.version === row.judgementVersion);

  const requests = await executor
    .select({
      id: approvalRequests.id,
      requestedBy: approvalRequests.requestedBy,
      requesterNickname: requester.nickname,
      requestReason: approvalRequests.requestReason,
      requestedAt: approvalRequests.requestedAt,
      status: approvalRequests.status,
      payload: approvalRequests.payload,
      decidedBy: approvalRequests.decidedBy,
      deciderNickname: decider.nickname,
      decidedAt: approvalRequests.decidedAt,
      decisionReason: approvalRequests.decisionReason,
      retractedAt: approvalRequests.retractedAt,
      version: marketJudgements.version,
    })
    .from(approvalRequests)
    .leftJoin(requester, eq(requester.userId, approvalRequests.requestedBy))
    .leftJoin(decider, eq(decider.userId, approvalRequests.decidedBy))
    // The judgement an approval made: `approval_id` is UNIQUE, so one at most.
    .leftJoin(marketJudgements, eq(marketJudgements.approvalId, approvalRequests.id))
    .where(judgementRequestsOf(row.id))
    .orderBy(desc(approvalRequests.requestedAt), desc(approvalRequests.id));
  const log = requests.map((request): MarketJudgementLogEntry => {
    const payload = judgementPayloadOf(request);
    return {
      requestId: request.id,
      result: payload.result,
      source: payload.source,
      fallbackReason: payload.fallbackReason,
      voidReason: payload.voidReason,
      evidence: payload.evidence,
      description: request.requestReason,
      ruleVersion: payload.ruleVersion,
      correction: payload.correction,
      requestedBy: actor(request.requestedBy, request.requesterNickname),
      requestedAt: request.requestedAt.toISOString(),
      status: request.status,
      decidedBy:
        request.decidedBy === null ? null : actor(request.decidedBy, request.deciderNickname),
      decidedAt: request.decidedAt?.toISOString() ?? null,
      decisionReason: request.decisionReason,
      retractedAt: request.retractedAt?.toISOString() ?? null,
      version: request.version,
    };
  });
  const pending = log.find((entry) => entry.status === 'pending');
  return {
    current: current ?? null,
    history: judgements.filter((judgement) => judgement !== current),
    pending:
      pending === undefined
        ? null
        : {
            requestId: pending.requestId,
            result: pending.result,
            source: pending.source,
            fallbackReason: pending.fallbackReason,
            voidReason: pending.voidReason,
            evidence: pending.evidence,
            description: pending.description,
            ruleVersion: pending.ruleVersion,
            correction: pending.correction,
            requestedBy: pending.requestedBy,
            requestedAt: pending.requestedAt,
          },
    log,
    disputeWindowUndecided,
  };
}

const queueRequester = alias(profiles, 'judgement_queue_requester');

/**
 * `GET /admin/market-judgements` (판정 승인 대기, #152): every waiting `market_judgement` request
 * with its market, its result and whether it is a 판정 정정 (its `correction`, #176), in any status
 * — one still waiting on a market that left the status it needs shows until its 반려 or 철회 —
 * the oldest request first over `(requested_at, id)` ascending, the
 * order of `approval_requests_pending_requested_at_idx` (migration 0042), with the request's keyset
 * as the cursor (as the 일시 중단 결정 대기 queue). The scheduled judgement (null before #22) lets
 * the queue say an approval would come before it.
 */
export async function listMarketJudgements(
  db: Db,
  query: CursorQuery,
): Promise<Page<AdminMarketJudgementQueueItem>> {
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
      scheduledJudgementAt: markets.scheduledJudgementAt,
    })
    .from(approvalRequests)
    // `target_id` is text: the market's id is cast, never the target (another kind's target need
    // not be a uuid).
    .innerJoin(markets, eq(sql`${markets.id}::text`, approvalRequests.targetId))
    .leftJoin(queueRequester, eq(queueRequester.userId, approvalRequests.requestedBy))
    .where(
      and(
        eq(approvalRequests.status, 'pending'),
        eq(approvalRequests.kind, MARKET_JUDGEMENT_APPROVAL_KIND),
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
      const { result, correction } = judgementPayloadOf(row);
      return {
        requestId: row.id,
        marketId: row.marketId,
        slug: row.slug,
        title: row.title,
        status: row.marketStatus,
        closeAt: row.closeAt.toISOString(),
        scheduledJudgementAt: row.scheduledJudgementAt?.toISOString() ?? null,
        result,
        correction,
        requestedBy: actor(row.requestedBy, row.requesterNickname),
        requestedAt: row.requestedAt.toISOString(),
      };
    }),
    nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.requestedAt, id: last.id }) : null,
  };
}
