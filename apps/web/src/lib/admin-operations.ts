import {
  OPERATIONS_CLOSING_WINDOWS,
  OPERATIONS_CLOSING_WINDOW_DEFAULT,
  OPERATIONS_JUDGEMENT_FILTERS,
  type OperationsClosingWindow,
  type OperationsFailureKind,
  type OperationsJudgementFilter,
  type OperationsJudgementStage,
  type OperationsRecallFailureReason,
  type OperationsStuckStage,
} from '@buddha/shared';
import type { Route } from 'next';
import { copy } from '@/copy';
import {
  type AdminAwaitingJudgementMarket,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
} from './api';
import { formatKst } from './datetime';

/**
 * 운영 대기열 (#145 part 1, ADR-0163): `/admin/operations`, one list per screen picked by `?list=`
 * — 마감 예정 (145-1, its window by `?within=`), 판정 대기·지연 (145-2, '지연만' by `?filter=`) and 정산
 * 실패 with 처리 멈춤 and 봇 자금 회수 실패 (145-4, 145-8, 145-15) — the words each list draws, where
 * each row links, and what a refused 정산 다시 시도 says (145-7, 145-14). Admin-only
 * (excluded-features.test.ts): the payout's attempts and error and the recall's are no member's
 * (the PRIVATE_DATA item `operation-records`, #171 AC 8).
 */

export const ADMIN_OPERATIONS_PATH = '/admin/operations' satisfies Route;

/** The three lists, in tab order. 마감 예정 is the default (the bare path). */
export const ADMIN_OPERATIONS_LISTS = ['closing', 'judgements', 'failures'] as const;
export type AdminOperationsList = (typeof ADMIN_OPERATIONS_LISTS)[number];

/** The query parameters naming the list, 마감 예정's window and 판정 대기·지연's filter. */
export const ADMIN_OPERATIONS_PARAMS = {
  list: 'list',
  within: 'within',
  filter: 'filter',
} as const;

/** What one screen of 운영 대기열 shows: the list and its sub-choice (the other one at its default). */
export interface AdminOperationsView {
  list: AdminOperationsList;
  within: OperationsClosingWindow;
  filter: OperationsJudgementFilter;
}

type Param = string | string[] | null | undefined;

/** The list a `?list=` names, else 마감 예정. */
export function adminOperationsListOf(param: Param): AdminOperationsList {
  return ADMIN_OPERATIONS_LISTS.find((list) => list === param) ?? 'closing';
}

/** The window a `?within=` names, else 24시간 (145-1 "처음 값은 24시간이다"). */
export function adminOperationsWithinOf(param: Param): OperationsClosingWindow {
  return (
    OPERATIONS_CLOSING_WINDOWS.find((within) => within === param) ??
    OPERATIONS_CLOSING_WINDOW_DEFAULT
  );
}

/** The filter a `?filter=` names, else 전체. */
export function adminOperationsFilterOf(param: Param): OperationsJudgementFilter {
  return OPERATIONS_JUDGEMENT_FILTERS.find((filter) => filter === param) ?? 'all';
}

/** The screen the page's `searchParams` name; an unknown value reads as its default. */
export function adminOperationsViewOf(params: {
  list?: Param;
  within?: Param;
  filter?: Param;
}): AdminOperationsView {
  return {
    list: adminOperationsListOf(params.list),
    within: adminOperationsWithinOf(params.within),
    filter: adminOperationsFilterOf(params.filter),
  };
}

/**
 * The address of one screen: the bare path for 마감 예정 in 24시간, and only the parameters that
 * differ from their default — a sub-choice belongs to its own list, so another list's is dropped.
 */
export function adminOperationsPath({
  list,
  within = OPERATIONS_CLOSING_WINDOW_DEFAULT,
  filter = 'all',
}: {
  list: AdminOperationsList;
  within?: OperationsClosingWindow;
  filter?: OperationsJudgementFilter;
}): string {
  const query = new URLSearchParams();
  if (list !== 'closing') query.set(ADMIN_OPERATIONS_PARAMS.list, list);
  if (list === 'closing' && within !== OPERATIONS_CLOSING_WINDOW_DEFAULT) {
    query.set(ADMIN_OPERATIONS_PARAMS.within, within);
  }
  if (list === 'judgements' && filter !== 'all') query.set(ADMIN_OPERATIONS_PARAMS.filter, filter);
  const search = query.toString();
  return search === '' ? ADMIN_OPERATIONS_PATH : `${ADMIN_OPERATIONS_PATH}?${search}`;
}

/** Each list's tab name and its empty sentence. */
export const ADMIN_OPERATIONS_LIST_TEXT: Readonly<
  Record<AdminOperationsList, { label: string; empty: string }>
> = {
  closing: { label: copy.adminOperationsClosing, empty: copy.adminOperationsClosingEmpty },
  judgements: { label: copy.adminOperationsJudgements, empty: copy.adminOperationsJudgementsEmpty },
  failures: { label: copy.adminOperationsFailures, empty: copy.adminOperationsFailuresEmpty },
};

/** 마감 예정's windows' names (145-1). */
export const OPERATIONS_WINDOW_LABEL: Readonly<Record<OperationsClosingWindow, string>> = {
  '24h': copy.adminOperationsWithin24h,
  '3d': copy.adminOperationsWithin3d,
  '7d': copy.adminOperationsWithin7d,
};

/** 판정 대기·지연's filters' names (145-2). */
export const OPERATIONS_FILTER_LABEL: Readonly<Record<OperationsJudgementFilter, string>> = {
  all: copy.adminOperationsFilterAll,
  delayed: copy.adminOperationsFilterDelayed,
};

/** Where a 판정 대기·지연 row stands, in 145-11's words. */
export const OPERATIONS_STAGE_LABEL: Readonly<Record<OperationsJudgementStage, string>> = {
  unregistered: copy.adminOperationsStageUnregistered,
  awaiting_approval: copy.adminOperationsStageAwaitingApproval,
  dispute_or_correction: copy.adminOperationsStageDisputeOrCorrection,
};

/** A 정산 실패 row's kind (145-18: the recall's is 145-8's own word). */
export const OPERATIONS_KIND_LABEL: Readonly<Record<OperationsFailureKind, string>> = {
  settlement_failed: copy.adminOperationsKindSettlementFailed,
  stuck: copy.adminOperationsKindStuck,
  recall_failed: copy.adminOperationsKindRecallFailed,
};

/** The four automatic transitions of 145-4. */
export const OPERATIONS_STUCK_STAGE_LABEL: Readonly<Record<OperationsStuckStage, string>> = {
  close: copy.adminOperationsStuckClose,
  confirm: copy.adminOperationsStuckConfirm,
  start: copy.adminOperationsStuckStart,
  complete: copy.adminOperationsStuckComplete,
};

/**
 * What a failed recall's code says: the market maker panel's own sentences (ADR-0125 "알려진 코드만
 * 표시"), so the list and the 회수 칸 it links to never word one code twice.
 */
export const OPERATIONS_RECALL_REASON_TEXT: Readonly<
  Record<OperationsRecallFailureReason, string>
> = {
  books_inconsistent: copy.marketMakerRecallBooks,
  recall_inconsistent: copy.marketMakerRecallBooks,
  execution_failed: copy.marketMakerRecallExecution,
};

/** '처리 멈춤 · 지급 시작'. */
export function stuckStageText(stage: OperationsStuckStage): string {
  return `${copy.adminOperationsKindStuck} · ${OPERATIONS_STUCK_STAGE_LABEL[stage]}`;
}

/** '<due, KST>에 일어났어야 했는데 30분 넘게 그대로입니다'. */
export function stuckSinceText(since: string): string {
  return copy.adminOperationsStuckSince.replace('{time}', formatKst(since));
}

/** '시도 3회'. */
export function attemptsText(attempts: number): string {
  return copy.adminOperationsAttempts.replace('{n}', attempts.toLocaleString('ko-KR'));
}

/**
 * What a 판정 대기·지연 row says when it holds no delay record of its current episode: a CLOSED row
 * has none at all, a PROVISIONAL row none of this judgement version (ADR-0106 결정 10-2 — a record
 * of the CLOSED episode never labels it; the admin detail says the same).
 */
export function noDelayRecordText(row: Pick<AdminAwaitingJudgementMarket, 'status'>): string {
  return row.status === 'closed'
    ? copy.adminOperationsNoDelayRecord
    : copy.adminOperationsNoDelayRecordVersion;
}

/**
 * The 장기 지연 기한 a row shows: a CLOSED row's (145-17 "거래 마감 시장만"), null when it has none
 * (no scheduled judgement or no 장기 지연 days, a pre-#22 market). The instant is the API's
 * `longDelayDeadline` — one function's, ADR-0098 13.
 */
export function shownLongDelayDeadline(
  row: Pick<AdminAwaitingJudgementMarket, 'status' | 'longDelayDeadline'>,
): string | null {
  return row.status === 'closed' ? row.longDelayDeadline : null;
}

// ---- links --------------------------------------------------------------------------

/**
 * The id the 판정 승인 대기 section of `/admin/markets/reviews` carries: the section is rendered on
 * the server, so the browser scrolls to it at load; the lists above it draw after a skeleton and
 * move it, so the page scrolls to it again once they have (`ReviewsHashScroll`).
 */
export const MARKET_JUDGEMENTS_ANCHOR = 'market-judgements';

/**
 * The id the 판정 오류 사건 검토 대기 section of `/admin/markets/reviews` carries (#144, ADR-0165),
 * scrolled to again once the lists above it have drawn (`ReviewsHashScroll`), as the one above.
 */
export const MARKET_JUDGEMENT_INCIDENTS_ANCHOR = 'market-judgement-incidents';

/**
 * The id the market maker panel's 시장 자금 회수 block carries (145-8 "회수 칸으로 연결만"). The admin
 * detail draws after a skeleton, so it scrolls to the hash itself once the block is drawn.
 */
export const MARKET_MAKER_RECALL_ANCHOR = 'market-maker-recall';

/**
 * The `scrollMarginTop` the anchors above carry (Chakra spacing 20 = 80px): a scroll to them
 * stops below the sticky header — row 1 and its rule, 65px on admin screens (`HEADER_HEIGHT_PX`'s
 * note) — rather than under it, as MY 설정's anchors do.
 */
export const ANCHOR_SCROLL_MARGIN_TOP = '20';

/** 판정 승인 대기 on 검수 대기, where a registration or a correction is approved (145-2). */
export const ADMIN_JUDGEMENT_APPROVALS_PATH =
  `/admin/markets/reviews#${MARKET_JUDGEMENTS_ANCHOR}` as Route;

/** 이의 접수, its 검토 대기 half. */
export const ADMIN_DISPUTES_QUEUE_PATH = '/admin/disputes' satisfies Route;

/** 대사 보류 and its recovery (145-3, 145-9). */
export const ADMIN_LEDGER_HOLDS_PATH = '/admin/audit-failures' satisfies Route;

/** A market's processing screen: its admin detail. */
export function adminMarketPath(id: string): Route {
  return `/admin/markets/${id}` as Route;
}

/** The 시장 자금 회수 block of a market's admin detail (145-8). */
export function adminMarketRecallPath(id: string): Route {
  return `/admin/markets/${id}#${MARKET_MAKER_RECALL_ANCHOR}` as Route;
}

/**
 * Where a 판정 대기·지연 row leads besides its detail: 판정 승인 대기 while a registration or a
 * correction waits for another admin (a correction is a `market_judgement` request too), and
 * 이의 접수 while a dispute holds the 잠정 결과.
 */
export function judgementRowLinks(
  row: Pick<AdminAwaitingJudgementMarket, 'stage' | 'holdingDisputes' | 'correctionPending'>,
): { approvals: boolean; disputes: boolean } {
  return {
    approvals: row.stage === 'awaiting_approval' || row.correctionPending,
    disputes: row.stage === 'dispute_or_correction' && row.holdingDisputes > 0,
  };
}

/** The element id a location's hash names (`#market-maker-recall`), or null for none. */
export function hashTargetId(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '') return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ---- 정산 다시 시도 -------------------------------------------------------------------

/**
 * How a 정산 다시 시도 the API refused is said (an attempt that ran answers 200 — `settled` or
 * `failed` — and is never this):
 * - `not_settling`: the market is no longer 지급 중 — another run (the worker's, another admin's)
 *   settled it first, or it never was. Nothing was attempted or recorded; a toast says so, the
 *   lists are read again and the dialog closes;
 * - `toast`: the cookie of another account (ADR-0092): nothing was done, the dialog closes and the
 *   session is asked again;
 * - `field`: the reason (VALIDATION_ERROR on `reason`: none, or over 500 characters);
 * - `alert`: in the dialog, which stays — the run holding the market's lock (TRANSACTION_BUSY,
 *   nothing recorded), the market unknown, a session ended, a role revoked, a request that never
 *   reached the API or anything else. `refresh` when the lists behind are out of date.
 */
export type SettlementRetryFailure =
  | { kind: 'not_settling' }
  | { kind: 'toast'; message: string }
  | { kind: 'field'; message: string }
  | { kind: 'alert'; message: string; refresh: boolean };

export function settlementRetryFailure(error: unknown): SettlementRetryFailure {
  if (isForAnotherAccount(error)) return { kind: 'toast', message: copy.sessionChanged };
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'status') return { kind: 'not_settling' };
    if (field === 'reason') return { kind: 'field', message: copy.errMarketReviewReason };
  }
  if (isApiError(error, 'TRANSACTION_BUSY')) {
    return { kind: 'alert', message: copy.errTransactionBusy, refresh: false };
  }
  if (isApiError(error, 'NOT_FOUND')) {
    return { kind: 'alert', message: copy.adminMarketNotFound, refresh: true };
  }
  if (isApiError(error, 'UNAUTHENTICATED')) {
    return { kind: 'alert', message: copy.errUnauthenticated, refresh: false };
  }
  // Not the account check above: the in-transaction role check, once another admin revoked this
  // one's role.
  if (isApiError(error, 'FORBIDDEN')) {
    return { kind: 'alert', message: copy.adminOnly, refresh: false };
  }
  return {
    kind: 'alert',
    message: isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown,
    refresh: false,
  };
}
