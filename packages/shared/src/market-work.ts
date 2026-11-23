import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { pageEnvelope } from './api/envelope.js';
import { cursorQuerySchema } from './api/pagination.js';
import {
  ADMIN_ACTION_TYPES,
  MARKET_EVENT_TYPES,
  settlementStepStatusSchema,
  type AdminActionType,
  type MarketEventType,
} from './enums.js';

/*
 * 시장별 작업 이력 (#145 part 2, ADR-0164; 145-5, 145-6, 145-7, 145-12, 145-13, 145-16): one list,
 * oldest first, of a market's operator work — the admin actions bound to it, approval requests and
 * decisions among them — and the worker's processing as '시스템' (145-6), filtered by the five kinds
 * 145-5 names. The classification is shared and exhaustive: a new ADMIN_ACTION_TYPES value fails
 * to compile until it is classified (MARKET_WORK_ACTION_KIND) or excluded with its reason
 * (MARKET_WORK_EXCLUDED_ACTIONS), and a new MARKET_EVENT_TYPES value until MARKET_EVENT_WORK
 * names it. The reader is @buddha/db `market-work.ts`, in a READ ONLY transaction (AC 3).
 *
 * 카테고리 변경 기록 (145-10, ADR-0096 결과 5): the category records under `/admin/categories`,
 * newest first — the shapes are at the end of this file.
 */

// ---- kinds (145-5, 145-12) -----------------------------------------------------------
/** 145-5's filter, in screen order: 수정·중단·판정·지급·그 밖. */
export const MARKET_WORK_KINDS = ['edit', 'pause', 'judgement', 'settlement', 'other'] as const;
export type MarketWorkKind = (typeof MARKET_WORK_KINDS)[number];

/**
 * Every admin action type the history shows, and its kind — exactly 145-12's table:
 * - 수정: 초안 만들기·수정, 개장 뒤 카테고리·태그·이미지와 유동성 설정 (`market_update`), 규칙 보충, 가격
 *   보호 폭;
 * - 중단: 일시 중단, 재개·조기 마감의 요청과 결정;
 * - 판정: 판정 등록·승인·반려·철회(정정 포함), 이의 기각·수용, 판정 지연 기록, 이해충돌 신고, the
 *   retired interim judgement, and 판정 오류 사건의 등록·오류 확인·기각·철회 (#144, ADR-0165 —
 *   a judgement's review after the payout);
 * - 지급: 정산 다시 시도 (145-7), 대사 보류 복구 (145-12 "대사 보류 복구는 지급");
 * - 그 밖: 개설 검수 (제출·승인·반려·되돌림·일정 변경), 취소, 관련 시장, 대사 실행, 비정상 체결 분류,
 *   시장 제안 채택·연결, and the retired interim open and one-admin close.
 * Which of these are bound to a market by something other than their target (145-13: the other
 * end of a link, the market's reconciliation runs and hold recoveries, its fills'
 * classifications, a linked proposal) is the reader's (@buddha/db `market-work.ts`).
 */
export const MARKET_WORK_ACTION_KIND = {
  market_create: 'edit',
  market_update: 'edit',
  market_supplement_request: 'edit',
  market_supplement_approve: 'edit',
  market_supplement_reject: 'edit',
  market_supplement_retract: 'edit',
  market_price_protection_change: 'edit',
  market_pause: 'pause',
  market_pause_decision_request: 'pause',
  market_pause_decision_approve: 'pause',
  market_pause_decision_reject: 'pause',
  market_pause_decision_retract: 'pause',
  market_judgement_request: 'judgement',
  market_judgement_approve: 'judgement',
  market_judgement_reject: 'judgement',
  market_judgement_retract: 'judgement',
  market_dispute_dismiss: 'judgement',
  market_dispute_accept: 'judgement',
  market_delay_record: 'judgement',
  market_conflict_declare: 'judgement',
  market_resolve: 'judgement',
  market_judgement_incident_register: 'judgement',
  market_judgement_incident_confirm: 'judgement',
  market_judgement_incident_dismiss: 'judgement',
  market_judgement_incident_retract: 'judgement',
  market_settlement_retry: 'settlement',
  reconciliation_recovery_request: 'settlement',
  reconciliation_recovery_approve: 'settlement',
  reconciliation_recovery_reject: 'settlement',
  reconciliation_recovery_retract: 'settlement',
  market_submit: 'other',
  market_approve: 'other',
  market_reject: 'other',
  market_revert: 'other',
  market_reschedule: 'other',
  market_cancel_request: 'other',
  market_cancel_approve: 'other',
  market_cancel_reject: 'other',
  market_cancel_retract: 'other',
  market_link: 'other',
  market_unlink: 'other',
  reconciliation_run: 'other',
  fill_classification_request: 'other',
  fill_classification_approve: 'other',
  fill_classification_reject: 'other',
  fill_classification_retract: 'other',
  proposal_adopt: 'other',
  proposal_link: 'other',
  market_open: 'other',
  market_close: 'other',
} as const satisfies Partial<Record<AdminActionType, MarketWorkKind>>;
export type MarketWorkActionType = keyof typeof MARKET_WORK_ACTION_KIND;

/**
 * Every other admin action type, with why the history leaves it out (145-13: 테마·봇·게시글 운영
 * 조치는 뺀다). A type in neither map, or in both, does not compile.
 */
export const MARKET_WORK_EXCLUDED_ACTIONS: Readonly<
  Record<Exclude<AdminActionType, MarketWorkActionType>, string>
> = {
  market_maker_control_request: 'bot control: the market maker screen alone (145-5)',
  market_maker_control_approve: 'bot control: the market maker screen alone (145-5)',
  market_maker_control_reject: 'bot control: the market maker screen alone (145-5)',
  market_maker_control_retract: 'bot control: the market maker screen alone (145-5)',
  treasury_issue_request: 'treasury issue: no market',
  treasury_issue_approve: 'treasury issue: no market',
  treasury_issue_reject: 'treasury issue: no market',
  treasury_issue_retract: 'treasury issue: no market',
  reconciliation_correction_request: "a correction of a person's ledger account, not a market",
  reconciliation_correction_approve: "a correction of a person's ledger account, not a market",
  reconciliation_correction_reject: "a correction of a person's ledger account, not a market",
  reconciliation_correction_retract: "a correction of a person's ledger account, not a market",
  charge_package_create: 'catalogue: no market',
  charge_package_update: 'catalogue: no market',
  charge_package_delete: 'catalogue: no market',
  coupon_create: 'catalogue: no market',
  coupon_update: 'catalogue: no market',
  theme_create: 'theme records stay as they are (145-10, 145-13)',
  theme_update: 'theme records stay as they are (145-10, 145-13)',
  theme_publish: 'theme records stay as they are (145-10, 145-13)',
  theme_unpublish: 'theme records stay as they are (145-10, 145-13)',
  theme_market_link: 'theme records stay as they are (145-10, 145-13)',
  theme_market_unlink: 'theme records stay as they are (145-10, 145-13)',
  theme_notice_create: 'theme records stay as they are (145-10, 145-13)',
  theme_notice_update: 'theme records stay as they are (145-10, 145-13)',
  theme_notice_hide: 'theme records stay as they are (145-10, 145-13)',
  theme_notice_show: 'theme records stay as they are (145-10, 145-13)',
  category_create: 'the category list: its own change records on /admin/categories (145-10)',
  category_rename: 'the category list: its own change records on /admin/categories (145-10)',
  category_reorder: 'the category list: its own change records on /admin/categories (145-10)',
  category_hide: 'the category list: its own change records on /admin/categories (145-10)',
  category_show: 'the category list: its own change records on /admin/categories (145-10)',
  payment_refund: 'a refund: no market',
  release_setting_change: 'a release setting: no market',
  admin_grant: 'an admin role change: no market',
  admin_revoke: 'an admin role change: no market',
  notice_create: 'an operations notice: no market',
  notice_update: 'an operations notice: no market',
  notice_pin: 'an operations notice: no market',
  notice_unpin: 'an operations notice: no market',
  moderation_post_hide: 'post and comment moderation stays in /admin/moderation (145-13)',
  moderation_comment_hide: 'post and comment moderation stays in /admin/moderation (145-13)',
  moderation_warning: 'member moderation: a person, not a market (145-13)',
  moderation_nickname_reset: 'member moderation: a person, not a market (145-13)',
  moderation_bio_clear: 'member moderation: a person, not a market (145-13)',
  moderation_image_remove: 'member moderation: a person, not a market (145-13)',
  moderation_cancel: 'member moderation: a person, not a market (145-13)',
  report_dismiss: 'report handling stays in /admin/moderation (145-13)',
  moderation_writing_restriction: 'member moderation: a person, not a market (145-13)',
  moderation_restriction_shorten: 'member moderation: a person, not a market (145-13)',
  moderation_restriction_lift: 'member moderation: a person, not a market (145-13)',
  link_flag_review: 'a link review: no market',
  account_restriction_request: 'an account restriction: a person, not a market',
  account_restriction_shorten_request: 'an account restriction: a person, not a market',
  account_restriction_lift_request: 'an account restriction: a person, not a market',
  account_restriction_cancel_request: 'an account restriction: a person, not a market',
  account_restriction_approve: 'an account restriction: a person, not a market',
  account_restriction_reject: 'an account restriction: a person, not a market',
  account_restriction_retract: 'an account restriction: a person, not a market',
  proposal_review: 'a proposal step that links no market (145-13 shows the linked proposal only)',
  proposal_reject: 'a proposal step that links no market (145-13 shows the linked proposal only)',
  proposal_memo: 'a proposal step that links no market (145-13 shows the linked proposal only)',
};

/** The shown admin action types, in ADMIN_ACTION_TYPES order. */
export const MARKET_WORK_ACTION_TYPES = ADMIN_ACTION_TYPES.filter(
  (type): type is MarketWorkActionType => Object.hasOwn(MARKET_WORK_ACTION_KIND, type),
) as unknown as readonly [MarketWorkActionType, ...MarketWorkActionType[]];

export const isMarketWorkActionType = (type: string): type is MarketWorkActionType =>
  Object.hasOwn(MARKET_WORK_ACTION_KIND, type);

/**
 * When a market event is read, and its kind (145-6: the worker's processing, actor '시스템').
 * - `system`: only with no actor. Every event an admin writes is the twin of an admin action in
 *   the same transaction (market-admin, market-pause, market-judgement, market-cancel services),
 *   and the history reads one source per fact — the action. With no actor: 예약 개장 `opened`,
 *   거래 마감 `closed` (a PAUSED market's too), 자동 취소 `cancelled`, 결과 확정 `resolved`, 지급
 *   시작·완료 `settling`/`finalized`, 원장 불일치 자동 중단 `paused` (`ledger_failure`).
 * - `always`: `opened` also with an admin actor when its `source` is `approval` or
 *   `reschedule` — an approval or a reschedule that found the scheduled open already come opens
 *   at once with no admin action of its own (#21). A pre-#21 `opened` (no `source`) is the twin of
 *   the retired `market_open` and is not read.
 */
export type MarketEventShown = 'system' | 'always';

export const MARKET_EVENT_WORK: Readonly<
  Record<MarketEventType, { kind: MarketWorkKind; shown: MarketEventShown }>
> = {
  created: { kind: 'edit', shown: 'system' },
  submitted: { kind: 'other', shown: 'system' },
  approved: { kind: 'other', shown: 'system' },
  rejected: { kind: 'other', shown: 'system' },
  reverted: { kind: 'other', shown: 'system' },
  open_rescheduled: { kind: 'other', shown: 'system' },
  opened: { kind: 'other', shown: 'always' },
  closed: { kind: 'other', shown: 'system' },
  finalized: { kind: 'settlement', shown: 'system' },
  rules_edited: { kind: 'edit', shown: 'system' },
  resolved: { kind: 'judgement', shown: 'system' },
  settling: { kind: 'settlement', shown: 'system' },
  rules_supplemented: { kind: 'edit', shown: 'system' },
  paused: { kind: 'pause', shown: 'system' },
  resumed: { kind: 'pause', shown: 'system' },
  provisional: { kind: 'judgement', shown: 'system' },
  judgement_corrected: { kind: 'judgement', shown: 'system' },
  judgement_delay_recorded: { kind: 'judgement', shown: 'system' },
  price_protection_changed: { kind: 'edit', shown: 'system' },
  cancelled: { kind: 'other', shown: 'system' },
};

/** The `opened` sources an admin actor writes with no admin action of its own (#21). */
export const MARKET_WORK_OPENED_ADMIN_SOURCES = ['approval', 'reschedule'] as const;

export const isMarketEventType = (type: string): type is MarketEventType =>
  (MARKET_EVENT_TYPES as readonly string[]).includes(type);

/**
 * The settlement step's failure record (145-6 "정산 실패는 시도 횟수와 마지막 오류를 보인다"): one
 * entry per step whose `last_error` is set, at its last update, kind 지급.
 */
export const MARKET_WORK_STEP_TYPE = 'settlement_step';

/** Every `type` an entry can carry: the shown actions, every event type, the step record. */
export const MARKET_WORK_ENTRY_TYPES = [
  ...MARKET_WORK_ACTION_TYPES,
  ...MARKET_EVENT_TYPES,
  MARKET_WORK_STEP_TYPE,
] as const;
export type MarketWorkEntryType = MarketWorkActionType | MarketEventType | 'settlement_step';

/** An entry type's kind. */
export function marketWorkKindOf(type: MarketWorkEntryType): MarketWorkKind {
  if (type === MARKET_WORK_STEP_TYPE) return 'settlement';
  if (isMarketEventType(type)) return MARKET_EVENT_WORK[type].kind;
  return MARKET_WORK_ACTION_KIND[type];
}

/** The action types of one kind, or every shown one (no kind: 전체). */
export function marketWorkActionTypesOf(kind?: MarketWorkKind): MarketWorkActionType[] {
  return MARKET_WORK_ACTION_TYPES.filter(
    (type) => kind === undefined || MARKET_WORK_ACTION_KIND[type] === kind,
  );
}

/** The event types of one kind, or every one (no kind: 전체). */
export function marketWorkEventTypesOf(kind?: MarketWorkKind): MarketEventType[] {
  return MARKET_EVENT_TYPES.filter(
    (type) => kind === undefined || MARKET_EVENT_WORK[type].kind === kind,
  );
}

/**
 * Where an entry comes from, in the order of the tie-break `sourceOrder` (the index): an event and
 * its transaction's admin action share `created_at`, so the system fact sorts first.
 */
export const MARKET_WORK_SOURCES = ['market_event', 'admin_action', 'settlement_step'] as const;
export type MarketWorkSource = (typeof MARKET_WORK_SOURCES)[number];

// ---- reason (145-16) -----------------------------------------------------------------
/**
 * What stands for an entry's reason (145-16 "작업별 근거 표시 — 새 사유 칸은 만들지 않는다"):
 * - `recorded`: the stored reason (판정 등록: its 설명; 일시 중단: its note, the reason code being
 *   in the details; 유동성 설정: its reason);
 * - `changed_items`: 초안 만들기·수정·검수 제출 and 개장 뒤 카테고리·태그·이미지 수정 — the changes
 *   ('바뀐 항목', 항목: 이전 → 새; ADR-0093 결정 3 #78, #172 14항);
 * - `actor_time`: 관련 시장, 시장 제안 채택·연결, 대사 실행 — 담당자와 시각만 (ADR-0068, ADR-0119);
 * - `retracted`: 요청 철회 — the reason is on the request's own entry;
 * - `system`: the worker's processing — the rule is the reason (the web names it from the type
 *   and the details; the no-fill cancel's stored sentence is returned as is).
 */
export const MARKET_WORK_REASON_BASES = [
  'recorded',
  'changed_items',
  'actor_time',
  'retracted',
  'system',
] as const;
export type MarketWorkReasonBasis = (typeof MARKET_WORK_REASON_BASES)[number];

/**
 * Each shown action's basis (145-16). `market_update` is `changed_items` for a snapshot edit and
 * `recorded` for a liquidity setting (payload `{liquidity, reason}`, no snapshots) —
 * `marketWorkReasonOf` tells them apart. The retired `market_open`/`market_close` took no reason
 * (ADR-0027): `actor_time`.
 */
export const MARKET_WORK_ACTION_REASON: Readonly<
  Record<MarketWorkActionType, Exclude<MarketWorkReasonBasis, 'system'>>
> = {
  market_create: 'changed_items',
  market_update: 'changed_items',
  market_supplement_request: 'recorded',
  market_supplement_approve: 'recorded',
  market_supplement_reject: 'recorded',
  market_supplement_retract: 'retracted',
  market_price_protection_change: 'recorded',
  market_pause: 'recorded',
  market_pause_decision_request: 'recorded',
  market_pause_decision_approve: 'recorded',
  market_pause_decision_reject: 'recorded',
  market_pause_decision_retract: 'retracted',
  market_judgement_request: 'recorded',
  market_judgement_approve: 'recorded',
  market_judgement_reject: 'recorded',
  market_judgement_retract: 'retracted',
  market_dispute_dismiss: 'recorded',
  market_dispute_accept: 'recorded',
  market_delay_record: 'recorded',
  market_conflict_declare: 'recorded',
  market_resolve: 'recorded',
  market_judgement_incident_register: 'recorded',
  market_judgement_incident_confirm: 'recorded',
  market_judgement_incident_dismiss: 'recorded',
  market_judgement_incident_retract: 'retracted',
  market_settlement_retry: 'recorded',
  reconciliation_recovery_request: 'recorded',
  reconciliation_recovery_approve: 'recorded',
  reconciliation_recovery_reject: 'recorded',
  reconciliation_recovery_retract: 'retracted',
  market_submit: 'changed_items',
  market_approve: 'recorded',
  market_reject: 'recorded',
  market_revert: 'recorded',
  market_reschedule: 'recorded',
  market_cancel_request: 'recorded',
  market_cancel_approve: 'recorded',
  market_cancel_reject: 'recorded',
  market_cancel_retract: 'retracted',
  market_link: 'actor_time',
  market_unlink: 'actor_time',
  reconciliation_run: 'actor_time',
  fill_classification_request: 'recorded',
  fill_classification_approve: 'recorded',
  fill_classification_reject: 'recorded',
  fill_classification_retract: 'retracted',
  proposal_adopt: 'actor_time',
  proposal_link: 'actor_time',
  market_open: 'actor_time',
  market_close: 'actor_time',
};

/**
 * The payload key a `recorded` action keeps its reason under, where it is not `reason`: 판정
 * 등록's 설명 (145-16 "판정 등록은 그 설명") and a 판정 오류 사건 등록's 오류 내용 alike (#144), a
 * pause's note (its `reason` is the code), the retired interim judgement's note.
 */
const RECORDED_REASON_KEY: Partial<Record<MarketWorkActionType, string>> = {
  market_judgement_request: 'description',
  market_judgement_incident_register: 'description',
  market_pause: 'note',
  market_resolve: 'note',
};

export interface MarketWorkReason {
  reason: string | null;
  reasonBasis: MarketWorkReasonBasis;
}

const recordOf = (payload: unknown): Record<string, unknown> =>
  typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/** A liquidity setting's `market_update` (market-admin.service.ts): `{liquidity, reason}`. */
const isLiquidityUpdate = (payload: Record<string, unknown>): boolean =>
  typeof payload.liquidity === 'object' && payload.liquidity !== null;

/**
 * Whether a 판정 action is a 판정 정정's (#176, ADR-0105; 145-12 "판정 등록·승인·반려·철회·정정"):
 * the registration and its approval carry a non-null `correction` (`{baseVersion, reason,
 * disputeIds}`), a correction's 반려 and 철회 the `reopenedDisputeIds` a first judgement's never
 * has (market-judgement.service.ts).
 */
export function isJudgementCorrection(type: MarketWorkEntryType, payload: unknown): boolean {
  const fields = recordOf(payload);
  switch (type) {
    case 'market_judgement_request':
    case 'market_judgement_approve':
      return (
        typeof fields.correction === 'object' &&
        fields.correction !== null &&
        !Array.isArray(fields.correction)
      );
    case 'market_judgement_reject':
    case 'market_judgement_retract':
      return Array.isArray(fields.reopenedDisputeIds);
    default:
      return false;
  }
}

/**
 * An entry's reason and what stands for it (145-16). A `recorded` row whose reason is missing
 * (an old row) answers null with the basis kept. A 판정 등록 — a 판정 정정's (#176) too, the same
 * registration — stands on its 설명 (145-16 "판정 등록은 그 설명"); a correction's 정정 사유 is
 * one of its details.
 */
export function marketWorkReasonOf(type: MarketWorkEntryType, payload: unknown): MarketWorkReason {
  const fields = recordOf(payload);
  if (type === MARKET_WORK_STEP_TYPE) return { reason: null, reasonBasis: 'system' };
  if (isMarketEventType(type)) {
    // The no-fill cancel's fixed sentence (MARKET_NO_FILL_CANCEL_REASON) is stored on the event.
    return { reason: type === 'cancelled' ? textOf(fields.reason) : null, reasonBasis: 'system' };
  }
  if (type === 'market_update' && isLiquidityUpdate(fields)) {
    return { reason: textOf(fields.reason), reasonBasis: 'recorded' };
  }
  const basis = MARKET_WORK_ACTION_REASON[type];
  if (basis !== 'recorded') return { reason: null, reasonBasis: basis };
  return { reason: textOf(fields[RECORDED_REASON_KEY[type] ?? 'reason']), reasonBasis: basis };
}

// ---- changes (145-16 '바뀐 항목') ------------------------------------------------------
/**
 * The keys of `market_update`'s snapshot (apps/api market-admin.service.ts `snapshot()`) the
 * history compares, in its order: what an operator edits — the title and slug, the rule items,
 * the category, tags and image, the times, the lead-close gap, 가격 보호 폭 and the liquidity
 * version. The rest (MARKET_SNAPSHOT_IGNORED_FIELDS) move with trading or the status and are
 * never a '바뀐 항목'. Every snapshot key is in exactly one list (the shared test and the api's
 * snapshot test pin it).
 */
export const MARKET_SNAPSHOT_CHANGE_FIELDS = [
  'slug',
  'title',
  'description',
  'yesCondition',
  'noCondition',
  'eventDeadline',
  'primarySource',
  'fallbackSources',
  'fallbackCondition',
  'longDelayDays',
  'delayHandling',
  'categoryId',
  'tags',
  'imageUrl',
  'scheduledOpenAt',
  'scheduledAnnouncementAt',
  'scheduledJudgementAt',
  'judgementTimeZone',
  'closeAt',
  'leadCloseGapMinutes',
  'priceProtectionTicks',
  'currentLiquidityVersion',
] as const;
export type MarketSnapshotChangeField = (typeof MARKET_SNAPSHOT_CHANGE_FIELDS)[number];

/** The snapshot keys that move with trades, statistics or the status: never a change. */
export const MARKET_SNAPSHOT_IGNORED_FIELDS = [
  'status',
  'lastPrice',
  'volumeCoin',
  'tradeCount',
  'traderCount',
  'statsRevision',
  'openAt',
  'openedLiquidityVersion',
] as const;

/**
 * One compared field that moved, its stored values before and after — except `categoryId`, whose
 * ids the reader turns into the categories by their CURRENT name, `AdminCategoryRef` `{id,
 * nameKo}` or null (no screen shows a category's id; the category records do the same).
 */
export const marketWorkChangeSchema = z
  .object({
    field: z.enum(MARKET_SNAPSHOT_CHANGE_FIELDS),
    before: z.unknown(),
    after: z.unknown(),
  })
  .meta({ id: 'AdminMarketWorkChange' });
export type MarketWorkChange = z.infer<typeof marketWorkChangeSchema>;

const isSnapshot = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A value that says nothing on its own: null, missing, blank text or an empty list. */
const isBlank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The compared fields that differ between two snapshots, in MARKET_SNAPSHOT_CHANGE_FIELDS order.
 * With no `before` (초안 만들기, 검수 제출: `{after}` alone) every compared field `after` fills in
 * is a change from null. No `after` snapshot (a liquidity setting, a payload of scalars) → [].
 */
export function marketSnapshotChanges(before: unknown, after: unknown): MarketWorkChange[] {
  if (!isSnapshot(after)) return [];
  const prior = isSnapshot(before) ? before : null;
  return MARKET_SNAPSHOT_CHANGE_FIELDS.flatMap((field) => {
    const next = after[field] ?? null;
    if (prior === null) return isBlank(next) ? [] : [{ field, before: null, after: next }];
    const previous = prior[field] ?? null;
    return sameValue(previous, next) ? [] : [{ field, before: previous, after: next }];
  });
}

/**
 * An action's stored payload as the entry's `details`: without `before`/`after` market snapshots
 * (they carry every rule text, up to MARKET_TEXT_MAX each — the entry's `changes` say what moved),
 * keeping scalar `before`/`after` (a reschedule's instants, a price protection's widths).
 */
export function marketWorkDetailsOf(payload: unknown): {
  details: Record<string, unknown>;
  changes: MarketWorkChange[];
} {
  const { before, after, ...rest } = recordOf(payload);
  if (!isSnapshot(after)) {
    const kept = { ...rest };
    if (before !== undefined) kept.before = before;
    if (after !== undefined) kept.after = after;
    return { details: kept, changes: [] };
  }
  return { details: rest, changes: marketSnapshotChanges(before, after) };
}

// ---- entry (AdminMarketWorkEntry) ----------------------------------------------------
/** `GET /admin/markets/:id/work-history`: a cursor page, every kind or one (145-5). */
export const adminMarketWorkQuerySchema = cursorQuerySchema.extend({
  kind: z.enum(MARKET_WORK_KINDS).optional(),
});
export type AdminMarketWorkQuery = z.infer<typeof adminMarketWorkQuerySchema>;

/** The step's failure record (145-6): its status, attempts, stored error and completion. */
export const adminMarketWorkSettlementSchema = z
  .object({
    stepStatus: settlementStepStatusSchema,
    settlementAttempts: z.number().int().min(0),
    settlementLastError: z.string(),
    completedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'AdminMarketWorkSettlement' });
export type AdminMarketWorkSettlement = z.infer<typeof adminMarketWorkSettlementSchema>;

/** The other end of a 관련 시장 link: its id and current title. */
export const adminMarketWorkRelatedMarketSchema = z
  .object({ id: z.uuid(), title: z.string() })
  .meta({ id: 'AdminMarketWorkRelatedMarket' });

/** A 정산 다시 시도's result (145-7 "결과(성공·실패)가 작업 이력에 남는다"). */
export const MARKET_WORK_RETRY_OUTCOMES = ['settled', 'failed'] as const;

/**
 * One entry of a market's history, oldest first (145-5 "시각 순").
 * - `id`: opaque — `a:<admin action uuid>`, `e:<market event id>`, `s:<step>`;
 * - `actor`: the admin (nickname null for a closed account), or null for '시스템' (145-6);
 * - `reason`/`reasonBasis`: 145-16 (`marketWorkReasonOf`);
 * - `details`: the stored payload without market snapshots (`marketWorkDetailsOf`), `{step}` for
 *   the step record; `changes`: the compared snapshot fields that moved;
 * - `relatedMarket`: a link's other end; `settlement`: the step record's; `retryOutcome`: a
 *   `market_settlement_retry`'s.
 */
export const adminMarketWorkEntrySchema = z
  .object({
    id: z.string(),
    source: z.enum(MARKET_WORK_SOURCES),
    type: z.enum(MARKET_WORK_ENTRY_TYPES),
    kind: z.enum(MARKET_WORK_KINDS),
    at: z.iso.datetime(),
    actor: adminAccountActorSchema.nullable(),
    reason: z.string().nullable(),
    reasonBasis: z.enum(MARKET_WORK_REASON_BASES),
    details: z.record(z.string(), z.unknown()),
    changes: z.array(marketWorkChangeSchema),
    relatedMarket: adminMarketWorkRelatedMarketSchema.nullable(),
    settlement: adminMarketWorkSettlementSchema.nullable(),
    retryOutcome: z.enum(MARKET_WORK_RETRY_OUTCOMES).nullable(),
  })
  .meta({ id: 'AdminMarketWorkEntry' });
export type AdminMarketWorkEntry = z.infer<typeof adminMarketWorkEntrySchema>;

export const adminMarketWorkPageSchema = pageEnvelope(adminMarketWorkEntrySchema);
export type AdminMarketWorkPage = z.infer<typeof adminMarketWorkPageSchema>;

// ---- 카테고리 변경 기록 (145-10) --------------------------------------------------------
/** The category records `/admin/categories` lists (ADR-0096 결과 5). */
export const CATEGORY_CHANGE_TYPES = [
  'category_create',
  'category_rename',
  'category_reorder',
  'category_hide',
  'category_show',
] as const satisfies readonly AdminActionType[];
export type CategoryChangeType = (typeof CATEGORY_CHANGE_TYPES)[number];

/** `GET /admin/categories/changes`: a cursor page, newest first. */
export const adminCategoryChangesQuerySchema = cursorQuerySchema;
export type AdminCategoryChangesQuery = z.infer<typeof adminCategoryChangesQuerySchema>;

/**
 * A category a record names, by its CURRENT name (one lookup per page; a category is never
 * deleted, `nameKo` null only for an id the table no longer holds).
 */
export const adminCategoryRefSchema = z
  .object({ id: z.number().int(), nameKo: z.string().nullable() })
  .meta({ id: 'AdminCategoryRef' });
export type AdminCategoryRef = z.infer<typeof adminCategoryRefSchema>;

const categoryChangeBase = {
  id: z.uuid(),
  at: z.iso.datetime(),
  actor: adminAccountActorSchema,
  /** The record's target: the category, or a reorder's parent (null for the top level). */
  category: adminCategoryRefSchema.nullable(),
};

const visibilityDetails = z.object({ before: z.boolean(), after: z.boolean() });

/**
 * One category record (145-10 "추가·이름·순서·숨김의 담당자·시각·전후 값"): 추가 with its name and
 * parent, 이름 바꾸기 with the names as stored before and after, 순서 바꾸기 with the group's order
 * before and after (current names), 숨기기·다시 보이기 with the flag before and after.
 */
export const adminCategoryChangeSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        ...categoryChangeBase,
        type: z.literal('category_create'),
        details: z.object({ nameKo: z.string(), parent: adminCategoryRefSchema.nullable() }),
      })
      .meta({ id: 'AdminCategoryCreated' }),
    z
      .object({
        ...categoryChangeBase,
        type: z.literal('category_rename'),
        details: z.object({ before: z.string(), after: z.string() }),
      })
      .meta({ id: 'AdminCategoryRenamed' }),
    z
      .object({
        ...categoryChangeBase,
        type: z.literal('category_reorder'),
        details: z.object({
          parent: adminCategoryRefSchema.nullable(),
          before: z.array(adminCategoryRefSchema),
          after: z.array(adminCategoryRefSchema),
        }),
      })
      .meta({ id: 'AdminCategoryReordered' }),
    z
      .object({
        ...categoryChangeBase,
        type: z.literal('category_hide'),
        details: visibilityDetails,
      })
      .meta({ id: 'AdminCategoryHidden' }),
    z
      .object({
        ...categoryChangeBase,
        type: z.literal('category_show'),
        details: visibilityDetails,
      })
      .meta({ id: 'AdminCategoryShown' }),
  ])
  .meta({ id: 'AdminCategoryChange' });
export type AdminCategoryChange = z.infer<typeof adminCategoryChangeSchema>;

export const adminCategoryChangePageSchema = pageEnvelope(adminCategoryChangeSchema);
export type AdminCategoryChangePage = z.infer<typeof adminCategoryChangePageSchema>;
