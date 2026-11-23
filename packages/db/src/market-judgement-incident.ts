import {
  MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
  marketJudgementIncidentRequestPayloadSchema,
  type ApprovalStatus,
  type MarketJudgementIncidentRequestPayload,
  type MarketResult,
} from '@buddha/shared';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { assertNoMarketConflict } from './market-conflicts.js';
import type * as schema from './schema/index.js';
import { approvalRequests, marketJudgementIncidents, markets, profiles } from './schema/index.js';

/*
 * 판정 오류 사건 (#144 part 1, ADR-0165; @buddha/shared market-judgement-incident.ts): the one
 * writer of `market_judgement_incidents` (`recordMarketJudgementIncident`, the API's 오류 확인 in
 * the approving transaction), its readers, and `effectiveResultSql` — the result every reader that
 * shows "the result" takes (144-5), the corrected one when an incident is confirmed, else the paid
 * one. The market row, its judgements and its settlement records are never written here
 * (ADR-0165 decision 2). Nothing here publishes or writes an admin action (the API's).
 */

/** A transaction handle of either app that writes and reads back. */
type Executor = Pick<NodePgDatabase<typeof schema>, 'insert' | 'select'>;

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;

/** A confirmed 판정 오류 사건: a row of `market_judgement_incidents`. */
export type MarketJudgementIncidentRow = typeof marketJudgementIncidents.$inferSelect;

/**
 * The result a reader shows for a market (144-5): `coalesce(incident.corrected_result,
 * market.resolved_result)` — the confirmed incident's corrected result, else the paid one (null
 * before a judgement). `market` is `markets` or an alias of it; `incident` is
 * `market_judgement_incidents` (or an alias) LEFT JOINed on its `market_id`, which is UNIQUE, so
 * the join never multiplies a market's row. One fragment for every reader — the theme results,
 * the related markets and any later one — so they cannot drift. The two column names differ, so
 * the fragment reads the same where a SELECT projection drops the qualifiers.
 */
export function effectiveResultSql(
  market: { resolvedResult: AnyPgColumn } = markets,
  incident: { correctedResult: AnyPgColumn } = marketJudgementIncidents,
): SQL<MarketResult | null> {
  return sql<MarketResult | null>`coalesce(${incident.correctedResult}, ${market.resolvedResult})`;
}

/**
 * The market's confirmed incident (UNIQUE `market_id`, 144-14), or null when it has none. The
 * admin detail reads every column; the public judging record maps an allowlist of them (#24).
 */
export async function readMarketJudgementIncident(
  reader: Reader,
  marketId: string,
): Promise<MarketJudgementIncidentRow | null> {
  const [row] = await reader
    .select()
    .from(marketJudgementIncidents)
    .where(eq(marketJudgementIncidents.marketId, marketId))
    .limit(1);
  return row ?? null;
}

/**
 * An incident's registration as its request froze it: the request's columns, its payload parsed
 * (`marketJudgementIncidentRequestPayloadSchema`), and its requester's and decider's current
 * nicknames (null once the member closed the account — #140; LEFT joins, so a missing profile
 * hides no row).
 */
export interface MarketJudgementIncidentRequestRead {
  id: string;
  status: ApprovalStatus;
  payload: MarketJudgementIncidentRequestPayload;
  /** 오류 내용: the request's reason. */
  description: string;
  requestedBy: string;
  requestedByNickname: string | null;
  requestedAt: Date;
  decidedBy: string | null;
  decidedByNickname: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  retractedAt: Date | null;
}

/**
 * A request's payload, parsed. Anything but the frozen registration is a broken invariant: the
 * API writes it whole and migration 0021 freezes it.
 */
export function judgementIncidentPayloadOf(request: {
  id: string;
  payload: unknown;
}): MarketJudgementIncidentRequestPayload {
  const parsed = marketJudgementIncidentRequestPayloadSchema.safeParse(request.payload);
  if (!parsed.success) {
    throw new Error(`Judgement incident request ${request.id} has a malformed payload`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Every `market_judgement_incident` request of a market, the newest first — pending, approved
 * (오류 확인), rejected (기각) or retracted: the admin detail's waiting incident and its log. The
 * index `approval_requests_target_idx` serves the market's requests.
 */
export async function readMarketJudgementIncidentRequests(
  reader: Reader,
  marketId: string,
): Promise<MarketJudgementIncidentRequestRead[]> {
  const requester = alias(profiles, 'requester');
  const decider = alias(profiles, 'decider');
  const rows = await reader
    .select({
      id: approvalRequests.id,
      status: approvalRequests.status,
      payload: approvalRequests.payload,
      description: approvalRequests.requestReason,
      requestedBy: approvalRequests.requestedBy,
      requestedByNickname: requester.nickname,
      requestedAt: approvalRequests.requestedAt,
      decidedBy: approvalRequests.decidedBy,
      decidedByNickname: decider.nickname,
      decidedAt: approvalRequests.decidedAt,
      decisionReason: approvalRequests.decisionReason,
      retractedAt: approvalRequests.retractedAt,
    })
    .from(approvalRequests)
    .leftJoin(requester, eq(requester.userId, approvalRequests.requestedBy))
    .leftJoin(decider, eq(decider.userId, approvalRequests.decidedBy))
    .where(
      and(
        eq(approvalRequests.kind, MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND),
        eq(approvalRequests.targetType, 'market'),
        eq(approvalRequests.targetId, marketId),
      ),
    )
    .orderBy(desc(approvalRequests.requestedAt), desc(approvalRequests.id));
  return rows.map((row) => ({ ...row, payload: judgementIncidentPayloadOf(row) }));
}

export interface RecordMarketJudgementIncidentInput {
  /** The market the request is about (its target). */
  marketId: string;
  /**
   * The `market_judgement_incident` request as `ApprovalService.approve` left it in this
   * transaction: approved, its decider and decision instant set — the incident's confirmer and
   * `confirmed_at` (one instant per decision, ADR-0165).
   */
  request: Pick<
    typeof approvalRequests.$inferSelect,
    | 'id'
    | 'kind'
    | 'status'
    | 'payload'
    | 'requestReason'
    | 'requestedBy'
    | 'requestedAt'
    | 'decidedBy'
    | 'decidedAt'
  >;
  /**
   * The paid judgement version's registrant (`market_judgements.registered_by` at the market's
   * `judgement_version`), whom 144-4 bars from the confirmation — the caller has refused them
   * (`judgementIncidentDecisionRefusal`); the CHECK and migration 0080's trigger hold it again.
   */
  paidRegisteredBy: string;
}

/**
 * 오류 확인's permanent record (144-3, 144-13): writes the market's `market_judgement_incidents`
 * row from its approved request — the frozen payload's version, results and evidence, the
 * request's reason as the description, its requester and instant, its decider and decision
 * instant, the paid version's registrant, and this transaction's id. Called under `lockMarket`
 * with the market row FOR UPDATE, after `approvals.approve` in the same transaction (the deferred
 * `approval_requests_incident_record` needs the row by COMMIT). The approver and the registrant
 * are checked for a conflict on the market again (#143, ADR-0120 decision 5, as
 * `approveMarketJudgement` does — MarketConflictError). Migration 0080's trigger refuses a market
 * that is not SETTLED, a version or result that is not the market's, a request that does not
 * match; the UNIQUE `market_id` a second incident (144-14).
 */
export async function recordMarketJudgementIncident(
  tx: Executor,
  input: RecordMarketJudgementIncidentInput,
): Promise<MarketJudgementIncidentRow> {
  const { marketId, request, paidRegisteredBy } = input;
  if (
    request.kind !== MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND ||
    request.status !== 'approved' ||
    request.decidedBy === null ||
    request.decidedAt === null
  ) {
    throw new Error(`Request ${request.id} is no approved judgement incident`);
  }
  await assertNoMarketConflict(tx, marketId, [request.decidedBy, request.requestedBy]);
  const payload = judgementIncidentPayloadOf(request);
  const [row] = await tx
    .insert(marketJudgementIncidents)
    .values({
      marketId,
      appliedTxid: sql`pg_current_xact_id()::text`,
      judgementVersion: payload.judgementVersion,
      originalResult: payload.originalResult,
      correctedResult: payload.correctedResult,
      description: request.requestReason,
      evidenceLinks: payload.evidence.links,
      evidenceCollectedAt: new Date(payload.evidence.collectedAt),
      approvalId: request.id,
      registeredBy: request.requestedBy,
      paidRegisteredBy,
      confirmedBy: request.decidedBy,
      registeredAt: request.requestedAt,
      confirmedAt: request.decidedAt,
    })
    .returning();
  if (!row) throw new Error('market_judgement_incidents insert returned no row');
  return row;
}
