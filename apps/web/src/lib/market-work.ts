import {
  MARKET_WORK_KINDS,
  type MarketEventType,
  type MarketSnapshotChangeField,
  type MarketWorkActionType,
  type MarketWorkEntryType,
  type MarketWorkKind,
  isJudgementCorrection,
  isMarketEventType,
  marketJudgementCorrectionSchema,
  marketPausePathSchema,
  marketPauseReasonSchema,
  marketRejectReasonSchema,
  marketResultSchema,
  priceProtectionTicksSchema,
} from '@buddha/shared';
import type { Route } from 'next';
import * as z from 'zod';
import { copy } from '@/copy';
import { nicknameShown } from './account-closure';
import { type AdminMarketWorkChange, type AdminMarketWorkEntry } from './api';
import { formatKst } from './datetime';
import {
  type EventRow,
  MARKET_EVENT_LABEL,
  MARKET_RESULT_LABEL,
  PAUSE_REASON_LABEL,
  REJECT_REASON_LABEL,
  compactJson,
  judgementDelayEpisodeText,
  judgementVersionName,
  marketEventLabel,
  marketEventRows,
  priceProtectionText,
} from './market-admin';
import { PAUSE_PATH_LABEL } from './market-pause';
import { timeZoneLabel } from './time-zone';

/**
 * 시장별 작업 이력 (#145 part 2, ADR-0164; 145-5, 145-6, 145-7, 145-12, 145-13, 145-16, 145-18):
 * `/admin/markets/[id]/work-history`, one market's operator work oldest first — its admin actions,
 * approval requests and decisions among them, and the worker's processing as '시스템' — filtered by
 * `?kind=` (수정·중단·판정·지급·그 밖, none for 전체). What each entry is called, what stands for its
 * reason (145-16) and how its stored details read. Admin-only (excluded-features.test.ts): the
 * settlement's attempts and error and the retry's outcome are no member's (the PRIVATE_DATA item
 * `operation-records`).
 */

/** The query parameter naming the kind. */
export const MARKET_WORK_KIND_PARAM = 'kind';

type Param = string | string[] | null | undefined;

/** The kind a `?kind=` names; anything else (none, unknown, repeated) is 전체. */
export function marketWorkKindParam(param: Param): MarketWorkKind | undefined {
  return MARKET_WORK_KINDS.find((kind) => kind === param);
}

/** A market's history, one kind or 전체 (the bare path). */
export function marketWorkPath(id: string, kind?: MarketWorkKind): Route {
  const path = `/admin/markets/${id}/work-history`;
  return (kind === undefined ? path : `${path}?${MARKET_WORK_KIND_PARAM}=${kind}`) as Route;
}

/** The five kinds in 145-5's words, in screen order (MARKET_WORK_KINDS). */
export const MARKET_WORK_KIND_LABEL: Readonly<Record<MarketWorkKind, string>> = {
  edit: copy.adminMarketWorkKindEdit,
  pause: copy.adminMarketWorkKindPause,
  judgement: copy.adminMarketWorkKindJudgement,
  settlement: copy.adminMarketWorkKindSettlement,
  other: copy.adminMarketWorkKindOther,
};

/**
 * Each shown admin action's name (145-12's words). An action and the event of its transaction
 * share one name where the event log has it (검수 제출, 일시 중단, 가격 보호 폭 변경…).
 */
export const MARKET_WORK_ACTION_LABEL: Readonly<Record<MarketWorkActionType, string>> = {
  market_create: copy.adminMarketWorkMarketCreate,
  market_update: copy.adminMarketWorkMarketUpdate,
  market_supplement_request: copy.adminMarketWorkSupplementRequest,
  market_supplement_approve: copy.adminMarketWorkSupplementApprove,
  market_supplement_reject: copy.adminMarketWorkSupplementReject,
  market_supplement_retract: copy.adminMarketWorkSupplementRetract,
  market_price_protection_change: copy.eventPriceProtectionChanged,
  market_pause: copy.eventPaused,
  market_pause_decision_request: copy.adminMarketWorkPauseDecisionRequest,
  market_pause_decision_approve: copy.adminMarketWorkPauseDecisionApprove,
  market_pause_decision_reject: copy.adminMarketWorkPauseDecisionReject,
  market_pause_decision_retract: copy.adminMarketWorkPauseDecisionRetract,
  market_judgement_request: copy.adminMarketWorkJudgementRequest,
  market_judgement_approve: copy.adminMarketWorkJudgementApprove,
  market_judgement_reject: copy.adminMarketWorkJudgementReject,
  market_judgement_retract: copy.adminMarketWorkJudgementRetract,
  market_dispute_dismiss: copy.adminMarketWorkDisputeDismiss,
  market_dispute_accept: copy.adminMarketWorkDisputeAccept,
  market_delay_record: copy.eventJudgementDelayRecorded,
  market_conflict_declare: copy.marketConflictDeclare,
  market_resolve: copy.adminMarketWorkResolveInterim,
  market_settlement_retry: copy.adminSettlementRetry,
  reconciliation_recovery_request: copy.adminMarketWorkRecoveryRequest,
  reconciliation_recovery_approve: copy.adminMarketWorkRecoveryApprove,
  reconciliation_recovery_reject: copy.adminMarketWorkRecoveryReject,
  reconciliation_recovery_retract: copy.adminMarketWorkRecoveryRetract,
  market_submit: copy.eventSubmitted,
  market_approve: copy.adminMarketWorkMarketApprove,
  market_reject: copy.adminMarketWorkMarketReject,
  market_revert: copy.eventReverted,
  market_reschedule: copy.eventOpenRescheduled,
  market_cancel_request: copy.adminMarketWorkCancelRequest,
  market_cancel_approve: copy.adminMarketWorkCancelApprove,
  market_cancel_reject: copy.adminMarketWorkCancelReject,
  market_cancel_retract: copy.adminMarketWorkCancelRetract,
  market_link: copy.adminMarketWorkLink,
  market_unlink: copy.adminMarketWorkUnlink,
  reconciliation_run: copy.reconciliationRun,
  fill_classification_request: copy.adminMarketWorkFillClassificationRequest,
  fill_classification_approve: copy.adminMarketWorkFillClassificationApprove,
  fill_classification_reject: copy.adminMarketWorkFillClassificationReject,
  fill_classification_retract: copy.adminMarketWorkFillClassificationRetract,
  proposal_adopt: copy.adminMarketWorkProposalAdopt,
  proposal_link: copy.adminMarketWorkProposalLink,
  market_open: copy.adminMarketWorkOpenInterim,
  market_close: copy.adminMarketWorkCloseInterim,
};

/**
 * One name per history type (exhaustive: a new action or event type does not compile until it
 * has one) — the actions', the event log's for the events (MARKET_EVENT_LABEL), and the
 * settlement step's failure record.
 */
export const MARKET_WORK_LABEL: Readonly<Record<MarketWorkEntryType, string>> = {
  ...MARKET_WORK_ACTION_LABEL,
  ...MARKET_EVENT_LABEL,
  settlement_step: copy.adminMarketWorkStep,
};

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A liquidity setting's `market_update` (`{liquidity, reason}`, no snapshots). */
const isLiquidityUpdate = (details: Record<string, unknown>): boolean =>
  typeof details.liquidity === 'object' && details.liquidity !== null;

/** A 판정 정정's four steps (#176; 145-12 "판정 등록·승인·반려·철회·정정"). */
const JUDGEMENT_CORRECTION_LABEL = {
  market_judgement_request: copy.adminMarketWorkJudgementCorrectionRequest,
  market_judgement_approve: copy.adminMarketWorkJudgementCorrectionApprove,
  market_judgement_reject: copy.adminMarketWorkJudgementCorrectionReject,
  market_judgement_retract: copy.adminMarketWorkJudgementCorrectionRetract,
} as const satisfies Partial<Record<MarketWorkActionType, string>>;

const isCorrectionStep = (
  type: MarketWorkEntryType,
): type is keyof typeof JUDGEMENT_CORRECTION_LABEL =>
  Object.hasOwn(JUDGEMENT_CORRECTION_LABEL, type);

/**
 * An entry's name: MARKET_WORK_LABEL's, but 조기 마감 for an approved early close's `closed` (the
 * event log's `marketEventLabel`), 유동성 설정 for a `market_update` that set the liquidity, and
 * 판정 정정's own names for a correction's registration, approval, 반려 and 철회.
 */
export function marketWorkLabel(entry: Pick<AdminMarketWorkEntry, 'type' | 'details'>): string {
  if (isMarketEventType(entry.type)) return marketEventLabel(entry.type, entry.details);
  if (entry.type === 'market_update' && isLiquidityUpdate(entry.details)) {
    return copy.adminMarketWorkLiquidityUpdate;
  }
  if (isCorrectionStep(entry.type) && isJudgementCorrection(entry.type, entry.details)) {
    return JUDGEMENT_CORRECTION_LABEL[entry.type];
  }
  return MARKET_WORK_LABEL[entry.type];
}

/** Who did it: the admin's nickname ('탈퇴한 사용자' for a closed account), or 시스템 (145-6). */
export function marketWorkActorText(actor: AdminMarketWorkEntry['actor']): string {
  return actor === null ? copy.eventSystem : nicknameShown(actor.nickname);
}

/** A 정산 다시 시도's result (145-7). */
export const MARKET_WORK_RETRY_OUTCOME_TEXT: Readonly<
  Record<NonNullable<AdminMarketWorkEntry['retryOutcome']>, string>
> = {
  settled: copy.adminMarketWorkRetrySettled,
  failed: copy.adminMarketWorkRetryFailed,
};

/** The line a reason basis with no stored reason shows (145-16). */
export const MARKET_WORK_BASIS_TEXT = {
  changed_items: copy.adminMarketWorkBasisChangedItems,
  actor_time: copy.adminMarketWorkBasisActorTime,
  retracted: copy.adminMarketWorkBasisRetracted,
} as const satisfies Partial<Record<AdminMarketWorkEntry['reasonBasis'], string>>;

/** The opens an admin's approval or reschedule made at once, its scheduled open passed (#21). */
const OPENED_AT_ONCE_SOURCES: readonly unknown[] = ['approval', 'reschedule'];

/**
 * A system entry's rule, its reason (145-16 "시스템 처리는 그 규칙을 사유로 보인다"): the scheduled
 * open or close, the dispute deadline with nothing left holding the result, the payout's start and
 * end, the ledger failure that paused it (the pause reason's own words), and the no-fill cancel's
 * stored sentence. Null for the step record — its attempts and error stand there — and for a type
 * no rule writes.
 */
export function marketWorkSystemRule(
  entry: Pick<AdminMarketWorkEntry, 'type' | 'details' | 'reason'>,
): string | null {
  if (entry.reason !== null) return entry.reason;
  const type: MarketWorkEntryType = entry.type;
  if (!isMarketEventType(type)) return null;
  const rules: Partial<Record<MarketEventType, () => string | null>> = {
    opened: () =>
      OPENED_AT_ONCE_SOURCES.includes(entry.details.source)
        ? copy.adminMarketWorkRuleOpenedAtOnce
        : copy.adminMarketWorkRuleOpened,
    closed: () => copy.adminMarketWorkRuleClosed,
    cancelled: () => copy.adminMarketWorkRuleClosed,
    resolved: () => copy.adminMarketWorkRuleResolved,
    settling: () => copy.adminMarketWorkRuleSettling,
    finalized: () => copy.adminMarketWorkRuleFinalized,
    paused: () => {
      const reason = marketPauseReasonSchema.safeParse(entry.details.reason);
      return reason.success ? PAUSE_REASON_LABEL[reason.data] : null;
    },
  };
  return rules[type]?.() ?? null;
}

// ---- changes (145-16 '바뀐 항목', 항목: 이전 → 새) --------------------------------------------

/** Each compared snapshot field's name: the market form's and the open-items check's words. */
export const MARKET_WORK_FIELD_LABEL: Readonly<Record<MarketSnapshotChangeField, string>> = {
  slug: copy.adminMarketWorkFieldSlug,
  title: copy.openItemTitle,
  description: copy.openItemDescription,
  yesCondition: copy.openItemYesCondition,
  noCondition: copy.openItemNoCondition,
  eventDeadline: copy.openItemEventDeadline,
  primarySource: copy.openItemPrimarySource,
  fallbackSources: copy.openItemFallbackSources,
  fallbackCondition: copy.openItemFallbackCondition,
  longDelayDays: copy.openItemLongDelayDays,
  delayHandling: copy.openItemDelayHandling,
  categoryId: copy.adminMarketCategory,
  tags: copy.adminMarketTags,
  imageUrl: copy.adminMarketImageUrl,
  scheduledOpenAt: copy.openItemScheduledOpenAt,
  scheduledAnnouncementAt: copy.openItemScheduledAnnouncementAt,
  scheduledJudgementAt: copy.openItemScheduledJudgementAt,
  judgementTimeZone: copy.openItemJudgementTimeZone,
  closeAt: copy.openItemCloseAt,
  leadCloseGapMinutes: copy.adminMarketLeadCloseGap,
  priceProtectionTicks: copy.openItemPriceProtection,
  currentLiquidityVersion: copy.openItemLiquidity,
};

/** What a value says nothing in: null, missing, blank or an empty list. */
const NONE = '—';

const INSTANT_FIELDS: ReadonlySet<MarketSnapshotChangeField> = new Set([
  'eventDeadline',
  'scheduledOpenAt',
  'scheduledAnnouncementAt',
  'scheduledJudgementAt',
  'closeAt',
]);

const SOURCE = z.object({ name: z.string(), url: z.string() });
const CATEGORY = z.object({ id: z.number(), nameKo: z.string().nullable() });
const sourceText = (source: z.infer<typeof SOURCE>) => `${source.name} (${source.url})`;

/** One side of a change as the row reads it; anything of an unexpected shape as JSON. */
export function marketWorkValueText(field: MarketSnapshotChangeField, value: unknown): string {
  if (value === null || value === undefined) return NONE;
  if (typeof value === 'string' && value.trim() === '') return NONE;
  if (Array.isArray(value) && value.length === 0) return NONE;
  if (INSTANT_FIELDS.has(field) && typeof value === 'string') return formatKst(value) || value;
  if (field === 'categoryId') {
    // The server's {id, nameKo} (its current name); '#id' only for an id no category holds.
    const category = CATEGORY.safeParse(value);
    if (category.success) return category.data.nameKo ?? `#${String(category.data.id)}`;
    if (typeof value === 'number') return `#${String(value)}`;
  }
  if (field === 'tags' && Array.isArray(value)) return value.map(String).join(', ');
  if (field === 'judgementTimeZone' && typeof value === 'string') return timeZoneLabel(value);
  if (field === 'priceProtectionTicks') {
    const ticks = priceProtectionTicksSchema.safeParse(value);
    if (ticks.success) return priceProtectionText(ticks.data);
  }
  if (field === 'leadCloseGapMinutes' && typeof value === 'number') {
    return `${value.toLocaleString('ko-KR')}${copy.adminMarketLeadCloseGapMinutes}`;
  }
  if (field === 'primarySource') {
    const source = SOURCE.safeParse(value);
    if (source.success) return sourceText(source.data);
  }
  if (field === 'fallbackSources') {
    const sources = z.array(SOURCE).safeParse(value);
    if (sources.success) return sources.data.map(sourceText).join(', ');
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return compactJson(value);
}

/**
 * How many changes a row shows before the rest fold under one disclosure: a draft's creation sets
 * every field at once, and a line per field would fill the screen with one row.
 */
export const MARKET_WORK_CHANGES_SHOWN = 3;

/** The fold's summary: '바뀐 항목 {n}개 더 보기', `hidden` the changes under it. */
export function marketWorkChangesMoreText(hidden: number): string {
  return copy.adminMarketWorkChangesMore.replace('{n}', hidden.toLocaleString('ko-KR'));
}

/** A change as '항목: 이전 → 새' (145-16). */
export function marketWorkChangeText(change: AdminMarketWorkChange): string {
  const before = marketWorkValueText(change.field, change.before);
  const after = marketWorkValueText(change.field, change.after);
  return `${MARKET_WORK_FIELD_LABEL[change.field]}: ${before} → ${after}`;
}

// ---- details --------------------------------------------------------------------------

const instant = z.string().refine((iso) => formatKst(iso) !== '');

/** The stored detail shapes this screen reads into rows (enums.ts ADMIN_ACTION_TYPES' payloads). */
const RESCHEDULE = z.object({ before: instant, after: instant });
const PRICE_PROTECTION = z.object({
  before: priceProtectionTicksSchema.nullable(),
  after: priceProtectionTicksSchema,
});
const PAUSE = z.object({
  reason: marketPauseReasonSchema,
  resultPublishedAt: instant.nullable().optional(),
});
const PAUSE_DECISION = z.object({ path: marketPausePathSchema });
const JUDGEMENT_RESULT = z.object({ result: marketResultSchema });
const CORRECTION = z.object({ correction: marketJudgementCorrectionSchema });
const REOPENED = z.object({ reopenedDisputeIds: z.array(z.string()) });
const JUDGEMENT_APPROVE = z.object({
  version: z.number().int().min(1),
  result: marketResultSchema,
  disputeDeadline: instant,
});
const DISPUTE_DECISION = z.object({ judgementVersion: z.number().int().min(1) });
const DELAY_RECORD = z.object({
  nextReviewAt: instant,
  marketStatus: z.enum(['closed', 'provisional']),
  judgementVersion: z.number().int().min(1).nullable(),
});
const MARKET_REJECT = z.object({ rejectReason: marketRejectReasonSchema });

const disputeCount = (ids: readonly unknown[]) =>
  `${ids.length.toLocaleString('ko-KR')}${copy.adminMarketDisputesHoldingUnit}`;

/**
 * A 판정 정정's own rows (#176): the registration's version it corrects, its 정정 사유 (its 사유
 * column holds its 설명 like any 판정 등록's, 145-16) and the accepted disputes registered with
 * it; the approval's 정정 사유 (its 사유 column holds the approver's); a 반려's or 철회's disputes
 * sent back to review. None for a first judgement's.
 */
function correctionRows(type: MarketWorkActionType, details: unknown): EventRow[] {
  switch (type) {
    case 'market_judgement_request': {
      const parsed = CORRECTION.safeParse(details);
      if (!parsed.success) return [];
      const { correction } = parsed.data;
      return [
        {
          label: copy.adminMarketWorkCorrectionBase,
          value: judgementVersionName(correction.baseVersion),
        },
        { label: copy.adminMarketJudgementCorrectionReason, value: correction.reason },
        ...(correction.disputeIds.length === 0
          ? []
          : [
              {
                label: copy.adminMarketJudgementCorrectionDisputesRegistered,
                value: disputeCount(correction.disputeIds),
              },
            ]),
      ];
    }
    case 'market_judgement_approve': {
      const parsed = CORRECTION.safeParse(details);
      return parsed.success
        ? [
            {
              label: copy.adminMarketJudgementCorrectionReason,
              value: parsed.data.correction.reason,
            },
          ]
        : [];
    }
    case 'market_judgement_reject':
    case 'market_judgement_retract': {
      const parsed = REOPENED.safeParse(details);
      return parsed.success && parsed.data.reopenedDisputeIds.length > 0
        ? [
            {
              label: copy.adminMarketWorkReopenedDisputes,
              value: disputeCount(parsed.data.reopenedDisputeIds),
            },
          ]
        : [];
    }
    default:
      return [];
  }
}

/**
 * An action's details as label/value rows, for the shapes worth reading (a reschedule's times, a
 * width before and after, a pause's reason code, a decision's path, a judgement's result, version
 * and deadline, a dispute's version, a delay record's next review, a 반려's listed reason); its
 * reason is the reason column's and is not repeated. `undefined` for any other shape — the screen
 * shows it as one JSON line (`marketWorkDetailsJson`).
 */
function actionRows(type: MarketWorkActionType, details: unknown): EventRow[] | undefined {
  switch (type) {
    case 'market_reschedule': {
      const parsed = RESCHEDULE.safeParse(details);
      if (!parsed.success) return undefined;
      return [
        { label: copy.reviewLogOpenBefore, value: formatKst(parsed.data.before) },
        { label: copy.reviewLogOpenAfter, value: formatKst(parsed.data.after) },
      ];
    }
    case 'market_price_protection_change': {
      const parsed = PRICE_PROTECTION.safeParse(details);
      if (!parsed.success) return undefined;
      return [
        { label: copy.eventRulesBefore, value: priceProtectionText(parsed.data.before) },
        { label: copy.eventRulesAfter, value: priceProtectionText(parsed.data.after) },
      ];
    }
    case 'market_pause': {
      const parsed = PAUSE.safeParse(details);
      if (!parsed.success) return undefined;
      const published = parsed.data.resultPublishedAt ?? null;
      return [
        { label: copy.adminMarketPauseReason, value: PAUSE_REASON_LABEL[parsed.data.reason] },
        ...(published === null
          ? []
          : [{ label: copy.adminMarketPauseResultPublishedAt, value: formatKst(published) }]),
      ];
    }
    case 'market_pause_decision_request':
    case 'market_pause_decision_approve':
    case 'market_pause_decision_reject':
    case 'market_pause_decision_retract': {
      const parsed = PAUSE_DECISION.safeParse(details);
      return parsed.success
        ? [{ label: copy.pauseLogPath, value: PAUSE_PATH_LABEL[parsed.data.path] }]
        : undefined;
    }
    case 'market_judgement_request':
    case 'market_judgement_reject':
    case 'market_judgement_retract': {
      const parsed = JUDGEMENT_RESULT.safeParse(details);
      if (!parsed.success) return undefined;
      return [
        { label: copy.marketResolvedResult, value: MARKET_RESULT_LABEL[parsed.data.result] },
        ...correctionRows(type, details),
      ];
    }
    case 'market_judgement_approve': {
      const parsed = JUDGEMENT_APPROVE.safeParse(details);
      if (!parsed.success) return undefined;
      return [
        { label: copy.eventJudgementVersion, value: judgementVersionName(parsed.data.version) },
        { label: copy.marketResolvedResult, value: MARKET_RESULT_LABEL[parsed.data.result] },
        { label: copy.eventDisputeDeadline, value: formatKst(parsed.data.disputeDeadline) },
        ...correctionRows(type, details),
      ];
    }
    case 'market_dispute_dismiss':
    case 'market_dispute_accept': {
      const parsed = DISPUTE_DECISION.safeParse(details);
      return parsed.success
        ? [
            {
              label: copy.eventJudgementVersion,
              value: judgementVersionName(parsed.data.judgementVersion),
            },
          ]
        : undefined;
    }
    case 'market_delay_record': {
      const parsed = DELAY_RECORD.safeParse(details);
      if (!parsed.success) return undefined;
      return [
        { label: copy.eventNextReviewAt, value: formatKst(parsed.data.nextReviewAt) },
        {
          label: copy.adminMarketJudgementDelayEpisode,
          value: judgementDelayEpisodeText(parsed.data),
        },
      ];
    }
    case 'market_reject': {
      const parsed = MARKET_REJECT.safeParse(details);
      return parsed.success
        ? [
            {
              label: copy.reviewLogRejectReason,
              value: REJECT_REASON_LABEL[parsed.data.rejectReason],
            },
          ]
        : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * An entry's details as rows: an event's as the event log reads them (`marketEventRows`), an
 * action's (`actionRows`), none for the step record (its attempts and error are its reason).
 * `undefined` when the shape is not one of those: shown as JSON instead.
 */
export function marketWorkRows(
  entry: Pick<AdminMarketWorkEntry, 'type' | 'source' | 'details'>,
): EventRow[] | undefined {
  if (entry.source === 'settlement_step') return [];
  if (isMarketEventType(entry.type)) return marketEventRows(entry.type, entry.details);
  if (entry.type === 'settlement_step') return [];
  return actionRows(entry.type, entry.details);
}

/**
 * The details as one JSON line when no rows read them, without what the row already says: the
 * reason the reason column shows, and a failed retry's error, drawn on its own (`retryErrorOf`).
 * Empty when nothing is left.
 */
export function marketWorkDetailsJson(
  entry: Pick<AdminMarketWorkEntry, 'type' | 'details' | 'reason'>,
): string {
  const rest = Object.fromEntries(
    Object.entries(recordOf(entry.details)).filter(
      ([key, value]) =>
        !(entry.reason !== null && value === entry.reason) &&
        !(entry.type === 'market_settlement_retry' && key === 'error'),
    ),
  );
  return Object.keys(rest).length === 0 ? '' : compactJson(rest);
}

/** A failed 정산 다시 시도's stored error (145-7), drawn as the 마지막 오류 is (145-18). */
export function retryErrorOf(entry: Pick<AdminMarketWorkEntry, 'type' | 'details'>): string | null {
  const error = entry.details.error;
  return entry.type === 'market_settlement_retry' && typeof error === 'string' && error !== ''
    ? error
    : null;
}
