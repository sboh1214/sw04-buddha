import {
  judgementIncidentPayloadOf,
  readMarketJudgementIncident,
  readMarketJudgementIncidentRequests,
  schema,
  type Db,
  type MarketJudgementIncidentRequestRead,
} from '@buddha/db';
import {
  JUDGEMENT_INCIDENT_CONFIRMABLE_STATUS,
  MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
  decodeKeyset,
  encodeKeyset,
  judgementIncidentStatusRefusal,
  type AdminAccountActor,
  type AdminMarketJudgementIncident,
  type AdminMarketJudgementIncidentQueueItem,
  type ApprovalStatus,
  type CursorQuery,
  type MarketJudgementIncidentLogEntry,
} from '@buddha/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { type Page } from '../wallet/wallet.service.js';
import { type Executor } from './market-item-rules.js';
import { type MarketRow } from './market.service.js';

/**
 * 판정 오류 사건 (#144 part 1, ADR-0165; market-judgement-incident.ts in @buddha/shared and
 * @buddha/db) as the admin screens read it: a market's `market_judgement_incident` registrations
 * and its confirmed incident (`AdminMarket.judgementIncident`), and the 판정 오류 사건 검토 대기
 * queue. MarketJudgementIncidentService's writes read a registration here too, under the market
 * lock. An account is named as every admin record names one (`AdminAccountActor`): its id and its
 * current nickname, null once its member closed it (#140). Nothing here is public: the public
 * judging record's 판정 정정 is `readMarketJudgingRecord`'s own allowlist (#24), never this.
 */

const { approvalRequests, markets, profiles } = schema;

/** An account as the admin screen names it (see the module doc). */
const actor = (id: string, nickname: string | null): AdminAccountActor => ({ id, nickname });

/** The `market_judgement_incident` requests about `marketId` (target `market`, its id as text). */
function incidentRequestsOf(marketId: string) {
  return and(
    eq(approvalRequests.kind, MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND),
    eq(approvalRequests.targetType, 'market'),
    eq(approvalRequests.targetId, marketId),
  );
}

/** A registration as the writes read it, its payload not yet parsed. */
export interface JudgementIncidentRequest {
  id: string;
  requestedBy: string;
  requestReason: string;
  requestedAt: Date;
  status: ApprovalStatus;
  payload: Record<string, unknown> | null;
}

/**
 * The market's `market_judgement_incident` request `requestId`, or null when the market has none
 * by that id — another market's, another kind's (a judgement's among them) or no request at all.
 */
export async function judgementIncidentRequestOf(
  executor: Executor,
  marketId: string,
  requestId: string,
): Promise<JudgementIncidentRequest | null> {
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
    .where(and(incidentRequestsOf(marketId), eq(approvalRequests.id, requestId)))
    .limit(1);
  return row ?? null;
}

/**
 * Whether an incident registration of the market waits: read under the market lock, which every
 * incident write holds, so at most one ever does (MarketJudgementIncidentService.register).
 */
export async function hasPendingJudgementIncident(
  executor: Executor,
  marketId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(and(incidentRequestsOf(marketId), eq(approvalRequests.status, 'pending')))
    .limit(1);
  return row !== undefined;
}

/**
 * A registration's payload, parsed (@buddha/db `judgementIncidentPayloadOf`); anything but the
 * frozen registration is a broken invariant — INTERNAL, never an answer.
 */
export function incidentPayloadOf(request: { id: string; payload: unknown }) {
  try {
    return judgementIncidentPayloadOf(request);
  } catch (error) {
    throw new AppError('INTERNAL', {
      message: `Judgement incident request ${request.id} has a malformed payload`,
      cause: error,
    });
  }
}

/** One registration of the log, as `MarketJudgementIncidentLogEntry`. */
function logEntryOf(request: MarketJudgementIncidentRequestRead): MarketJudgementIncidentLogEntry {
  return {
    requestId: request.id,
    correctedResult: request.payload.correctedResult,
    description: request.description,
    evidence: request.payload.evidence,
    requestedBy: actor(request.requestedBy, request.requestedByNickname),
    requestedAt: request.requestedAt.toISOString(),
    status: request.status,
    decidedBy:
      request.decidedBy === null ? null : actor(request.decidedBy, request.decidedByNickname),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    decisionReason: request.decisionReason,
    retractedAt: request.retractedAt?.toISOString() ?? null,
  };
}

/**
 * `AdminMarket.judgementIncident` (#144, every status), through `executor` so a write answers with
 * what it wrote and the detail with its REPEATABLE READ snapshot: every registration of the market
 * the newest first (`readMarketJudgementIncidentRequests`, one statement — the requester's and the
 * decider's nicknames among it) with the one waiting, the confirmed incident
 * (`readMarketJudgementIncident`, UNIQUE `market_id`) named by its request's requester and
 * decider with the reviewer's reason, and whether the market takes a registration (RESOLVED,
 * SETTLING or SETTLED, 144-8; a judgement version — not legacy, D4; no incident confirmed, 144-14,
 * or waiting) and a confirmation (SETTLED, 144-13) now.
 */
export async function readAdminMarketJudgementIncident(
  executor: Executor,
  row: Pick<MarketRow, 'id' | 'status' | 'judgementVersion'>,
): Promise<AdminMarketJudgementIncident> {
  const requests = await readMarketJudgementIncidentRequests(executor, row.id);
  const confirmedRow = await readMarketJudgementIncident(executor, row.id);
  const log = requests.map(logEntryOf);
  const pending = log.find((entry) => entry.status === 'pending');
  const approved =
    confirmedRow === null
      ? undefined
      : requests.find((request) => request.id === confirmedRow.approvalId);
  if (confirmedRow !== null && approved === undefined) {
    // The FK and migration 0080's trigger bind the row to its approved request of this market.
    throw new AppError('INTERNAL', {
      message: `Judgement incident ${confirmedRow.id} has no request of market ${row.id}`,
    });
  }
  return {
    registrable:
      judgementIncidentStatusRefusal(row.status, 'register') === null &&
      row.judgementVersion !== null &&
      confirmedRow === null &&
      pending === undefined,
    confirmable: row.status === JUDGEMENT_INCIDENT_CONFIRMABLE_STATUS,
    pending:
      pending === undefined
        ? null
        : {
            requestId: pending.requestId,
            correctedResult: pending.correctedResult,
            description: pending.description,
            evidence: pending.evidence,
            requestedBy: pending.requestedBy,
            requestedAt: pending.requestedAt,
          },
    confirmed:
      confirmedRow === null || approved === undefined
        ? null
        : {
            incidentId: confirmedRow.id,
            requestId: confirmedRow.approvalId,
            judgementVersion: confirmedRow.judgementVersion,
            originalResult: confirmedRow.originalResult,
            correctedResult: confirmedRow.correctedResult,
            description: confirmedRow.description,
            evidence: {
              links: confirmedRow.evidenceLinks,
              collectedAt: confirmedRow.evidenceCollectedAt.toISOString(),
            },
            registeredBy: actor(confirmedRow.registeredBy, approved.requestedByNickname),
            confirmedBy: actor(confirmedRow.confirmedBy, approved.decidedByNickname),
            registeredAt: confirmedRow.registeredAt.toISOString(),
            confirmedAt: confirmedRow.confirmedAt.toISOString(),
            reason: approved.decisionReason ?? '',
          },
    log,
  };
}

const queueRequester = alias(profiles, 'incident_queue_requester');

/**
 * `GET /admin/market-judgement-incidents` (판정 오류 사건 검토 대기, #144): every waiting
 * `market_judgement_incident` request with its market — its status (a confirmation waits for
 * SETTLED, 144-13; a dismissal is taken from RESOLVED on) — the paid result and the corrected one
 * as the registration froze them, and who registered it and when, the oldest request first over
 * `(requested_at, id)` ascending (`approval_requests_pending_requested_at_idx`, migration 0042),
 * with the request's keyset as the cursor (as the 판정 승인 대기 queue).
 */
export async function listMarketJudgementIncidents(
  db: Db,
  query: CursorQuery,
): Promise<Page<AdminMarketJudgementIncidentQueueItem>> {
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
    })
    .from(approvalRequests)
    // `target_id` is text: the market's id is cast, never the target (another kind's target need
    // not be a uuid).
    .innerJoin(markets, eq(sql`${markets.id}::text`, approvalRequests.targetId))
    .leftJoin(queueRequester, eq(queueRequester.userId, approvalRequests.requestedBy))
    .where(
      and(
        eq(approvalRequests.status, 'pending'),
        eq(approvalRequests.kind, MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND),
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
      const { originalResult, correctedResult } = incidentPayloadOf(row);
      return {
        requestId: row.id,
        marketId: row.marketId,
        slug: row.slug,
        title: row.title,
        status: row.marketStatus,
        originalResult,
        correctedResult,
        requestedBy: actor(row.requestedBy, row.requesterNickname),
        requestedAt: row.requestedAt.toISOString(),
      };
    }),
    nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.requestedAt, id: last.id }) : null,
  };
}
