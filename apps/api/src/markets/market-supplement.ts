import { schema, type Db } from '@buddha/db';
import {
  MARKET_SUPPLEMENT_APPROVAL_KIND,
  MARKET_SUPPLEMENT_REJECT_REASONS,
  RULE_VERSION_ITEMS,
  SUPPLEMENT_ITEMS,
  decodeKeyset,
  encodeKeyset,
  marketSupplementRequestPayloadSchema,
  supplementItemsOf,
  type AdminAccountActor,
  type AdminMarketSupplement,
  type AdminMarketSupplementItem,
  type AdminRuleVersion,
  type ApprovalStatus,
  type CursorQuery,
  type MarketRuleContent,
  type MarketRuleVersion,
  type MarketSource,
  type MarketSupplementChanges,
  type MarketSupplementLogEntry,
  type MarketSupplementRejectReason,
  type MarketSupplementRequestPayload,
  type RuleVersionItem,
} from '@buddha/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { type Page } from '../wallet/wallet.service.js';
import { type Executor } from './market-item-rules.js';

/**
 * 규칙 버전과 보충 (#80, ADR-0101; ADR-0093 decision 2 #172 items 6·7·14·15, decision 3 '#80 보충의
 * 형태') as the screens read them: a market's rule versions — the public detail's history
 * (`Market.ruleVersions`) and the admin's, with who asked for and who made each — its
 * `market_supplement` requests (`AdminMarket.supplement`) and the 규칙 보충 대기 queue.
 * MarketSupplementService's writes read the requests here too, under the market lock.
 *
 * An account is named as every admin record names one (`AdminAccountActor`, as market-review.ts):
 * its id and its current nickname, read from `profiles` — null once its member closed it (#140).
 * The joins are LEFT, so a missing profile hides no row. The public read selects nobody at all.
 *
 * jsonb keeps no key order, so a version's text and a request's `changes` are given back in
 * RULE_VERSION_ITEMS and SUPPLEMENT_ITEMS order, each source as `{name, url}`.
 */

const { adminActions, approvalRequests, marketRuleVersions, markets, profiles } = schema;

/** An account as the admin screen names it (see the module doc). */
const actor = (id: string, nickname: string | null): AdminAccountActor => ({ id, nickname });

/** The `market_supplement` requests about `marketId` (target `market`, its id as text). */
function supplementRequestsOf(marketId: string) {
  return and(
    eq(approvalRequests.kind, MARKET_SUPPLEMENT_APPROVAL_KIND),
    eq(approvalRequests.targetType, 'market'),
    eq(approvalRequests.targetId, marketId),
  );
}

const isRuleVersionItem = (value: string): value is RuleVersionItem =>
  (RULE_VERSION_ITEMS as readonly string[]).includes(value);
const isRejectReason = (value: unknown): value is MarketSupplementRejectReason =>
  (MARKET_SUPPLEMENT_REJECT_REASONS as readonly unknown[]).includes(value);

const sourceOf = (source: MarketSource): MarketSource => ({ name: source.name, url: source.url });

/** A version's full text as stored (jsonb), in RULE_VERSION_ITEMS order. */
function orderedContent(content: MarketRuleContent): MarketRuleContent {
  return {
    title: content.title,
    description: content.description,
    yesCondition: content.yesCondition,
    noCondition: content.noCondition,
    eventDeadline: content.eventDeadline,
    primarySource: content.primarySource === null ? null : sourceOf(content.primarySource),
    fallbackSources: content.fallbackSources.map(sourceOf),
    fallbackCondition: content.fallbackCondition,
    longDelayDays: content.longDelayDays,
    delayHandling: content.delayHandling,
    scheduledOpenAt: content.scheduledOpenAt,
    closeAt: content.closeAt,
    scheduledAnnouncementAt: content.scheduledAnnouncementAt,
    scheduledJudgementAt: content.scheduledJudgementAt,
    judgementTimeZone: content.judgementTimeZone,
  };
}

/** A request's `changes` as stored (jsonb), in SUPPLEMENT_ITEMS order. */
function orderedChanges(changes: MarketSupplementChanges): MarketSupplementChanges {
  const source = (value: unknown) =>
    value !== null && typeof value === 'object' && 'name' in value
      ? sourceOf(value as MarketSource)
      : value;
  return Object.fromEntries(
    SUPPLEMENT_ITEMS.filter((item) => changes[item] !== undefined).map((item) => {
      const value = changes[item];
      return [item, Array.isArray(value) ? value.map(source) : source(value)];
    }),
  );
}

/** A supplement request as the writes and the detail read it. */
export interface SupplementRequest {
  id: string;
  requestedBy: string;
  requestReason: string;
  requestedAt: Date;
  status: ApprovalStatus;
  payload: Record<string, unknown> | null;
}

/**
 * A supplement request's payload (`approval_requests.payload`, frozen at the insert):
 * `{baseVersion, changes, settlementImpact}` as MarketSupplementService wrote it. Anything else is
 * a broken invariant — INTERNAL, never an answer.
 */
export function supplementPayloadOf(request: SupplementRequest): MarketSupplementRequestPayload {
  const parsed = marketSupplementRequestPayloadSchema.safeParse(request.payload);
  if (!parsed.success) {
    throw new AppError('INTERNAL', {
      message: `Supplement request ${request.id} has a malformed payload`,
      cause: parsed.error,
    });
  }
  return { ...parsed.data, changes: orderedChanges(parsed.data.changes) };
}

/**
 * The market's `market_supplement` request `requestId`, or null when the market has none by that
 * id — another market's, another kind's or no request at all.
 */
export async function supplementRequestOf(
  executor: Executor,
  marketId: string,
  requestId: string,
): Promise<SupplementRequest | null> {
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
    .where(and(supplementRequestsOf(marketId), eq(approvalRequests.id, requestId)))
    .limit(1);
  return row ?? null;
}

/**
 * Whether a `market_supplement` request of the market waits: read under the market lock, which
 * every supplement write holds, so at most one ever does (MarketSupplementService.request).
 */
export async function hasPendingSupplement(executor: Executor, marketId: string): Promise<boolean> {
  const [row] = await executor
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(and(supplementRequestsOf(marketId), eq(approvalRequests.status, 'pending')))
    .limit(1);
  return row !== undefined;
}

/** The columns every read of a version takes: the public fields. */
const publicVersionColumns = {
  version: marketRuleVersions.version,
  createdAt: marketRuleVersions.createdAt,
  changedItems: marketRuleVersions.changedItems,
  reason: marketRuleVersions.reason,
  content: marketRuleVersions.content,
};

function toPublicVersion(row: {
  version: number;
  createdAt: Date;
  changedItems: string[];
  reason: string | null;
  content: MarketRuleContent;
}): MarketRuleVersion {
  return {
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    changedItems: row.changedItems.filter(isRuleVersionItem),
    reason: row.reason,
    content: orderedContent(row.content),
  };
}

/**
 * `Market.ruleVersions` (#80): every rule version of the market, the newest (the current one)
 * first — its number, when it began, the items it changed, the reason and the full text — and
 * nobody's name nor the 정산 영향 검토 (#172 item 15, #173 item 13's analogue): the query selects
 * neither. Through `executor`, inside the public detail's snapshot. Empty for a market never opened
 * or opened before #80 (D4).
 */
export async function readPublicRuleVersions(
  executor: Executor,
  marketId: string,
): Promise<MarketRuleVersion[]> {
  const rows = await executor
    .select(publicVersionColumns)
    .from(marketRuleVersions)
    .where(eq(marketRuleVersions.marketId, marketId))
    .orderBy(desc(marketRuleVersions.version));
  return rows.map(toPublicVersion);
}

const versionRequester = alias(profiles, 'version_requester');
const versionCreator = alias(profiles, 'version_creator');

/**
 * `AdminMarket.ruleVersions` (#80): the public history with, for each version, its approval
 * request, who asked for it and who made it — the open's actor for v1 (null for the worker's job),
 * the approver after — and the 정산 영향 검토. One statement, newest first.
 */
export async function readAdminRuleVersions(
  executor: Executor,
  marketId: string,
): Promise<AdminRuleVersion[]> {
  const rows = await executor
    .select({
      ...publicVersionColumns,
      approvalId: marketRuleVersions.approvalId,
      requestedBy: marketRuleVersions.requestedBy,
      requesterNickname: versionRequester.nickname,
      createdBy: marketRuleVersions.createdBy,
      creatorNickname: versionCreator.nickname,
      settlementImpact: marketRuleVersions.settlementImpact,
    })
    .from(marketRuleVersions)
    .leftJoin(versionRequester, eq(versionRequester.userId, marketRuleVersions.requestedBy))
    .leftJoin(versionCreator, eq(versionCreator.userId, marketRuleVersions.createdBy))
    .where(eq(marketRuleVersions.marketId, marketId))
    .orderBy(desc(marketRuleVersions.version));
  return rows.map((row) => ({
    ...toPublicVersion(row),
    approvalId: row.approvalId,
    requestedBy: row.requestedBy === null ? null : actor(row.requestedBy, row.requesterNickname),
    createdBy: row.createdBy === null ? null : actor(row.createdBy, row.creatorNickname),
    settlementImpact: row.settlementImpact,
  }));
}

const supplementRequester = alias(profiles, 'supplement_requester');
const supplementDecider = alias(profiles, 'supplement_decider');
const supplementRejection = alias(adminActions, 'supplement_rejection');

/**
 * `AdminMarket.supplement` (#80, every status), through `executor` so a write answers with what it
 * wrote: every `market_supplement` request of the market, the newest first, with how it ended —
 * the decider, the decision's instant and reason, a 반려's reason from the list (its
 * `market_supplement_reject` record's) and the version an approval made (`versions`, the market's
 * as `readAdminRuleVersions` read them) — and the one waiting, if any. One statement.
 */
export async function readMarketSupplement(
  executor: Executor,
  marketId: string,
  versions: readonly AdminRuleVersion[],
): Promise<AdminMarketSupplement> {
  const rows = await executor
    .select({
      id: approvalRequests.id,
      requestedBy: approvalRequests.requestedBy,
      requesterNickname: supplementRequester.nickname,
      requestReason: approvalRequests.requestReason,
      requestedAt: approvalRequests.requestedAt,
      status: approvalRequests.status,
      payload: approvalRequests.payload,
      decidedBy: approvalRequests.decidedBy,
      deciderNickname: supplementDecider.nickname,
      decidedAt: approvalRequests.decidedAt,
      decisionReason: approvalRequests.decisionReason,
      retractedAt: approvalRequests.retractedAt,
      rejectReason: sql<string | null>`${supplementRejection.payload} ->> 'rejectReason'`,
    })
    .from(approvalRequests)
    .leftJoin(supplementRequester, eq(supplementRequester.userId, approvalRequests.requestedBy))
    .leftJoin(supplementDecider, eq(supplementDecider.userId, approvalRequests.decidedBy))
    .leftJoin(
      supplementRejection,
      and(
        eq(supplementRejection.type, 'market_supplement_reject'),
        eq(supplementRejection.targetType, 'market'),
        eq(supplementRejection.targetId, marketId),
        sql`${supplementRejection.payload} ->> 'approvalId' = ${approvalRequests.id}::text`,
      ),
    )
    .where(supplementRequestsOf(marketId))
    .orderBy(desc(approvalRequests.requestedAt), desc(approvalRequests.id));
  const versionOf = new Map(versions.map((version) => [version.approvalId, version.version]));
  const log = rows.map((row): MarketSupplementLogEntry => {
    const payload = supplementPayloadOf(row);
    return {
      requestId: row.id,
      requestedBy: actor(row.requestedBy, row.requesterNickname),
      requestedAt: row.requestedAt.toISOString(),
      baseVersion: payload.baseVersion,
      items: supplementItemsOf(payload.changes),
      changes: payload.changes,
      reason: row.requestReason,
      settlementImpact: payload.settlementImpact,
      status: row.status,
      decidedBy: row.decidedBy === null ? null : actor(row.decidedBy, row.deciderNickname),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionReason: row.decisionReason,
      rejectReason:
        row.status === 'rejected' && isRejectReason(row.rejectReason) ? row.rejectReason : null,
      retractedAt: row.retractedAt?.toISOString() ?? null,
      version: row.status === 'approved' ? (versionOf.get(row.id) ?? null) : null,
    };
  });
  const pending = log.find((entry) => entry.status === 'pending');
  return {
    pending:
      pending === undefined
        ? null
        : {
            requestId: pending.requestId,
            requestedBy: pending.requestedBy,
            requestedAt: pending.requestedAt,
            baseVersion: pending.baseVersion,
            items: pending.items,
            changes: pending.changes,
            reason: pending.reason,
            settlementImpact: pending.settlementImpact,
          },
    log,
  };
}

const queueRequester = alias(profiles, 'supplement_queue_requester');

/**
 * `GET /admin/market-supplements` (규칙 보충 대기, #80): every waiting `market_supplement` request
 * with its market, in any status — one still waiting at the close shows until its 반려 or 철회 —
 * the oldest request first over `(requested_at, id)` ascending, the order of
 * `approval_requests_pending_requested_at_idx` (migration 0042), with the request's keyset as the
 * cursor.
 */
export async function listMarketSupplements(
  db: Db,
  query: CursorQuery,
): Promise<Page<AdminMarketSupplementItem>> {
  const { cursor, limit } = query;
  const keyset = decodeKeyset(cursor, 'uuid');
  const rows = await db
    .select({
      id: approvalRequests.id,
      requestedBy: approvalRequests.requestedBy,
      requesterNickname: queueRequester.nickname,
      requestReason: approvalRequests.requestReason,
      requestedAt: approvalRequests.requestedAt,
      status: approvalRequests.status,
      payload: approvalRequests.payload,
      marketId: markets.id,
      slug: markets.slug,
      title: markets.title,
      marketStatus: markets.status,
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
        eq(approvalRequests.kind, MARKET_SUPPLEMENT_APPROVAL_KIND),
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
      const payload = supplementPayloadOf(row);
      return {
        requestId: row.id,
        marketId: row.marketId,
        slug: row.slug,
        title: row.title,
        status: row.marketStatus,
        closeAt: row.closeAt.toISOString(),
        requestedBy: actor(row.requestedBy, row.requesterNickname),
        requestedAt: row.requestedAt.toISOString(),
        baseVersion: payload.baseVersion,
        items: supplementItemsOf(payload.changes),
      };
    }),
    nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.requestedAt, id: last.id }) : null,
  };
}
