import { ledgerHeldMarketSql, schema } from '@buddha/db';
import {
  marketDisputeStatusSchema,
  withCurrentJudgementDelay,
  type MarketJudgingRecord,
  type PublicDisputeDecision,
  type PublicMarketDisputes,
} from '@buddha/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from './market-item-rules.js';
import type { MarketRow } from './market.service.js';

const {
  marketJudgements,
  marketPauses,
  marketJudgementDelays,
  marketDisputes,
  adminActions,
  marketEvents,
  marketSettlementSteps,
  markets,
} = schema;

/** Only the allowed facts are selected. Call inside the same snapshot/market lock as the detail. */
export async function readMarketJudgingRecord(
  reader: Executor,
  market: Pick<MarketRow, 'id' | 'status' | 'judgementVersion'>,
): Promise<MarketJudgingRecord> {
  const versions = await reader
    .select({
      version: marketJudgements.version,
      result: marketJudgements.result,
      sourcePriority: marketJudgements.sourcePriority,
      sourceName: marketJudgements.sourceName,
      sourceUrl: marketJudgements.sourceUrl,
      fallbackReason: marketJudgements.fallbackReason,
      voidReason: marketJudgements.voidReason,
      links: marketJudgements.evidenceLinks,
      description: marketJudgements.evidenceDescription,
      collectedAt: marketJudgements.collectedAt,
      ruleVersion: marketJudgements.ruleVersion,
      publishedAt: marketJudgements.publishedAt,
      disputeDeadline: marketJudgements.disputeDeadline,
      correctionReason: marketJudgements.correctionReason,
    })
    .from(marketJudgements)
    .where(eq(marketJudgements.marketId, market.id))
    .orderBy(desc(marketJudgements.version));
  const pauses = await reader
    .select({
      reason: marketPauses.reason,
      // Legacy notes were entered under an admin-only promise. Only the matching immutable
      // pause event can prove that this note was written for publication; never select the
      // private text into the application when that provenance is absent or malformed.
      note: sql<string | null>`CASE WHEN ${marketEvents.payload}->'notePublic' = 'true'::jsonb
        THEN ${marketPauses.note} ELSE NULL END`,
      resultPublishedAt: marketPauses.resultPublishedAt,
      pausedAt: marketPauses.pausedAt,
      reviewResult: marketPauses.reviewResult,
      endKind: marketPauses.endKind,
      endedAt: marketPauses.endedAt,
    })
    .from(marketPauses)
    .leftJoin(
      marketEvents,
      and(
        eq(marketEvents.id, marketPauses.pauseEventId),
        eq(marketEvents.marketId, marketPauses.marketId),
        eq(marketEvents.type, 'paused'),
        sql`${marketEvents.payload}->>'pauseId' = ${marketPauses.id}::text`,
      ),
    )
    .where(eq(marketPauses.marketId, market.id))
    .orderBy(desc(marketPauses.pausedAt), desc(marketPauses.pauseEventId));
  const delays = await reader
    .select({
      reason: marketJudgementDelays.reason,
      nextReviewAt: marketJudgementDelays.nextReviewAt,
      marketStatus: marketJudgementDelays.marketStatus,
      judgementVersion: marketJudgementDelays.judgementVersion,
    })
    .from(marketJudgementDelays)
    .where(eq(marketJudgementDelays.marketId, market.id))
    .orderBy(desc(marketJudgementDelays.eventId));
  const disputes = await readDisputes(reader, market.id);
  const [cancelled] =
    market.status === 'cancelled'
      ? await reader
          .select({
            reason: sql<unknown>`${marketEvents.payload}->'reason'`,
            cancelledAt: marketEvents.createdAt,
          })
          .from(marketEvents)
          .where(and(eq(marketEvents.marketId, market.id), eq(marketEvents.type, 'cancelled')))
          .orderBy(desc(marketEvents.id))
          .limit(1)
      : [];
  const [payout] =
    market.status === 'settling'
      ? await reader
          .select({
            delayed: sql<boolean>`(${ledgerHeldMarketSql(sql`${market.id}`)} OR EXISTS (SELECT 1 FROM ${marketSettlementSteps}
      WHERE ${marketSettlementSteps.marketId}=${market.id}
        AND (${marketSettlementSteps.status}='failed' OR ${marketSettlementSteps.lastError} IS NOT NULL)))`,
          })
          .from(markets)
          .where(eq(markets.id, market.id))
          .limit(1)
      : [];
  return {
    versions: versions.map((row) => ({
      version: row.version,
      result: row.result,
      source:
        row.sourcePriority === null || row.sourceName === null || row.sourceUrl === null
          ? null
          : { priority: row.sourcePriority, name: row.sourceName, url: row.sourceUrl },
      fallbackReason: row.fallbackReason,
      voidReason: row.voidReason,
      evidence: { links: row.links, collectedAt: row.collectedAt.toISOString() },
      description: row.description,
      ruleVersion: row.ruleVersion,
      publishedAt: row.publishedAt.toISOString(),
      disputeDeadline: row.disputeDeadline.toISOString(),
      correctionReason: row.correctionReason,
    })),
    pauses: pauses.map((row) => ({
      reason: row.reason,
      note: row.note,
      resultPublishedAt: row.resultPublishedAt?.toISOString() ?? null,
      pausedAt: row.pausedAt.toISOString(),
      reviewResult: row.reviewResult,
      endKind: row.endKind,
      endedAt: row.endedAt?.toISOString() ?? null,
    })),
    delays: withCurrentJudgementDelay(delays, {
      status: market.status,
      judgementVersion: market.judgementVersion,
    }).map((row) => ({
      reason: row.reason,
      nextReviewAt: row.nextReviewAt.toISOString(),
      current: row.current,
    })),
    disputes,
    cancellation:
      cancelled && typeof cancelled.reason === 'string'
        ? { reason: cancelled.reason, cancelledAt: cancelled.cancelledAt.toISOString() }
        : null,
    payoutDelayed: payout?.delayed ?? false,
  };
}

/**
 * Counts describe current states, including older versions. Decision history is separate: a
 * correction's rejection/retraction clears the current acceptance, but not the public reason.
 * Internal ids join/validate records and deduplicate the legacy fallback; none leave this reader.
 */
async function readDisputes(reader: Executor, marketId: string): Promise<PublicMarketDisputes> {
  const rows = await reader
    .select({
      id: marketDisputes.id,
      judgementVersion: marketDisputes.judgementVersion,
      status: marketDisputes.status,
      reason: marketDisputes.decisionReason,
      decidedAt: marketDisputes.decidedAt,
    })
    .from(marketDisputes)
    .where(eq(marketDisputes.marketId, marketId));
  const actions = await reader
    .select({
      id: adminActions.id,
      disputeId: marketDisputes.id,
      judgementVersion: marketDisputes.judgementVersion,
      type: adminActions.type,
      reason: sql<unknown>`${adminActions.payload}->'reason'`,
      at: adminActions.createdAt,
    })
    .from(adminActions)
    .innerJoin(
      marketDisputes,
      and(
        eq(marketDisputes.marketId, marketId),
        sql`${adminActions.payload}->>'disputeId' = ${marketDisputes.id}::text`,
        sql`${adminActions.payload}->>'judgementVersion' = ${marketDisputes.judgementVersion}::text`,
      ),
    )
    .where(
      and(
        eq(adminActions.targetType, 'market'),
        eq(adminActions.targetId, marketId),
        inArray(adminActions.type, ['market_dispute_accept', 'market_dispute_dismiss']),
      ),
    )
    .orderBy(desc(adminActions.createdAt), desc(adminActions.id));
  const byVersion = new Map<number, PublicMarketDisputes['byVersion'][number]>();
  const decisions: { id: string; at: number; value: PublicDisputeDecision }[] = [];
  const recorded = new Set<string>();
  const decisionKey = (id: string, decision: string, reason: string, at: Date) =>
    JSON.stringify([id, decision, reason, at.toISOString()]);
  for (const action of actions) {
    if (typeof action.reason !== 'string' || action.reason.trim() === '') continue;
    const decision = action.type === 'market_dispute_accept' ? 'accepted' : 'dismissed';
    recorded.add(decisionKey(action.disputeId, decision, action.reason, action.at));
    decisions.push({
      id: action.id,
      at: action.at.getTime(),
      value: {
        judgementVersion: action.judgementVersion,
        decision,
        reason: action.reason,
      },
    });
  }
  for (const row of rows) {
    const status = marketDisputeStatusSchema.parse(row.status);
    let summary = byVersion.get(row.judgementVersion);
    if (!summary) {
      summary = {
        judgementVersion: row.judgementVersion,
        total: 0,
        counts: { pending: 0, dismissed: 0, accepted: 0, retracted: 0, closed_by_correction: 0 },
      };
      byVersion.set(row.judgementVersion, summary);
    }
    summary.total++;
    summary.counts[status]++;
    if (
      (status === 'accepted' || status === 'dismissed') &&
      row.reason !== null &&
      row.decidedAt !== null &&
      !recorded.has(decisionKey(row.id, status, row.reason, row.decidedAt))
    ) {
      decisions.push({
        id: row.id,
        at: row.decidedAt.getTime(),
        value: {
          judgementVersion: row.judgementVersion,
          decision: status,
          reason: row.reason,
        },
      });
    }
  }
  return {
    total: rows.length,
    byVersion: [...byVersion.values()].sort((a, b) => b.judgementVersion - a.judgementVersion),
    decisions: decisions
      .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
      .map((row) => row.value),
  };
}
