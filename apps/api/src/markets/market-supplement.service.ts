import { Inject, Injectable } from '@nestjs/common';
import {
  allowRuleSupplement,
  insertRuleVersion,
  lockAdminRoles,
  ruleContentOf,
  schema,
  type Db,
} from '@buddha/db';
import {
  MARKET_SUPPLEMENT_APPROVAL_KIND,
  MARKET_SUPPLEMENT_REFUSALS,
  MARKET_SUPPLEMENT_STATUSES,
  PAUSED_SUPPLEMENT_ITEMS,
  SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED,
  changedRuleVersionItems,
  supplementChanges,
  supplementItemsOf,
  type AdminMarket,
  type AdminMarketSupplementItem,
  type ApproveMarketSupplementBody,
  type CursorQuery,
  type MarketRuleContent,
  type MarketRulesSupplementedPayload,
  type MarketSupplementChanges,
  type RejectMarketSupplementBody,
  type RequestMarketSupplementBody,
  type RuleVersionItem,
  type SupplementItem,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { ApprovalService, approvalNotAllowed } from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { type Page } from '../wallet/wallet.service.js';
import { MarketAdminService, decisionInstant, snapshot } from './market-admin.service.js';
import {
  assertFallbackCondition,
  assertFutureCloseAt,
  assertLeadClose,
  assertRulesKept,
  assertTimeOrder,
  fieldError,
  lockedMarketRow,
  ruleItemColumns,
  ruleItemsOfContent,
  sentTimeFields,
  timeColumns,
  timesOfContent,
  withContent,
  type Tx,
} from './market-item-rules.js';
import { lockMarket } from './market-lock.js';
import {
  hasPendingSupplement,
  listMarketSupplements,
  supplementPayloadOf,
  supplementRequestOf,
  type SupplementRequest,
} from './market-supplement.js';
import { readMarketSources, replaceMarketSources, sameSources } from './market-sources.js';
import { marketTagNames, type MarketRow } from './market.service.js';

/** The top-level message of each refusal MARKET_SUPPLEMENT_REFUSALS keys by its path. */
const REFUSAL_MESSAGES: Readonly<Record<keyof typeof MARKET_SUPPLEMENT_REFUSALS, string>> = {
  status: 'A supplement needs an open or paused market',
  closeAt: 'The market has closed: no supplement after the close',
  ruleVersion: 'The market has no rule version: it opened before rule versions',
  baseVersion: "The supplement was not written against the market's current rule version",
  supplement: 'Another supplement of the market is waiting for its decision',
  changes: 'The supplement changes no item of the current rule version',
};

/** VALIDATION_ERROR naming `path` with its MARKET_SUPPLEMENT_REFUSALS message. */
function refused(path: keyof typeof MARKET_SUPPLEMENT_REFUSALS): AppError {
  return fieldError(path, REFUSAL_MESSAGES[path], MARKET_SUPPLEMENT_REFUSALS[path]);
}

/**
 * What a supplement may be written on at `now` (#172 items 14·15), the request's and the
 * approval's first refusals in this order: OPEN or PAUSED (`status`), a rule version
 * (`ruleVersion`: a market opened before #80 has none, D4) and its close still ahead (`closeAt`
 * 'closed' — by the clock, since a market stays OPEN past its close until the worker closes it, and
 * a close extended then would bring it back to life: no supplement after the close).
 */
function assertSupplementable(row: MarketRow, now: Date): void {
  if (!(MARKET_SUPPLEMENT_STATUSES as readonly string[]).includes(row.status)) {
    throw refused('status');
  }
  if (row.ruleVersion === null) throw refused('ruleVersion');
  if (row.closeAt.getTime() <= now.getTime()) throw refused('closeAt');
}

/**
 * A PAUSED market's supplement that changes an item outside PAUSED_SUPPLEMENT_ITEMS (#172 item 14:
 * the close, today the only one): one issue per such item, on the item, in SUPPLEMENT_ITEMS order,
 * each SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED ('fixed while paused').
 */
function fixedWhilePaused(items: readonly SupplementItem[]): AppError {
  return new AppError('VALIDATION_ERROR', {
    message:
      items.length === 1 && items[0] === 'closeAt'
        ? 'The close cannot move while the market is paused'
        : `${items.join(', ')} cannot change while the market is paused`,
    details: items.map((item) => ({ path: [item], message: SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED })),
  });
}

/** A supplement's changes as checked: the text before and after, and what it changes. */
interface CheckedSupplement {
  before: MarketRuleContent;
  after: MarketRuleContent;
  /** The items whose value differs from the current one, each with its new value. */
  changes: MarketSupplementChanges;
  /** Those items, in SUPPLEMENT_ITEMS order. */
  items: SupplementItem[];
  /** The lead-close gap the check read from the setting, to store on a market that had none. */
  storeGap: number | null;
}

/**
 * 규칙 보충 (#80, ADR-0101; ADR-0093 decision 2 #172 items 14·15, decision 3 '#80 보충의 형태',
 * ADR-0098 A2; market-supplement.ts in @buddha/shared): after the open, an OPEN or PAUSED market's
 * rule version items — its title, rule items and the close, announcement and zone of its times —
 * change by a supplement one admin requests and another approves, never by the PATCH
 * (MarketAdminService.update). The two-person control is a `market_supplement` approval request
 * (#171, ApprovalService) on the market: the request opens it and changes nothing; the approval
 * writes the new text, the next rule version (`insertRuleVersion`, @buddha/db) and its one
 * `rules_supplemented` market event in the same transaction; a 반려 by another admin or the
 * requester's 철회 ends it, in any status, writing nothing but the record.
 *
 * Every write here is one transaction with its `admin_actions` row
 * (`market_supplement_request|approve|reject|retract`), under the class order of
 * MarketAdminService: the market lock (`lockMarket`), the market row FOR UPDATE, then the shared
 * admin-roles lock and the request row (ApprovalService). So a supplement serialises with the
 * worker's close and with another supplement write on the market — one request waits at a time,
 * and of two approvals of it at once the second finds it decided (APPROVAL_NOT_ALLOWED `decided`)
 * — and the instant each records is ApprovalService's for its step (the request's, the
 * decision's, the retraction's), read after every lock; the checks before it read the clock after
 * the same locks.
 *
 * The rules a supplement's changes are held to are the open market's the PATCH held until #80, with
 * the same messages (market-item-rules.ts), on the items that change (an item sent with its current
 * value is no change, and is neither checked nor kept): the close only later, in the future, at or
 * before the scheduled judgement (A2); while PAUSED, PAUSED_SUPPLEMENT_ITEMS alone (never the
 * close); the lead close checked again when the close or the announcement changes, at the gap the
 * market was last checked against or else the setting's (stored by the approval, ADR-0098 7-6);
 * RULES_REQUIRED for an item it would leave missing that was filled, the zone included; the switch
 * condition. The scheduled open and judgement are no supplement item (the body refuses them,
 * `marketSupplementChangesSchema`).
 *
 * A requester who loses the admin role while the request waits, as #139's (ADR-0085 7-3): the
 * request stays waiting, and another admin approves or rejects it — the two-person control looks
 * only at the decider, whether it is an admin when it decides (ADR-0056 decision 4) — while the
 * former admin cannot retract it (AdminGuard, and ApprovalService.retract's role check). The
 * request's `no_decider` check (`ApprovalService.hasDecider`) counts every admin but the requester,
 * one who has not finished the onboarding included, as #139's does: such an admin can be the only
 * decider counted, and the request then waits for them to finish it (OnboardedGuard refuses their
 * decision until then, ADR-0072), for an admin granted since, or for its requester's 철회.
 */
@Injectable()
export class MarketSupplementService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly markets: MarketAdminService,
    private readonly approvals: ApprovalService,
    private readonly jobs: MarketJobs,
  ) {}

  /**
   * 보충 요청 (#172 item 15): any admin, on an OPEN or PAUSED market with a rule version and its
   * close ahead, against its current version (`baseVersion`). Refused, in this order: `status`,
   * `ruleVersion` 'none', `closeAt` 'closed', `baseVersion` 'stale', `supplement` 'pending' (one
   * waits at a time, so a request never overwrites another), APPROVAL_NOT_ALLOWED `no_decider`
   * (no admin but the requester to decide it), `changes` 'unchanged', then the item rules
   * (`checkChanges`). Opens the `market_supplement` request — payload `{baseVersion, changes,
   * settlementImpact}` with only the items that change, the supplement's reason as its reason — and
   * writes `market_supplement_request`. No market event and nothing published: nothing changed yet.
   */
  async request(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<RequestMarketSupplementBody>,
  ): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      // The class's lock order: the admin roles after the market's rows. `no_decider` reads the
      // roles under it, as #139's requests do, and the request row is written after it.
      await lockAdminRoles(tx, 'shared');
      const now = await clockTimestamp(tx);
      assertSupplementable(current, now);
      if (body.baseVersion !== current.ruleVersion) throw refused('baseVersion');
      if (await hasPendingSupplement(tx, id)) throw refused('supplement');
      if (!(await this.approvals.hasDecider([adminId], tx))) {
        throw approvalNotAllowed('no_decider');
      }
      const sources = await readMarketSources(tx, id);
      const checked = await this.checkChanges(tx, current, ruleContentOf(current, sources), {
        changes: body.changes,
        now,
      });
      const request = await this.approvals.request(
        {
          kind: MARKET_SUPPLEMENT_APPROVAL_KIND,
          targetType: 'market',
          targetId: id,
          payload: {
            baseVersion: body.baseVersion,
            changes: checked.changes,
            settlementImpact: body.settlementImpact,
          },
          requestedBy: adminId,
          reason: body.reason,
        },
        tx,
      );
      // The request's instant, read after every lock (class doc): a close reached since `now` is
      // refused as one reached before, and the refusal rolls the request back.
      if (current.closeAt.getTime() <= request.requestedAt.getTime()) throw refused('closeAt');
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_supplement_request',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          baseVersion: body.baseVersion,
          items: checked.items,
          changes: checked.changes,
          reason: request.requestReason,
          settlementImpact: body.settlementImpact,
        },
        createdAt: request.requestedAt,
      });
      return this.markets.toAdminMarket(tx, current, await marketTagNames(tx, id), sources);
    });
  }

  /**
   * 승인 (#172 item 15): an admin other than the requester approves the market's waiting request
   * `requestId`. Refused: `requestId` 'unknown' (no supplement request of this market), then
   * APPROVAL_NOT_ALLOWED `retracted` or `decided` (no longer waiting) and `requester`; then, at the
   * decision, everything the request was checked against again, since the market or the setting
   * may have moved — `status`, `closeAt` 'closed' (a request waiting at the close ends by a 반려
   * or a 철회 alone), `baseVersion` 'stale', `changes` 'unchanged' and the item rules, among them a
   * market PAUSED since refusing each changed item outside PAUSED_SUPPLEMENT_ITEMS (the close) on
   * its own path, 'fixed while paused'.
   *
   * Then, with the guard opened for this market (`allowRuleSupplement`; migration 0053 refuses any
   * other write of a versioned market's rules): the changed columns and, when the sources change,
   * the `market_sources` rows (`replaceMarketSources`); `rule_version` one more, `updated_at` the
   * decision instant and, when the lead close was checked at the setting's gap, that gap; the
   * version (`insertRuleVersion`: the full text read back, the changed items, the reason and the
   * review, the request, its requester, the approver as its maker, at the decision instant); one
   * `rules_supplemented` event (the approver its actor, no status, payload
   * MarketRulesSupplementedPayload); and `market_supplement_approve` with the approver's reason and
   * the market before and after (`snapshot`). After COMMIT `market:status` with the status and key
   * unchanged, so a viewer refetches the new text and history (A-M4-36), and, when the close
   * moved, the delayed close job under the old instant cancelled and one under the new registered.
   */
  async approve(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<ApproveMarketSupplementBody>,
  ): Promise<AdminMarket> {
    const { market, closeMoved, at } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.decidable(tx, adminId, id, requestId);
      const now = await clockTimestamp(tx);
      const payload = supplementPayloadOf(request);
      assertSupplementable(current, now);
      if (payload.baseVersion !== current.ruleVersion) throw refused('baseVersion');
      const sources = await readMarketSources(tx, id);
      const checked = await this.checkChanges(tx, current, ruleContentOf(current, sources), {
        changes: payload.changes,
        now,
      });
      const decided = await this.approvals.approve(adminId, request.id, body.reason, tx);
      const at = decisionInstant(decided);
      // The decision's instant, after every lock: a close (or a new close) reached since `now` is
      // refused as one reached before, rolling the decision back.
      if (current.closeAt.getTime() <= at.getTime()) throw refused('closeAt');
      if (checked.changes.closeAt !== undefined) {
        assertFutureCloseAt(new Date(checked.after.closeAt), at);
      }

      const version = payload.baseVersion + 1;
      await allowRuleSupplement(tx, id);
      const [row] = await tx
        .update(schema.markets)
        .set({
          ...this.changedColumns(checked),
          ruleVersion: version,
          updatedAt: at,
          ...(checked.storeGap === null ? {} : { leadCloseGapMinutes: checked.storeGap }),
        })
        .where(eq(schema.markets.id, id))
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Market update failed' });
      const nextSources = {
        primarySource: checked.after.primarySource,
        fallbackSources: checked.after.fallbackSources,
      };
      if (!sameSources(nextSources, sources)) await replaceMarketSources(tx, id, nextSources);
      const made = await insertRuleVersion(tx, {
        marketId: id,
        version,
        createdAt: at,
        createdBy: adminId,
        supplement: {
          approvalId: request.id,
          requestedBy: request.requestedBy,
          reason: request.requestReason,
          settlementImpact: payload.settlementImpact,
        },
      });
      // insertRuleVersion keeps RULE_VERSION_ITEMS order and its CHECK their keys.
      const items = made.changedItems as RuleVersionItem[];
      await tx.insert(schema.marketEvents).values({
        marketId: id,
        type: 'rules_supplemented',
        actorId: adminId,
        payload: {
          version,
          approvalId: request.id,
          items,
          reason: request.requestReason,
          requestedBy: request.requestedBy,
        } satisfies MarketRulesSupplementedPayload,
        createdAt: at,
      });
      const tags = await marketTagNames(tx, id);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_supplement_approve',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          version,
          items,
          reason: decided.decisionReason,
          before: snapshot(current, tags, sources),
          after: snapshot(row, tags, nextSources),
        },
        createdAt: at,
      });
      return {
        market: await this.markets.toAdminMarket(tx, row, tags, nextSources),
        // The delayed close job is keyed by market AND instant (marketCloseJobId), so a moved
        // close is a cancel of the old registration plus a new one, never an edit.
        closeMoved:
          row.closeAt.getTime() === current.closeAt.getTime()
            ? undefined
            : { from: current.closeAt, to: row.closeAt },
        at,
      };
    });
    // Outside the transaction, as every market write publishes: a subscriber answers
    // `market:status` with a REFETCH, which must find the committed text. The job registrations go
    // out with it, each bounded on its own (MarketJobs).
    await Promise.all([
      this.markets.publishStatus(market),
      closeMoved ? this.jobs.cancelClose(market.id, closeMoved.from) : undefined,
      closeMoved ? this.jobs.scheduleClose(market.id, closeMoved.to, at) : undefined,
    ]);
    return market;
  }

  /**
   * 반려 (#172 item 15): an admin other than the requester ends the market's waiting request
   * `requestId` with one of MARKET_SUPPLEMENT_REJECT_REASONS and a reason — `meaning_change` when
   * the change would alter the market's meaning, which goes to the pause procedure (#173 items
   * 3·4, #114) — in any status, so a request still waiting at the close ends too. Refused as the
   * approval is up to its decision: `requestId` 'unknown', APPROVAL_NOT_ALLOWED `retracted`,
   * `decided` or `requester`. Writes `market_supplement_reject`; the market is unchanged, and
   * nothing is published.
   */
  async reject(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<RejectMarketSupplementBody>,
  ): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.decidable(tx, adminId, id, requestId);
      const decided = await this.approvals.reject(adminId, request.id, body.reason, tx);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_supplement_reject',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          rejectReason: body.rejectReason,
          reason: decided.decisionReason,
        },
        createdAt: decisionInstant(decided),
      });
      const sources = await readMarketSources(tx, id);
      return this.markets.toAdminMarket(tx, current, await marketTagNames(tx, id), sources);
    });
  }

  /**
   * 철회: the requester ends the market's waiting request `requestId` before anyone decides it, in
   * any status. Refused: `requestId` 'unknown', then ApprovalService's APPROVAL_NOT_ALLOWED
   * `not_requester`, `retracted` or `decided`. Writes `market_supplement_retract` at the
   * retraction's instant; nothing else changes, and nothing is published.
   */
  async retract(adminId: string, id: string, requestId: string): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.requestOf(tx, id, requestId);
      const retracted = await this.approvals.retract(adminId, request.id, tx);
      if (retracted.retractedAt === null) {
        throw new AppError('INTERNAL', { message: 'Approval retraction has no instant' });
      }
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_supplement_retract',
        targetType: 'market',
        targetId: id,
        payload: { approvalId: request.id },
        createdAt: retracted.retractedAt,
      });
      const sources = await readMarketSources(tx, id);
      return this.markets.toAdminMarket(tx, current, await marketTagNames(tx, id), sources);
    });
  }

  /** `GET /admin/market-supplements` (규칙 보충 대기): `listMarketSupplements`, the oldest first. */
  list(query: CursorQuery): Promise<Page<AdminMarketSupplementItem>> {
    return listMarketSupplements(this.db, query);
  }

  /**
   * The market's supplement request `requestId`, or VALIDATION_ERROR naming `requestId` 'unknown'
   * — another market's, another kind's or none (#78's refusal of a request id that is no request
   * of the market's review).
   */
  private async requestOf(tx: Tx, marketId: string, requestId: string) {
    const request = await supplementRequestOf(tx, marketId, requestId);
    if (!request) {
      throw fieldError('requestId', 'Not a supplement request of this market', 'unknown');
    }
    return request;
  }

  /**
   * The request a decision names (`requestOf`), still waiting and not the deciding admin's, under
   * the shared admin-roles lock the decision takes (the class's lock order, so the clock read
   * after it follows every lock): APPROVAL_NOT_ALLOWED `retracted` or `decided` for one no longer
   * waiting, then `requester` — as #78's decisions refuse a request no longer pending before its
   * exclusions. Every supplement write holds the market lock, so the status read is the one
   * ApprovalService then decides on.
   */
  private async decidable(
    tx: Tx,
    adminId: string,
    marketId: string,
    requestId: string,
  ): Promise<SupplementRequest> {
    const request = await this.requestOf(tx, marketId, requestId);
    await lockAdminRoles(tx, 'shared');
    if (request.status === 'retracted') throw approvalNotAllowed('retracted');
    if (request.status !== 'pending') throw approvalNotAllowed('decided');
    if (request.requestedBy === adminId) throw approvalNotAllowed('requester');
    return request;
  }

  /**
   * The item rules a supplement's `changes` are held to on `row` at `now` (class doc), against the
   * current text `before`: `changes` 'unchanged' when no item differs; then, on the items that
   * change, while PAUSED each one outside PAUSED_SUPPLEMENT_ITEMS (the close) on its own path,
   * 'fixed while paused' (`fixedWhilePaused`), a switch condition with no fallback
   * (`fallbackCondition`), RULES_REQUIRED, the close in the future and not earlier ('cannot move
   * earlier while open', an instant: an earlier close is an early close, #173 item 4), the order
   * (`assertTimeOrder`: A2 keeps the close at or before the scheduled judgement) and the lead close
   * (`assertLeadClose`) when the close or the announcement changes and the market has an
   * announcement — at the gap it was last checked against, else the setting's reading, which the
   * approval then stores.
   */
  private async checkChanges(
    tx: Tx,
    row: MarketRow,
    before: MarketRuleContent,
    { changes: sent, now }: { changes: MarketSupplementChanges; now: Date },
  ): Promise<CheckedSupplement> {
    const merged = withContent(before, sent);
    if (changedRuleVersionItems(before, merged).length === 0) throw refused('changes');
    // Only what differs: an item sent with its current value is no change.
    const changes = supplementChanges(before, merged);
    const after = withContent(before, changes);
    const items = supplementItemsOf(changes);
    if (row.status === 'paused') {
      const fixed = items.filter((item) => !PAUSED_SUPPLEMENT_ITEMS.includes(item));
      if (fixed.length > 0) throw fixedWhilePaused(fixed);
    }
    if (changes.fallbackSources !== undefined || changes.fallbackCondition !== undefined) {
      assertFallbackCondition(ruleItemsOfContent(after));
    }
    assertRulesKept(before, after);
    if (changes.closeAt !== undefined) {
      const closeAt = new Date(after.closeAt);
      assertFutureCloseAt(closeAt, now);
      if (closeAt.getTime() < row.closeAt.getTime()) {
        throw fieldError(
          'closeAt',
          'The close time cannot move earlier while the market is open: close it instead',
          'cannot move earlier while open',
        );
      }
    }
    const sentFields = sentTimeFields(changes);
    const ruled = { ...timesOfContent(after), eventDeadline: after.eventDeadline };
    assertTimeOrder(ruled, sentFields);
    let storeGap: number | null = null;
    if (
      after.scheduledAnnouncementAt !== null &&
      (sentFields.has('closeAt') || sentFields.has('scheduledAnnouncementAt'))
    ) {
      // The gap the market's lead close was last checked against (the submission stores it, and
      // the open keeps it); a market that has none — submitted while the setting was undecided,
      // or opened before #22 — takes the reading now, and its approval keeps it from then on.
      const gap = row.leadCloseGapMinutes ?? (await this.markets.leadCloseGapSetting(tx));
      assertLeadClose(ruled, gap, sentFields);
      if (row.leadCloseGapMinutes === null) storeGap = gap;
    }
    return { before, after, changes, items, storeGap };
  }

  /** The `markets` columns of the items a supplement changes (sources are rows of their own). */
  private changedColumns(checked: CheckedSupplement): Partial<typeof schema.markets.$inferInsert> {
    const { changes, after } = checked;
    const rules = ruleItemColumns(ruleItemsOfContent(after));
    const times = timeColumns(timesOfContent(after));
    const set: Partial<typeof schema.markets.$inferInsert> = {};
    if (changes.title !== undefined) set.title = after.title;
    if (changes.description !== undefined) set.description = rules.description;
    if (changes.yesCondition !== undefined) set.yesCondition = rules.yesCondition;
    if (changes.noCondition !== undefined) set.noCondition = rules.noCondition;
    if (changes.eventDeadline !== undefined) set.eventDeadline = rules.eventDeadline;
    if (changes.fallbackCondition !== undefined) set.fallbackCondition = rules.fallbackCondition;
    if (changes.longDelayDays !== undefined) set.longDelayDays = rules.longDelayDays;
    if (changes.delayHandling !== undefined) set.delayHandling = rules.delayHandling;
    if (changes.closeAt !== undefined) set.closeAt = times.closeAt;
    if (changes.scheduledAnnouncementAt !== undefined) {
      set.scheduledAnnouncementAt = times.scheduledAnnouncementAt;
    }
    if (changes.judgementTimeZone !== undefined) set.judgementTimeZone = times.judgementTimeZone;
    return set;
  }
}
