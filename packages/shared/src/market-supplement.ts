import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { approvalReasonSchema } from './approvals.js';
import { INT4_MAX } from './constants.js';
import { type MarketStatus, approvalStatusSchema, marketStatusSchema } from './enums.js';
import {
  type ExpectedAccountBody,
  expectedAccountBodySchema,
  expectedAccountIdSchema,
} from './expected-account.js';
import { marketTitleSchema, ruleItemFields, timeItemFields } from './market-fields.js';
import {
  RULE_ITEMS,
  changedRuleItems,
  marketRuleItemsSchema,
  storableInstantSchema,
} from './market-rules.js';
import { TIME_ITEMS, changedTimeItems, marketTimesSchema } from './market-times.js';

/**
 * 규칙 버전과 개장 뒤 보충 (#80, ADR-0101; ADR-0093 decision 2 #172 items 6·7·14·15, decision 3
 * '#80 보충의 형태', ADR-0098 A2):
 *
 * - 규칙 v1: the open (`openScheduledMarket`, packages/db — the worker's, an approval's or a
 *   reschedule's) records the content locked at the review as version 1 (`market_rule_versions`)
 *   in its own transaction, and the market's current version (`markets.rule_version`) becomes 1.
 *   The `opened` event is its record; v1 writes no event of its own. A market opened before #80
 *   has no version (D4, no backfill) and takes no supplement.
 * - A version is the full text of RULE_VERSION_ITEMS — the title, the rule items and the time
 *   items (`marketRuleContentSchema`); the category, the tags, the image, the slug and the bot's
 *   settings are outside it (#172 item 7). The judgement and the settlement follow the last
 *   version there is at the judgement; no fill records one.
 * - 보충 요청 (`POST /admin/markets/:id/supplements`, OPEN or PAUSED with its close ahead): any
 *   admin writes the new text of the items to change (`changes`, SUPPLEMENT_ITEMS), the reason and
 *   the 정산 영향 검토, against the current version (`baseVersion`). It opens a `market_supplement`
 *   approval request (#171, approvals.ts) and changes nothing yet; one waits per market at a time.
 * - 승인 (`…/supplements/:requestId/approve`): an admin other than the requester, the market still
 *   OPEN or PAUSED, its close ahead and its version the request's, every item rule checked again.
 *   The market takes the new text, a new version (`baseVersion` + 1) records the full text with the
 *   changed items and the reason, and one `rules_supplemented` market event is written: the public
 *   detail's history shows it from then on (`Market.ruleVersions`).
 * - 반려 (`…/reject`: one of MARKET_SUPPLEMENT_REJECT_REASONS and a reason) by an admin other than
 *   the requester, and 철회 (`…/retract`) by the requester alone, in any status — a request still
 *   waiting at the close ends only so. An approver who reads a change of meaning rejects it
 *   (`meaning_change`): the 반려 changes nothing, and the admin screen then offers the pause of an
 *   OPEN market for `basis_change` (#114, ADR-0102; market-pause.ts).
 *
 * The request, the approval, the 반려 and the 철회 each write an `admin_actions` row
 * (`market_supplement_request` … `market_supplement_retract`, enums.ts); the approval alone writes
 * a market event. The public reads each version's text, changed items, reason and time — never who
 * asked for or approved it, nor the 정산 영향 검토 (ADR-0093 decision 1 #173 item 13's analogue).
 */

/** `approval_requests.kind` of a supplement (#171: lower-case words joined by `_`), on a market. */
export const MARKET_SUPPLEMENT_APPROVAL_KIND = 'market_supplement';

// ---- items ----------------------------------------------------------------------------
/**
 * What a rule version holds (#172 item 7, ADR-0097 '버전 = RULE_ITEMS + 제목 + #22의 시각'), in the
 * admin form's order: the title, the rule items (`RULE_ITEMS`, #23) and the time items
 * (`TIME_ITEMS`, #22). The list spans market-rules.ts and market-times.ts, as `RULES_EDITED_ITEMS`
 * does (market-edits.ts), whose items are a part of it.
 */
export const RULE_VERSION_ITEMS = ['title', ...RULE_ITEMS, ...TIME_ITEMS] as const;
export type RuleVersionItem = (typeof RULE_VERSION_ITEMS)[number];
export const ruleVersionItemSchema = z.enum(RULE_VERSION_ITEMS).meta({ id: 'RuleVersionItem' });

/**
 * The version items fixed at the open (#172 item 14): no supplement moves the scheduled open (it
 * has passed) or the scheduled judgement (never).
 */
export const FIXED_AFTER_OPEN_ITEMS = [
  'scheduledOpenAt',
  'scheduledJudgementAt',
] as const satisfies readonly RuleVersionItem[];

/**
 * What a supplement may change (#172 item 14): every version item but FIXED_AFTER_OPEN_ITEMS, in
 * RULE_VERSION_ITEMS order. The close only later, in the future, at or before the scheduled
 * judgement (ADR-0098 A2) with the lead close checked again, and never while PAUSED
 * (PAUSED_SUPPLEMENT_ITEMS). The announcement and the judgement time zone are in it (ADR-0098
 * result 5 left them to #80): the approver judges whether a change of either changes the meaning.
 */
export const SUPPLEMENT_ITEMS = [
  'title',
  ...RULE_ITEMS,
  'closeAt',
  'scheduledAnnouncementAt',
  'judgementTimeZone',
] as const satisfies readonly RuleVersionItem[];
export type SupplementItem = (typeof SUPPLEMENT_ITEMS)[number];
export const supplementItemSchema = z.enum(SUPPLEMENT_ITEMS).meta({ id: 'SupplementItem' });

/**
 * What a supplement may change while PAUSED: SUPPLEMENT_ITEMS but the close (#172 item 14). The
 * request and the approval (MarketSupplementService, apps/api) refuse every changed item outside it
 * on its own path, SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED.
 */
export const PAUSED_SUPPLEMENT_ITEMS: readonly SupplementItem[] = SUPPLEMENT_ITEMS.filter(
  (item) => item !== 'closeAt',
);

/**
 * The statuses a supplement is requested and approved in (#172 item 14: 거래 중 and 거래 일시 중단,
 * the close still ahead — no supplement after the close, #172 item 15). Its 반려 and 철회 take
 * any status.
 */
export const MARKET_SUPPLEMENT_STATUSES = [
  'open',
  'paused',
] as const satisfies readonly MarketStatus[];
export type MarketSupplementStatus = (typeof MARKET_SUPPLEMENT_STATUSES)[number];

/** A rule version's number: 1 for the open's, then one more per approved supplement (int4). */
export const ruleVersionNumberSchema = z.number().int().min(1).max(INT4_MAX);

// ---- the full text --------------------------------------------------------------------
const { scheduledOpenAt, scheduledAnnouncementAt, scheduledJudgementAt, judgementTimeZone } =
  marketTimesSchema.shape;

/**
 * A version's full text (`market_rule_versions.content`, jsonb; decision 3 '#80 보충의 형태'): every
 * RULE_VERSION_ITEMS item, in that order, as the market carries it (`Market`) — the rule items as
 * `marketRuleItemsSchema` (the sources as `{name, url}`, priority order), the instants as ISO, the
 * zone by name. Blank items stay blank: a market may open with an item the open-items check would
 * name (the open checks nothing again, #21), and its v1 keeps it so.
 */
export const marketRuleContentSchema = z
  .object({
    title: z.string(),
    ...marketRuleItemsSchema.shape,
    scheduledOpenAt,
    closeAt: storableInstantSchema,
    scheduledAnnouncementAt,
    scheduledJudgementAt,
    judgementTimeZone,
  })
  .meta({ id: 'MarketRuleContent' });
export type MarketRuleContent = z.infer<typeof marketRuleContentSchema>;

/**
 * The version items whose value differs between two full texts, in RULE_VERSION_ITEMS order: the
 * title by its trimmed text, the rule items as `changedRuleItems` compares them and the times as
 * `changedTimeItems` does (an instant by its moment, the zone by its name). A version's
 * `changedItems` against the one before it.
 */
export function changedRuleVersionItems(
  before: MarketRuleContent,
  after: MarketRuleContent,
): RuleVersionItem[] {
  return [
    ...(before.title.trim() === after.title.trim() ? [] : (['title'] as const)),
    ...changedRuleItems(before, after),
    ...changedTimeItems(before, after),
  ];
}

// ---- the request ----------------------------------------------------------------------
/** The refusal of a `changes` that names no item, on `changes`. */
export const SUPPLEMENT_CHANGES_REQUIRED = 'at least one item is required';

/**
 * The refusal of a key of `changes` that is no SUPPLEMENT_ITEMS item — the scheduled open or
 * judgement, the category, the tags… — on `changes`, followed by the keys.
 */
export const SUPPLEMENT_ITEMS_ONLY = 'not a supplement item';

/** The fields of SUPPLEMENT_ITEMS, each as the update body takes it (market-fields.ts). */
const supplementFields = {
  title: marketTitleSchema,
  ...ruleItemFields,
  closeAt: timeItemFields.closeAt,
  scheduledAnnouncementAt: timeItemFields.scheduledAnnouncementAt,
  judgementTimeZone: timeItemFields.judgementTimeZone,
} satisfies { readonly [K in SupplementItem]: z.ZodType };

/**
 * A supplement's 보충 문구 (#172 item 15): the new value of each item to change, in the update
 * body's field shapes (`updateMarketBodySchema`, #23, #22) — a text trimmed, null clearing a
 * nullable one, the fallbacks as their whole ordered list. Only SUPPLEMENT_ITEMS, and at least one;
 * an item left out keeps the current version's value. The service checks every changed item as the
 * open market's rules hold it (the close later, the lead close, RULES_REQUIRED, …).
 */
export const marketSupplementChangesSchema = z
  .strictObject(supplementFields, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `${SUPPLEMENT_ITEMS_ONLY}: ${issue.keys.join(', ')}`
        : undefined,
  })
  .partial()
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
    message: SUPPLEMENT_CHANGES_REQUIRED,
    // A key that is no item, or a value refused, is the one issue: it named something.
    when: (payload) => payload.issues.length === 0,
  })
  .meta({ id: 'MarketSupplementChanges' });
export type MarketSupplementChanges = z.infer<typeof marketSupplementChangesSchema>;

/** The items `changes` names, in SUPPLEMENT_ITEMS order. */
export function supplementItemsOf(changes: MarketSupplementChanges): SupplementItem[] {
  return SUPPLEMENT_ITEMS.filter((item) => changes[item] !== undefined);
}

function applyItem<K extends SupplementItem>(
  content: MarketRuleContent,
  changes: MarketSupplementChanges,
  item: K,
): void {
  const value = changes[item];
  if (value !== undefined) content[item] = value as MarketRuleContent[K];
}

/** The full text `content` becomes with `changes`: each item it names takes its new value. */
export function applySupplementChanges(
  content: MarketRuleContent,
  changes: MarketSupplementChanges,
): MarketRuleContent {
  const after = { ...content };
  for (const item of SUPPLEMENT_ITEMS) applyItem(after, changes, item);
  return after;
}

/**
 * The `changes` that take `before` to `after`: the SUPPLEMENT_ITEMS items whose value differs
 * (`changedRuleVersionItems`), each with its value in `after` — an item sent with the value it has
 * already is no change, so a request can keep only what it changes.
 */
export function supplementChanges(
  before: MarketRuleContent,
  after: MarketRuleContent,
): MarketSupplementChanges {
  const changed = new Set<RuleVersionItem>(changedRuleVersionItems(before, after));
  return Object.fromEntries(
    SUPPLEMENT_ITEMS.filter((item) => changed.has(item)).map((item) => [item, after[item]]),
  );
}

/**
 * 반려 사유 of a supplement: `meaning_change` — the change alters the market's meaning, which no
 * supplement may (#172 item 15: the approver rejects it and the market goes to the pause procedure,
 * #173 items 3·4 — a one-admin pause for `basis_change` the admin screen offers after the 반려,
 * #114) — or `other`, with the reason saying what.
 */
export const MARKET_SUPPLEMENT_REJECT_REASONS = ['meaning_change', 'other'] as const;
export type MarketSupplementRejectReason = (typeof MARKET_SUPPLEMENT_REJECT_REASONS)[number];
export const marketSupplementRejectReasonSchema = z
  .enum(MARKET_SUPPLEMENT_REJECT_REASONS)
  .meta({ id: 'MarketSupplementRejectReason' });

/**
 * The refusal details of a supplement request or approval that no item rule makes (the API's code),
 * each message keyed by the path it names:
 * - `status`: the market is neither OPEN nor PAUSED (MARKET_SUPPLEMENT_STATUSES);
 * - `closeAt`: its close has come — by the clock too, since a market stays OPEN past its close
 *   until the worker closes it: no supplement after the close (#172 item 15);
 * - `ruleVersion`: it has no rule version, opened before #80 (D4);
 * - `baseVersion`: the request's version is not the market's current one;
 * - `supplement`: another supplement of the market is waiting — one at a time, so a request never
 *   overwrites another;
 * - `changes`: no item of `changes` differs from the current version.
 */
export const MARKET_SUPPLEMENT_REFUSALS = {
  status: 'not open or paused',
  closeAt: 'closed',
  ruleVersion: 'none',
  baseVersion: 'stale',
  supplement: 'pending',
  changes: 'unchanged',
} as const;

/**
 * The refusal of a supplement's change of an item outside PAUSED_SUPPLEMENT_ITEMS — the close —
 * while the market is PAUSED (#172 item 14), at the request and at the approval, on the item.
 */
export const SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED = 'fixed while paused';

/**
 * The refusal of a PATCH of an OPEN or PAUSED market (PAUSED since #114, ADR-0102) that changes a
 * version item (#172 item 14): one detail per such item, on the item. After the open they change
 * by a supplement alone; the same value again is no change.
 */
export const SUPPLEMENT_ONLY_WHILE_OPEN = 'supplement only while open';

// ---- bodies ---------------------------------------------------------------------------
/**
 * `POST /admin/markets/:id/supplements` (#80): the current version the text was written against
 * (`baseVersion` — the request is refused once the market has moved past it), the 보충 문구
 * (`changes`), why (`reason`, the request's reason, public in the history once approved) and the
 * 정산 영향 검토 — the grounds for no settlement impact (`settlementImpact`, admins only) — each
 * required and trimmed (approvals.ts), and the admin on screen (ADR-0092).
 */
export const requestMarketSupplementBodySchema = z
  .object({
    baseVersion: ruleVersionNumberSchema,
    changes: marketSupplementChangesSchema,
    reason: approvalReasonSchema,
    settlementImpact: approvalReasonSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RequestMarketSupplementBody' });
export type RequestMarketSupplementBody = z.infer<typeof requestMarketSupplementBodySchema>;

/**
 * `POST /admin/markets/:id/supplements/:requestId/approve`: the approving admin's reason (the
 * request's decision reason, required and trimmed) and the admin on screen.
 */
export const approveMarketSupplementBodySchema = z
  .object({ reason: approvalReasonSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'ApproveMarketSupplementBody' });
export type ApproveMarketSupplementBody = z.infer<typeof approveMarketSupplementBodySchema>;

/**
 * `POST /admin/markets/:id/supplements/:requestId/reject` (반려): one of
 * MARKET_SUPPLEMENT_REJECT_REASONS and the reason (the decision reason, required), and the admin on
 * screen.
 */
export const rejectMarketSupplementBodySchema = z
  .object({
    rejectReason: marketSupplementRejectReasonSchema,
    reason: approvalReasonSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RejectMarketSupplementBody' });
export type RejectMarketSupplementBody = z.infer<typeof rejectMarketSupplementBodySchema>;

/**
 * `POST /admin/markets/:id/supplements/:requestId/retract` (철회, the requester's): the admin on
 * screen and nothing else — `expectedAccountBodySchema` itself.
 */
export const retractMarketSupplementBodySchema = expectedAccountBodySchema;
export type RetractMarketSupplementBody = ExpectedAccountBody;

// ---- records --------------------------------------------------------------------------
/**
 * `approval_requests.payload` of a supplement (frozen at the insert, migration 0021): the version
 * it was written against, the 보충 문구 and the 정산 영향 검토; the request reason is the
 * supplement's reason. No `.meta`: no route answers it as is.
 */
export const marketSupplementRequestPayloadSchema = z.object({
  baseVersion: ruleVersionNumberSchema,
  changes: marketSupplementChangesSchema,
  settlementImpact: z.string(),
});
export type MarketSupplementRequestPayload = z.infer<typeof marketSupplementRequestPayloadSchema>;

/**
 * `rules_supplemented`'s payload (enums.ts): the version the approval made, its request, the items
 * it changed (the version's `changedItems`), the supplement's reason and its requester's id. The
 * event's actor is the approver.
 */
export interface MarketRulesSupplementedPayload {
  version: number;
  approvalId: string;
  items: RuleVersionItem[];
  reason: string;
  requestedBy: string;
}

// ---- read models ----------------------------------------------------------------------
/**
 * One rule version as the public detail shows it (`Market.ruleVersions`, decision 3 '#80 보충의
 * 형태'): its number, when it began (the open for v1, the approval for a later one), the items it
 * changed from the version before (empty for v1), the supplement's reason (null for v1) and its
 * full text. Nobody's name and no 정산 영향 검토 (#172 item 15 makes the text and the reason
 * public; #173 item 13 keeps the operators' names private).
 */
export const marketRuleVersionSchema = z
  .object({
    version: ruleVersionNumberSchema,
    createdAt: z.iso.datetime(),
    changedItems: z.array(ruleVersionItemSchema),
    reason: z.string().nullable(),
    content: marketRuleContentSchema,
  })
  .meta({ id: 'MarketRuleVersion' });
export type MarketRuleVersion = z.infer<typeof marketRuleVersionSchema>;

/**
 * One rule version as the admin detail shows it (`AdminMarket.ruleVersions`): the public fields and
 * who asked for it and who made it — for v1 no request (null) and the open's actor (null for the
 * worker's) — with the approval request and the 정산 영향 검토 (both null for v1). An account
 * closed since keeps its id with a null nickname.
 */
export const adminRuleVersionSchema = marketRuleVersionSchema
  .extend({
    approvalId: z.uuid().nullable(),
    requestedBy: adminAccountActorSchema.nullable(),
    createdBy: adminAccountActorSchema.nullable(),
    settlementImpact: z.string().nullable(),
  })
  .meta({ id: 'AdminRuleVersion' });
export type AdminRuleVersion = z.infer<typeof adminRuleVersionSchema>;

/**
 * The supplement waiting on a market (`AdminMarket.supplement.pending`): the request, who asked and
 * when, the version it was written against, the items it changes (SUPPLEMENT_ITEMS order) and their
 * new values, the reason and the 정산 영향 검토. Its requester may not decide it (approvals.ts).
 */
export const marketSupplementPendingSchema = z
  .object({
    requestId: z.uuid(),
    requestedBy: adminAccountActorSchema,
    requestedAt: z.iso.datetime(),
    baseVersion: ruleVersionNumberSchema,
    items: z.array(supplementItemSchema),
    changes: marketSupplementChangesSchema,
    reason: z.string(),
    settlementImpact: z.string(),
  })
  .meta({ id: 'MarketSupplementPending' });
export type MarketSupplementPending = z.infer<typeof marketSupplementPendingSchema>;

/**
 * One supplement request of the admin detail's log (`AdminMarket.supplement.log`): the request as
 * `marketSupplementPendingSchema` and how it ended — `status` pending, approved, rejected or
 * retracted; the decider, the decision's instant and reason (null unless decided); a 반려's reason
 * from the list (null unless rejected); the 철회's instant (null unless retracted); and the version
 * an approval made (null unless approved).
 */
export const marketSupplementLogEntrySchema = marketSupplementPendingSchema
  .extend({
    status: approvalStatusSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    decidedAt: z.iso.datetime().nullable(),
    decisionReason: z.string().nullable(),
    rejectReason: marketSupplementRejectReasonSchema.nullable(),
    retractedAt: z.iso.datetime().nullable(),
    version: ruleVersionNumberSchema.nullable(),
  })
  .meta({ id: 'MarketSupplementLogEntry' });
export type MarketSupplementLogEntry = z.infer<typeof marketSupplementLogEntrySchema>;

/** `AdminMarket.supplement`, in every status (#80): the waiting request and every request. */
export const adminMarketSupplementSchema = z
  .object({
    /** The waiting `market_supplement` request; null when none waits (at most one does). */
    pending: marketSupplementPendingSchema.nullable(),
    /** Every supplement request of the market, the newest first, the waiting one included. */
    log: z.array(marketSupplementLogEntrySchema),
  })
  .meta({ id: 'AdminMarketSupplement' });
export type AdminMarketSupplement = z.infer<typeof adminMarketSupplementSchema>;

// ---- the queue ------------------------------------------------------------------------
/**
 * One row of `GET /admin/market-supplements` (규칙 보충 대기, #80; query `cursorQuerySchema`): a
 * waiting supplement request and its market, the oldest request first — on a market whose close
 * has come too, which only a 반려 or a 철회 ends.
 */
export const adminMarketSupplementItemSchema = z
  .object({
    requestId: z.uuid(),
    marketId: z.uuid(),
    slug: z.string(),
    title: z.string(),
    status: marketStatusSchema,
    closeAt: z.iso.datetime(),
    requestedBy: adminAccountActorSchema,
    requestedAt: z.iso.datetime(),
    baseVersion: ruleVersionNumberSchema,
    items: z.array(supplementItemSchema),
  })
  .meta({ id: 'AdminMarketSupplementItem' });
export type AdminMarketSupplementItem = z.infer<typeof adminMarketSupplementItemSchema>;
