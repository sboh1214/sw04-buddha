import {
  APPROVAL_REFUSALS,
  type ApprovalRefusal,
  type ApprovalStatus,
  MARKET_SUPPLEMENT_REFUSALS,
  MARKET_SUPPLEMENT_REJECT_REASONS,
  MARKET_SUPPLEMENT_STATUSES,
  type MarketStatus,
  type MarketSupplementRejectReason,
  PAUSED_SUPPLEMENT_ITEMS,
  SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED,
  type SupplementItem,
  applySupplementChanges,
} from '@buddha/shared';
import { copy } from '@/copy';
import { nicknameShown } from './account-closure';
import {
  type AdminMarket,
  type AdminRuleVersion,
  ApiError,
  type MarketRuleContent,
  type MarketSupplementLogEntry,
  type MarketSupplementPending,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationMessage,
  validationPath,
} from './api';
import {
  type EventRow,
  type MarketFormField,
  type MarketSourceInputs,
  RULE_VERSION_ITEM_LABEL,
  marketFormError,
  ruleVersionItemList,
  ruleVersionItemText,
} from './market-admin';
import { reviewReasonDraft } from './market-review';
import { ruleVersionName } from './rule-versions';

/**
 * The pure half of the 규칙 보충 screens (#80, ADR-0101; ADR-0093 decision 2 #172 items 14·15,
 * decision 3 '#80 보충의 형태'): whether the admin detail offers a supplement and why not, who on
 * screen may decide the one waiting and whether it can be approved, what it changes from the
 * version it was written against, where focus goes once the form closes, the 보충 기록's and the
 * admin version list's rows, what each write may send and what a refusal says.
 * The panel, its form and its dialogs (app/admin/markets/[id]/market-supplement-*.tsx) draw them.
 * Admin-only (excluded-features.test.ts): the 정산 영향 검토 and the operators are never a member's.
 */

/** 반려 사유 of a supplement (MARKET_SUPPLEMENT_REJECT_REASONS), the dialog's list and the log's. */
export const SUPPLEMENT_REJECT_REASON_LABEL: Record<MarketSupplementRejectReason, string> = {
  meaning_change: copy.supplementRejectMeaningChange,
  other: copy.supplementRejectOther,
};

/** How a supplement request ended, the 보충 기록's badge (`approval_requests.status`). */
export const SUPPLEMENT_STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: copy.supplementStatusPending,
  approved: copy.supplementStatusApproved,
  rejected: copy.supplementStatusRejected,
  retracted: copy.supplementStatusRetracted,
};

/**
 * Whether the admin detail draws the 규칙 보충 panel at all: on a market that is OPEN or PAUSED (to
 * say why one opened before #80 takes none, D4), and on any that has a rule version or a
 * supplement request — a closed market keeps its history, and a request still waiting at the close
 * is shown for its 반려 or 철회. Not before the open: nothing is versioned yet.
 */
export function showsSupplementPanel(
  market: Pick<AdminMarket, 'status' | 'ruleVersion' | 'supplement'>,
): boolean {
  return (
    isSupplementStatus(market.status) ||
    market.ruleVersion !== null ||
    market.supplement.log.length > 0
  );
}

function isSupplementStatus(status: MarketStatus): boolean {
  return (MARKET_SUPPLEMENT_STATUSES as readonly MarketStatus[]).includes(status);
}

/** Whether a market's close has come by `at` (ms): an unreadable close counts as come. */
function closeHasCome(closeAt: string, at: number): boolean {
  const close = new Date(closeAt).getTime();
  return Number.isNaN(close) || close <= at;
}

/**
 * Why 보충 요청 is not offered, in the order the API checks it (MARKET_SUPPLEMENT_REFUSALS): `status`
 * — neither OPEN nor PAUSED; `none` — opened before #80, no version (D4); `closed` — its close has
 * come by `readAt`, the instant the row was read (a market stays OPEN past its close until the
 * worker closes it: no supplement after the close, #172 item 15); `pending` — one waits already
 * (one at a time), which the panel shows instead. `null` when it is offered. The API checks each
 * again at its own instant.
 */
export type SupplementUnavailable = 'status' | 'none' | 'closed' | 'pending';

export function supplementUnavailable(
  market: Pick<AdminMarket, 'status' | 'ruleVersion' | 'closeAt' | 'supplement'>,
  readAt: number,
): SupplementUnavailable | null {
  if (!isSupplementStatus(market.status)) return 'status';
  if (market.ruleVersion === null) return 'none';
  if (closeHasCome(market.closeAt, readAt)) return 'closed';
  if (market.supplement.pending !== null) return 'pending';
  return null;
}

/** What the panel says in place of 보충 요청 (the waiting request says `pending` itself). */
export const SUPPLEMENT_UNAVAILABLE_NOTE: Record<
  Exclude<SupplementUnavailable, 'pending'>,
  string
> = {
  status: copy.adminMarketSupplementUnavailableStatus,
  none: copy.adminMarketSupplementUnavailableNone,
  closed: copy.adminMarketSupplementUnavailableClosed,
};

/**
 * What the request form, once open, says when 보충 요청 is no longer offered as a refetch reads the
 * market (`supplementUnavailable`): it stays with what was typed, its 보충 요청 off, until the admin
 * closes it — the panel's own note, and for `pending` that another request waits now.
 */
export const SUPPLEMENT_FORM_UNAVAILABLE_NOTE: Record<SupplementUnavailable, string> = {
  ...SUPPLEMENT_UNAVAILABLE_NOTE,
  pending: copy.adminMarketSupplementFormPending,
};

/**
 * Why the waiting supplement cannot be approved as the row read at `readAt` stands, or `null` when
 * it can (the approval checks each again):
 * - `closed`: the market is neither OPEN nor PAUSED, or its close has come;
 * - `paused`: the market is PAUSED and the request changes an item outside PAUSED_SUPPLEMENT_ITEMS
 *   — the close (#172 item 14) — which the approval refuses (SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED)
 *   while the market stays paused.
 * Either way its 반려 or its 철회 ends it, which any status takes.
 */
export type SupplementUnapprovable = 'closed' | 'paused';

export function supplementUnapprovable(
  market: Pick<AdminMarket, 'status' | 'closeAt'>,
  pending: Pick<MarketSupplementPending, 'items'>,
  readAt: number,
): SupplementUnapprovable | null {
  if (!isSupplementStatus(market.status) || closeHasCome(market.closeAt, readAt)) return 'closed';
  const fixed = pending.items.some((item) => !PAUSED_SUPPLEMENT_ITEMS.includes(item));
  return market.status === 'paused' && fixed ? 'paused' : null;
}

/** What the waiting request says above its 승인, turned off (`supplementUnapprovable`). */
export const SUPPLEMENT_UNAPPROVABLE_NOTE: Record<SupplementUnapprovable, string> = {
  closed: copy.adminMarketSupplementPendingClosed,
  paused: copy.adminMarketSupplementPendingPaused,
};

/**
 * Whether the admin on screen asked for the waiting supplement — who may not approve or reject it
 * and alone may retract it (approvals.ts `requester`, `not_requester`) — or `undefined` until
 * `GET /me` has said who is on screen (`useOperatorId`): the panel offers no decision until then.
 */
export function isSupplementRequester(
  pending: Pick<MarketSupplementPending, 'requestedBy'>,
  operatorId: string | undefined,
): boolean | undefined {
  return operatorId === undefined ? undefined : pending.requestedBy.id === operatorId;
}

/**
 * Where focus goes once the request form has closed (WCAG 2.4.3), as the panel is drawn now: back
 * to 보충 요청 (`request`) where it is drawn; else to the waiting request's heading (`pending`) — a
 * request just sent waits in its place — else to the panel's own (`title`). A request sent waits
 * for the market that holds it (`waiting`: the market it was sent from still drawn): `null` until
 * then, so focus does not land on a 보충 요청 about to go.
 */
export type SupplementRefocus = 'request' | 'pending' | 'title';

export function supplementRefocus(drawn: {
  waiting: boolean;
  request: boolean;
  pending: boolean;
}): SupplementRefocus | null {
  if (drawn.waiting) return null;
  if (drawn.request) return 'request';
  return drawn.pending ? 'pending' : 'title';
}

/** The market's version items as they stand (`MarketRuleContent`): its current version's text. */
export function marketRuleContent(market: AdminMarket): MarketRuleContent {
  return {
    title: market.title,
    description: market.description,
    yesCondition: market.yesCondition,
    noCondition: market.noCondition,
    eventDeadline: market.eventDeadline,
    primarySource: market.primarySource,
    fallbackSources: market.fallbackSources,
    fallbackCondition: market.fallbackCondition,
    longDelayDays: market.longDelayDays,
    delayHandling: market.delayHandling,
    scheduledOpenAt: market.scheduledOpenAt,
    closeAt: market.closeAt,
    scheduledAnnouncementAt: market.scheduledAnnouncementAt,
    scheduledJudgementAt: market.scheduledJudgementAt,
    judgementTimeZone: market.judgementTimeZone,
  };
}

/** One changed item of a supplement: its name, its text in the base version and after. */
export interface SupplementChangeRow {
  item: SupplementItem;
  label: string;
  before: string;
  after: string;
}

/**
 * What a supplement request changes (#172 item 15: the reviewer reads the old and the new text):
 * each item it names (`items`, SUPPLEMENT_ITEMS order) with its text in the version the request was
 * written against — that version's full text, or the market's while it is not listed — and its
 * text once applied (`applySupplementChanges`), as `time` renders an instant (the admin's KST).
 */
export function supplementChangeRows(
  market: AdminMarket,
  request: Pick<MarketSupplementPending, 'baseVersion' | 'items' | 'changes'>,
  time: (iso: string) => string,
): SupplementChangeRow[] {
  const base =
    market.ruleVersions.find((row) => row.version === request.baseVersion)?.content ??
    marketRuleContent(market);
  const after: MarketRuleContent = applySupplementChanges(base, request.changes);
  return request.items.map((item) => ({
    item,
    label: RULE_VERSION_ITEM_LABEL[item],
    before: ruleVersionItemText(item, base, time),
    after: ruleVersionItemText(item, after, time),
  }));
}

/** Who wrote or decided an entry: the nickname, '탈퇴한 사용자' for an account gone since. */
export function supplementActorName(actor: { nickname: string | null } | null): string {
  return actor === null ? copy.eventSystem : nicknameShown(actor.nickname);
}

/**
 * One 보충 기록 entry's rows below its status, requester and time (`AdminMarket.supplement.log`):
 * the version it was written against and the items it changes, the reason and the 정산 영향 검토;
 * then how it ended — the decider, the decision's instant and reason, a 반려's reason from the
 * list, the 철회's instant, the version an approval made. Each absent where it has none.
 */
export function supplementLogRows(
  entry: MarketSupplementLogEntry,
  time: (iso: string) => string,
): EventRow[] {
  const rows: EventRow[] = [
    { label: copy.adminMarketSupplementBase, value: ruleVersionName(entry.baseVersion) },
    { label: copy.adminMarketSupplementItems, value: ruleVersionItemList(entry.items) },
    { label: copy.adminMarketSupplementReason, value: entry.reason },
    { label: copy.adminMarketSupplementImpact, value: entry.settlementImpact },
  ];
  if (entry.decidedBy !== null) {
    rows.push({ label: copy.supplementLogDecidedBy, value: supplementActorName(entry.decidedBy) });
  }
  if (entry.decidedAt !== null) {
    rows.push({ label: copy.supplementLogDecidedAt, value: time(entry.decidedAt) });
  }
  if (entry.rejectReason !== null) {
    rows.push({
      label: copy.supplementLogRejectReason,
      value: SUPPLEMENT_REJECT_REASON_LABEL[entry.rejectReason],
    });
  }
  if (entry.decisionReason !== null) {
    rows.push({ label: copy.supplementLogDecisionReason, value: entry.decisionReason });
  }
  if (entry.retractedAt !== null) {
    rows.push({ label: copy.supplementLogRetractedAt, value: time(entry.retractedAt) });
  }
  if (entry.version !== null) {
    rows.push({ label: copy.supplementLogVersion, value: ruleVersionName(entry.version) });
  }
  return rows;
}

/**
 * One version of the admin's 규칙 버전 기록 (`AdminMarket.ruleVersions`) as rows below its name: when
 * it began; for v1, fixed at the open (the panel says so beside its name), who opened it (시스템 for
 * the worker); for a
 * later one the items it changed, the reason, who asked for it, who approved it and the 정산 영향
 * 검토 — what the public history leaves out.
 */
export function adminRuleVersionRows(
  version: AdminRuleVersion,
  time: (iso: string) => string,
): EventRow[] {
  const at = { label: copy.adminRuleVersionCreatedAt, value: time(version.createdAt) };
  if (version.version === 1 || version.approvalId === null) {
    return [
      at,
      { label: copy.adminRuleVersionOpenedBy, value: supplementActorName(version.createdBy) },
    ];
  }
  return [
    at,
    { label: copy.eventRulesItems, value: ruleVersionItemList(version.changedItems) },
    { label: copy.adminMarketSupplementReason, value: version.reason ?? '—' },
    {
      label: copy.adminMarketSupplementRequestedBy,
      value: supplementActorName(version.requestedBy),
    },
    { label: copy.adminRuleVersionApprovedBy, value: supplementActorName(version.createdBy) },
    { label: copy.adminMarketSupplementImpact, value: version.settlementImpact ?? '—' },
  ];
}

// ---- what each write may send ----------------------------------------------------------------

/**
 * 보충 요청's reason and 정산 영향 검토 as typed (#172 item 15), each `approvalReasonSchema`'s 1..500
 * trimmed: ready once both are, with what each says under its field while it is not.
 */
export function supplementRequestDraft(
  reasonText: string,
  impactText: string,
): {
  ready: boolean;
  reason: string;
  settlementImpact: string;
  reasonError: string | null;
  impactError: string | null;
} {
  const reason = reviewReasonDraft(reasonText);
  const impact = reviewReasonDraft(impactText);
  return {
    ready: reason.error === null && impact.error === null,
    reason: reason.reason,
    settlementImpact: impact.reason,
    reasonError: reason.error,
    impactError: impact.error === null ? null : copy.errMarketSupplementImpact,
  };
}

/** A supplement's 반려 사유 as the select holds it ('' for none picked), or null. */
export function supplementRejectReasonOf(value: string): MarketSupplementRejectReason | null {
  return MARKET_SUPPLEMENT_REJECT_REASONS.find((reason) => reason === value) ?? null;
}

/** 반려: ready once a reason is picked from the list and the 설명 is typed. */
export function supplementRejectDraft(
  value: string,
  reasonText: string,
): { ready: boolean; rejectReason: MarketSupplementRejectReason | null; reason: string } {
  const rejectReason = supplementRejectReasonOf(value);
  const { reason, error } = reviewReasonDraft(reasonText);
  return { ready: rejectReason !== null && error === null, rejectReason, reason };
}

// ---- what a refusal says ---------------------------------------------------------------------

/**
 * The two-person rule's refusals as the supplement says them: the requester's in its own words,
 * the rest as every approval screen says them.
 */
const SUPPLEMENT_REFUSAL_MESSAGES: Readonly<Record<ApprovalRefusal, string>> = {
  requester: copy.adminMarketSupplementExcludedRequester,
  decided: copy.errApprovalDecided,
  retracted: copy.errApprovalRetracted,
  not_requester: copy.errApprovalNotRequester,
  creator: copy.errApprovalCreator,
  editor: copy.errApprovalEditor,
  no_decider: copy.errApprovalNoDecider,
};

/** What each refusal of the market's state says (MARKET_SUPPLEMENT_REFUSALS, by path). */
const STATE_REFUSAL_MESSAGES: Readonly<Record<keyof typeof MARKET_SUPPLEMENT_REFUSALS, string>> = {
  status: copy.errMarketSupplementStatus,
  closeAt: copy.errMarketSupplementClosed,
  ruleVersion: copy.errMarketSupplementNoVersion,
  baseVersion: copy.errMarketSupplementStale,
  supplement: copy.errMarketSupplementPending,
  changes: copy.errMarketSupplementUnchanged,
};

/** The fields of the supplement's form and dialogs a refusal can land under, beside the items. */
export type SupplementField = 'reason' | 'settlementImpact' | 'rejectReason';

/**
 * Where a refused supplement write is said (#80):
 * - `item`: under the version item's input the refusal is about — the form's
 *   (`marketFormError`: RULES_REQUIRED, a rule item's or a source's shape, the close later only, in
 *   the future and not while PAUSED, the time order, the lead close, the switch condition). A
 *   dialog has no such input and says it in its alert; `refresh` when the market moved under it (a
 *   close refused while PAUSED);
 * - `field`: under the reason (or a 반려's 설명), the 정산 영향 검토 or the 반려 사유;
 * - `alert`: in the form or the dialog, which stays — the market's state (neither OPEN nor PAUSED,
 *   its close come, no version, the version moved, another supplement waiting, nothing changed),
 *   an unknown request, APPROVAL_NOT_ALLOWED by its reason (the requester, decided, retracted, no
 *   other admin to decide), the market gone, a session ended or a role revoked, a request that
 *   never reached the API. `refresh` when the screen behind is out of date: the caller reads the
 *   detail again;
 * - `toast`: the cookie of another account (ADR-0092): nothing was done, the form or the dialog
 *   closes and the session is asked again.
 * `values` are the form's as sent — the dialogs send none — and `leadCloseGapMinutes` the market's,
 * which an item's refusal reads (`marketFormError`); a lead close the API could not check is said
 * in the words of what is tried again — the form's request (errMarketSupplementLeadCloseUndecided:
 * 다시 요청) or the approval (errMarketSupplementApproveLeadCloseUndecided: 다시 승인).
 */
export type SupplementFailure =
  | { kind: 'item'; field: MarketFormField; message: string; refresh: boolean }
  | { kind: 'field'; field: SupplementField; message: string }
  | { kind: 'alert'; message: string; refresh: boolean }
  | { kind: 'toast'; message: string };

export function supplementFailure(
  error: unknown,
  values?: MarketSourceInputs,
  leadCloseGapMinutes?: number | null,
): SupplementFailure {
  const alert = (message: string, refresh = false): SupplementFailure => ({
    kind: 'alert',
    message,
    refresh,
  });
  if (isForAnotherAccount(error)) return { kind: 'toast', message: copy.sessionChanged };
  if (isApiError(error, 'UNAUTHENTICATED')) return alert(copy.errUnauthenticated);
  // Not the account check above: AdminGuard's, once another admin revoked this one's role.
  if (isApiError(error, 'FORBIDDEN')) return alert(copy.adminOnly);
  if (isApiError(error, 'APPROVAL_NOT_ALLOWED')) {
    const refusal = APPROVAL_REFUSALS.find((reason) => reason === validationMessage(error));
    return alert(
      refusal === undefined ? copy.errUnknown : SUPPLEMENT_REFUSAL_MESSAGES[refusal],
      true,
    );
  }
  if (isApiError(error, 'NOT_FOUND')) return alert(copy.adminMarketNotFound, true);
  const item = (failure: ApiError, refresh = false): SupplementFailure => {
    const placed = marketFormError(failure, values, leadCloseGapMinutes);
    if (placed === undefined) return alert(copy.errMarketInvalid);
    // A lead close the API could not check, in the words of what is tried again: the form's
    // request (it alone sends `values`), else the approval (the one decision that checks it).
    const undecided = placed.message === copy.errMarketLeadCloseUndecided;
    const again =
      values !== undefined
        ? copy.errMarketSupplementLeadCloseUndecided
        : copy.errMarketSupplementApproveLeadCloseUndecided;
    const message = undecided ? again : placed.message;
    return { kind: 'item', ...placed, message, refresh };
  };
  if (isApiError(error, 'RULES_REQUIRED')) return item(error);
  if (!isApiError(error, 'VALIDATION_ERROR')) {
    return alert(isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown);
  }
  const path = validationPath(error) ?? [];
  const [named] = path;
  const message = validationMessage(error);
  switch (named) {
    case 'reason':
      return { kind: 'field', field: 'reason', message: copy.errMarketReviewReason };
    case 'settlementImpact':
      return { kind: 'field', field: 'settlementImpact', message: copy.errMarketSupplementImpact };
    case 'rejectReason':
      return { kind: 'field', field: 'rejectReason', message: copy.errMarketReviewRejectReason };
    case 'requestId':
      return alert(copy.errMarketSupplementUnknown, true);
    case 'changes':
      // An item's shape, as the update body takes it: the path after `changes` is the form's.
      if (path.length > 1) {
        return item(
          new ApiError(error.status, {
            code: 'VALIDATION_ERROR',
            message: error.message,
            details: [{ path: path.slice(1), message: message ?? '' }],
          }),
        );
      }
      return message === MARKET_SUPPLEMENT_REFUSALS.changes
        ? alert(STATE_REFUSAL_MESSAGES.changes, true)
        : alert(copy.errMarketInvalid);
    default:
      break;
  }
  if (
    typeof named === 'string' &&
    Object.hasOwn(MARKET_SUPPLEMENT_REFUSALS, named) &&
    message === MARKET_SUPPLEMENT_REFUSALS[named as keyof typeof MARKET_SUPPLEMENT_REFUSALS]
  ) {
    return alert(STATE_REFUSAL_MESSAGES[named as keyof typeof MARKET_SUPPLEMENT_REFUSALS], true);
  }
  // An item rule, on the item's own path (`['closeAt']`, `['fallbackCondition']`…): the form's.
  return item(error, message === SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED);
}
