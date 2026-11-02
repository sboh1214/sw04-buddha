import {
  MARKET_JUDGEMENT_APPROVAL_KIND,
  SETTLEMENT_STEPS,
  disputeDeadlineOf,
  disputeWindowMinutesSchema,
  isBeforeScheduledJudgement,
  marketJudgementRequestPayloadSchema,
  type MarketProvisionalPayload,
  type MarketResolvedByDeadlinePayload,
  type MarketResult,
} from '@buddha/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { transitionMarket } from './market-transitions.js';
import type * as schema from './schema/index.js';
import {
  type approvalRequests,
  marketJudgements,
  marketSettlementSteps,
  markets,
} from './schema/index.js';

type MarketRow = typeof markets.$inferSelect;

/** A judgement (#152): a row of `market_judgements`. */
export type MarketJudgementRow = typeof marketJudgements.$inferSelect;

/** A transaction handle of either app, as `transitionMarket` takes it, that also reads back. */
type Executor = Pick<NodePgDatabase<typeof schema>, 'insert' | 'update' | 'select'>;

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;

/*
 * 판정 (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·5·9, decision 3 the #152 rows): the one
 * place each edge of the judgement is taken, as the open is `openScheduledMarket`'s and the pause
 * `pauseMarket`'s — `approveMarketJudgement` (CLOSED → PROVISIONAL, an admin other than the
 * registrant approving a `market_judgement` request; the API's) and `resolveProvisionalMarket`
 * (PROVISIONAL → RESOLVED once the dispute deadline has passed with nothing held; the worker's
 * `market.resolve`, and #175's 'all dismissed → confirm at once'). Each is called under
 * `lockMarket`, with `now` the DB clock read after the last lock, in the caller's transaction;
 * each writes no admin action (the API's) and publishes nothing (the caller publishes
 * `market:status` after COMMIT). The registration, its 반려 and its 철회 change no market and live
 * in the API alone (`approval_requests`).
 */

/**
 * Why `approveMarketJudgement` left a market as it was: `not_closed` — it is not CLOSED (not
 * closed yet, or PROVISIONAL since another approval; MARKET_JUDGEMENT_REFUSALS `status` 'not
 * closed').
 */
export type JudgementPublishSkipReason = 'not_closed';

export interface ApproveMarketJudgementInput {
  /** The market row the caller read `FOR UPDATE` after `lockMarket`, in the same transaction. */
  market: Pick<
    MarketRow,
    'id' | 'status' | 'ruleVersion' | 'judgementVersion' | 'scheduledJudgementAt'
  >;
  /**
   * The `market_judgement` request being approved (pending or already approved in this
   * transaction): its payload (`marketJudgementRequestPayloadSchema`) is the registration, its
   * reason the description, its requester the registrant.
   */
  request: Pick<
    typeof approvalRequests.$inferSelect,
    'id' | 'kind' | 'targetType' | 'targetId' | 'payload' | 'requestedBy' | 'requestReason'
  >;
  /** The DB clock read after the locks: what is judged, the publication's instant. */
  now: Date;
  /** The approving admin — never the registrant (throws) — the event's actor. */
  approverId: string;
  /**
   * Whether the approver confirmed the NO condition's event deadline (decision 3 '등록 시점').
   * Required true before the market's scheduled judgement — the API refuses it first
   * (`eventDeadlineConfirmed` 'required'), so false then throws here — and kept either way.
   */
  eventDeadlineConfirmed: boolean;
  /** The release setting `market.dispute_window` as the approval read it, minutes (1..10,080). */
  disputeWindowMinutes: number;
}

export type ApproveMarketJudgementResult =
  | {
      published: true;
      /** The market row read back: `provisional`, its result, version, deadline and event. */
      market: MarketRow;
      /** The judgement the approval made, the market's current one. */
      judgement: MarketJudgementRow;
      /** The `provisional` event's id, the market's `status_event_id`. */
      eventId: number;
    }
  | { published: false; reason: JudgementPublishSkipReason };

/**
 * CLOSED → PROVISIONAL (#152; ADR-0093 decision 1 #173 items 1·5·9 — '별도 검토자가 판정을 승인할
 * 때'), in the approval's transaction: it publishes a CLOSED market's judgement and fixes its
 * dispute deadline; a market not CLOSED is left as it was (`not_closed`). VOID goes the same way
 * (#173 item 9). Refused at the API first, so a caller's bug here, each throws before anything is
 * written: a request of another kind or market, an approval by its registrant (decision 3 '역할'),
 * a payload the shared schema refuses, a window out of range, a rule version that moved since the
 * registration (nothing moves it after the close: ADR-0101 takes no supplement then — C5), and an
 * approval before the scheduled judgement without the event deadline confirmed.
 *
 * `transitionMarket`'s `provisional` event — from `closed`, to `provisional`, the approver, payload
 * `{version, result, approvalId, requestedBy, disputeDeadline}` (MarketProvisionalPayload) at
 * `now` — with the market's `resolved_result` the result (ADR-0095 8-2, 8-7), `judgement_version`
 * the next version (1 for the first: only approved judgements are numbered) and `dispute_deadline`
 * `now` plus the window, exactly (#173 item 5: fixed now, never moved by a later change of the
 * setting). Then the `market_judgements` row: the registration as the request froze it, the
 * description its reason, the confirmation (false at or after the scheduled judgement, where none
 * is asked, whatever the caller sent), the window, `now` as `published_at`, the deadline, the
 * request, the registrant, the approver and the event. `resolved_at` stays null: it is the
 * confirmation's (ADR-0095 결과 5). The caller registers `market.resolve` at the deadline after
 * COMMIT (`marketResolveJobId`).
 */
export async function approveMarketJudgement(
  tx: Executor,
  input: ApproveMarketJudgementInput,
): Promise<ApproveMarketJudgementResult> {
  const { market, request, now, approverId, eventDeadlineConfirmed, disputeWindowMinutes } = input;
  if (
    request.kind !== MARKET_JUDGEMENT_APPROVAL_KIND ||
    request.targetType !== 'market' ||
    request.targetId !== market.id
  ) {
    throw new Error(`Request ${request.id} is no judgement of market ${market.id}`);
  }
  if (approverId === request.requestedBy) {
    throw new Error('A judgement is approved by an admin other than its registrant');
  }
  const registration = marketJudgementRequestPayloadSchema.parse(request.payload);
  if (!disputeWindowMinutesSchema.safeParse(disputeWindowMinutes).success) {
    throw new Error(`A dispute window of ${String(disputeWindowMinutes)} minutes is out of range`);
  }
  if (market.status !== 'closed') return { published: false, reason: 'not_closed' };
  if (registration.ruleVersion !== market.ruleVersion) {
    throw new Error(
      `Market ${market.id} is at rule version ${String(market.ruleVersion)}, its judgement ` +
        `followed ${String(registration.ruleVersion)}`,
    );
  }
  const early = isBeforeScheduledJudgement(market.scheduledJudgementAt, now.getTime());
  if (early && !eventDeadlineConfirmed) {
    throw new Error('A judgement approved before its scheduled time confirms the event deadline');
  }

  const version = (market.judgementVersion ?? 0) + 1;
  const disputeDeadline = disputeDeadlineOf(now, disputeWindowMinutes);
  const payload: MarketProvisionalPayload = {
    version,
    result: registration.result,
    approvalId: request.id,
    requestedBy: request.requestedBy,
    disputeDeadline: disputeDeadline.toISOString(),
  };
  const eventId = await transitionMarket(tx, {
    marketId: market.id,
    from: 'closed',
    to: 'provisional',
    type: 'provisional',
    actorId: approverId,
    payload: { ...payload },
    at: now,
    set: { resolvedResult: registration.result, judgementVersion: version, disputeDeadline },
  });
  const { source } = registration;
  const [judgement] = await tx
    .insert(marketJudgements)
    .values({
      marketId: market.id,
      version,
      result: registration.result,
      sourcePriority: source?.priority ?? null,
      sourceName: source?.name ?? null,
      sourceUrl: source?.url ?? null,
      fallbackReason: registration.fallbackReason,
      voidReason: registration.voidReason,
      evidenceLinks: registration.evidence.links,
      evidenceDescription: request.requestReason,
      collectedAt: new Date(registration.evidence.collectedAt),
      ruleVersion: registration.ruleVersion,
      // Only a confirmation that was asked for: after the scheduled judgement nothing is.
      eventDeadlineConfirmed: early && eventDeadlineConfirmed,
      disputeWindowMinutes,
      publishedAt: now,
      disputeDeadline,
      approvalId: request.id,
      registeredBy: request.requestedBy,
      approvedBy: approverId,
      provisionalEventId: eventId,
      createdAt: now,
    })
    .returning();
  if (!judgement) throw new Error('market_judgements insert returned no row');
  const [row] = await tx.select().from(markets).where(eq(markets.id, market.id));
  if (!row) throw new Error(`Market ${market.id} was judged but could not be read back`);
  return { published: true, market: row, judgement, eventId };
}

/**
 * Why `resolveProvisionalMarket` left a market as it was, in the order it is judged:
 * - `not_found`: no market has the id (a job left from before a whole-database wipe);
 * - `not_provisional`: it is not PROVISIONAL — confirmed already (a duplicate job, the scan after
 *   the delayed job), or not published yet;
 * - `not_due`: its dispute deadline is still ahead (a stale job, or a deadline a correction moved
 *   later, #176).
 * #175's undecided disputes and #176's pending correction add `held` (#173 item 1).
 */
export type ResolveSkipReason = 'not_found' | 'not_provisional' | 'not_due';

export interface ResolveProvisionalMarketInput {
  marketId: string;
  /** The DB clock read after `lockMarket`: what is judged, the confirmation's instant. */
  now: Date;
}

export type ResolveProvisionalMarketResult =
  | {
      resolved: true;
      /** The market row read back: `resolved`, `resolved_at` `now`, its event's id. */
      market: MarketRow;
      /** The `resolved` event's id, the market's `status_event_id`. */
      eventId: number;
      /** The judgement version confirmed (`markets.judgement_version`) and its result. */
      version: number;
      result: MarketResult;
    }
  | { resolved: false; reason: ResolveSkipReason };

/**
 * PROVISIONAL → RESOLVED (#152; ADR-0093 decision 1 #173 item 1, an automatic edge: actor NULL,
 * the worker): the confirmation of a published result once its dispute deadline has passed with
 * nothing held. Called under `lockMarket`; it reads the market `FOR UPDATE` itself and confirms one
 * that is PROVISIONAL and whose `dispute_deadline` is at or before `now`, checked in that order
 * (ResolveSkipReason); otherwise it writes nothing and says why. The holds come here: #175's
 * undecided disputes and #176's pending correction each add a predicate and the skip `held`, and
 * #175 calls this as soon as the last dispute is dismissed, past the deadline or not — so the
 * worker's per-minute scan, not only the delayed job, confirms a market whose hold cleared later.
 * #152 has none.
 *
 * `transitionMarket`'s `resolved` event — from `provisional`, to `resolved`, no actor, payload
 * `{version, result, source: 'deadline'}` (MarketResolvedByDeadlinePayload: the judgement version
 * confirmed, `markets.judgement_version`, and its result) at `now` — with `resolved_at` `now` (the
 * 확정 시각 theme results read, ADR-0095 결과 5), then one `pending` `market_settlement_steps` row
 * per SETTLEMENT_STEPS step, so the step table never lags the status (ADR-0046 D5; the API's
 * interim judgement wrote them before #152). A VOID is confirmed too; its payout fails loudly in
 * SETTLING until #126 (ADR-0095 8-5). The caller registers `market.finalize` after COMMIT
 * (`marketFinalizeJobId(marketId, now)`): RESOLVED → SETTLING is the finalize's own transaction.
 */
export async function resolveProvisionalMarket(
  tx: Executor,
  { marketId, now }: ResolveProvisionalMarketInput,
): Promise<ResolveProvisionalMarketResult> {
  const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
  if (!market) return { resolved: false, reason: 'not_found' };
  if (market.status !== 'provisional') return { resolved: false, reason: 'not_provisional' };
  const { disputeDeadline, judgementVersion, resolvedResult } = market;
  // markets_provisional_check holds all three on a PROVISIONAL market.
  if (disputeDeadline === null || judgementVersion === null || resolvedResult === null) {
    throw new Error(`Market ${marketId} is provisional without its judgement`);
  }
  if (disputeDeadline.getTime() > now.getTime()) return { resolved: false, reason: 'not_due' };

  const payload: MarketResolvedByDeadlinePayload = {
    version: judgementVersion,
    result: resolvedResult,
    source: 'deadline',
  };
  const eventId = await transitionMarket(tx, {
    marketId,
    from: 'provisional',
    to: 'resolved',
    type: 'resolved',
    actorId: null,
    payload: { ...payload },
    at: now,
    set: { resolvedAt: now },
  });
  // A PROVISIONAL market has never been confirmed, so no step row exists yet: a plain insert, and
  // the primary key (market_id, step) turns any surprise into a rollback, not a duplicate.
  await tx.insert(marketSettlementSteps).values(
    SETTLEMENT_STEPS.map((step) => ({
      marketId,
      step,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })),
  );
  const [row] = await tx.select().from(markets).where(eq(markets.id, marketId));
  if (!row) throw new Error(`Market ${marketId} was confirmed but could not be read back`);
  return {
    resolved: true,
    market: row,
    eventId,
    version: judgementVersion,
    result: resolvedResult,
  };
}

/**
 * Every judgement of a market, the newest version first: the admin detail's record, and #24's
 * public one (without the two accounts). Empty until one is approved, and for a market judged by
 * the interim route before #152 (D4).
 */
export async function readMarketJudgements(
  executor: Reader,
  marketId: string,
): Promise<MarketJudgementRow[]> {
  return executor
    .select()
    .from(marketJudgements)
    .where(eq(marketJudgements.marketId, marketId))
    .orderBy(desc(marketJudgements.version));
}

/**
 * The market's current judgement — the one `markets.judgement_version` names — or null when it
 * has none (not judged yet, or judged by the interim route before #152).
 */
export async function currentMarketJudgement(
  executor: Reader,
  marketId: string,
): Promise<MarketJudgementRow | null> {
  const [row] = await executor
    .select({ judgement: marketJudgements })
    .from(marketJudgements)
    .innerJoin(
      markets,
      and(
        eq(markets.id, marketJudgements.marketId),
        eq(markets.judgementVersion, marketJudgements.version),
      ),
    )
    .where(eq(marketJudgements.marketId, marketId))
    .limit(1);
  return row?.judgement ?? null;
}
