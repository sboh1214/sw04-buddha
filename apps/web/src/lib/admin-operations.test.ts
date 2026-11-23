import {
  type ErrorCode,
  OPERATIONS_CLOSING_WINDOWS,
  OPERATIONS_FAILURE_KINDS,
  OPERATIONS_JUDGEMENT_STAGES,
  OPERATIONS_STUCK_AFTER_MINUTES,
  OPERATIONS_STUCK_STAGES,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ADMIN_DISPUTES_QUEUE_PATH,
  ADMIN_JUDGEMENT_APPROVALS_PATH,
  ADMIN_LEDGER_HOLDS_PATH,
  ADMIN_OPERATIONS_LISTS,
  ADMIN_OPERATIONS_LIST_TEXT,
  ADMIN_OPERATIONS_PATH,
  ANCHOR_SCROLL_MARGIN_TOP,
  MARKET_JUDGEMENTS_ANCHOR,
  MARKET_MAKER_RECALL_ANCHOR,
  OPERATIONS_FILTER_LABEL,
  OPERATIONS_KIND_LABEL,
  OPERATIONS_RECALL_REASON_TEXT,
  OPERATIONS_STAGE_LABEL,
  OPERATIONS_STUCK_STAGE_LABEL,
  OPERATIONS_WINDOW_LABEL,
  adminMarketPath,
  adminMarketRecallPath,
  adminOperationsFilterOf,
  adminOperationsListOf,
  adminOperationsPath,
  adminOperationsViewOf,
  adminOperationsWithinOf,
  attemptsText,
  hashTargetId,
  judgementRowLinks,
  noDelayRecordText,
  settlementRetryFailure,
  shownLongDelayDeadline,
  stuckSinceText,
  stuckStageText,
} from './admin-operations';
import { ApiError } from './api';
import { formatKst } from './datetime';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function refused(status: number, code: ErrorCode, details?: unknown): ApiError {
  return new ApiError(status, { code, message: code, details });
}

/**
 * 운영 대기열 (#145 part 1, ADR-0163): which screen an address names and the address of each, the
 * words of each list (145-18 — the owner's approval of the brief's table, as written), where a row
 * leads, and what a refused 정산 다시 시도 says.
 */
describe('운영 대기열’s addresses', () => {
  it('reads one list per screen from ?list=, 마감 예정 without it or for anything unknown', () => {
    expect(ADMIN_OPERATIONS_LISTS).toEqual(['closing', 'judgements', 'failures']);
    expect(adminOperationsListOf('judgements')).toBe('judgements');
    expect(adminOperationsListOf('failures')).toBe('failures');
    for (const param of [undefined, null, '', 'closing', 'history', ['failures']]) {
      expect(adminOperationsListOf(param), String(param)).toBe('closing');
    }
  });

  it('reads the window and the filter, each at its default for anything unknown (145-1, 145-2)', () => {
    for (const within of OPERATIONS_CLOSING_WINDOWS) {
      expect(adminOperationsWithinOf(within)).toBe(within);
    }
    // 145-1 "처음 값은 24시간이다".
    for (const param of [undefined, '', '1d', '30d', ['7d']]) {
      expect(adminOperationsWithinOf(param), String(param)).toBe('24h');
    }
    expect(adminOperationsFilterOf('delayed')).toBe('delayed');
    for (const param of [undefined, '', 'late', ['delayed']]) {
      expect(adminOperationsFilterOf(param), String(param)).toBe('all');
    }
    expect(adminOperationsViewOf({})).toEqual({ list: 'closing', within: '24h', filter: 'all' });
    expect(adminOperationsViewOf({ list: 'judgements', within: '7d', filter: 'delayed' })).toEqual({
      list: 'judgements',
      within: '7d',
      filter: 'delayed',
    });
  });

  it('builds each address with only what differs from its default, round trip', () => {
    expect(ADMIN_OPERATIONS_PATH).toBe('/admin/operations');
    expect(adminOperationsPath({ list: 'closing' })).toBe('/admin/operations');
    expect(adminOperationsPath({ list: 'closing', within: '24h' })).toBe('/admin/operations');
    expect(adminOperationsPath({ list: 'closing', within: '3d' })).toBe(
      '/admin/operations?within=3d',
    );
    expect(adminOperationsPath({ list: 'judgements' })).toBe('/admin/operations?list=judgements');
    expect(adminOperationsPath({ list: 'judgements', filter: 'delayed' })).toBe(
      '/admin/operations?list=judgements&filter=delayed',
    );
    expect(adminOperationsPath({ list: 'failures' })).toBe('/admin/operations?list=failures');
    // A sub-choice belongs to its own list: another list's is dropped.
    expect(adminOperationsPath({ list: 'failures', within: '7d', filter: 'delayed' })).toBe(
      '/admin/operations?list=failures',
    );
    expect(adminOperationsPath({ list: 'judgements', within: '7d' })).toBe(
      '/admin/operations?list=judgements',
    );
    for (const list of ADMIN_OPERATIONS_LISTS) {
      for (const within of OPERATIONS_CLOSING_WINDOWS) {
        for (const filter of ['all', 'delayed'] as const) {
          const path = adminOperationsPath({ list, within, filter });
          const query = new URLSearchParams(path.split('?')[1] ?? '');
          const view = adminOperationsViewOf({
            list: query.get('list') ?? undefined,
            within: query.get('within') ?? undefined,
            filter: query.get('filter') ?? undefined,
          });
          expect(view.list, path).toBe(list);
          if (list === 'closing') expect(view.within, path).toBe(within);
          if (list === 'judgements') expect(view.filter, path).toBe(filter);
        }
      }
    }
  });

  it('leads each row to its processing screen and to the lists #145 links only', () => {
    expect(adminMarketPath(MARKET)).toBe(`/admin/markets/${MARKET}`);
    // 145-8 "회수 칸으로 연결만": the market maker panel's block, by its anchor.
    expect(MARKET_MAKER_RECALL_ANCHOR).toBe('market-maker-recall');
    expect(adminMarketRecallPath(MARKET)).toBe(`/admin/markets/${MARKET}#market-maker-recall`);
    // 145-2 "승인은 지금처럼 '판정 승인 대기'에서 한다".
    expect(MARKET_JUDGEMENTS_ANCHOR).toBe('market-judgements');
    expect(ADMIN_JUDGEMENT_APPROVALS_PATH).toBe('/admin/markets/reviews#market-judgements');
    // Both anchors stop below the sticky header (row 1 and its rule, 65px on admin screens),
    // not under it: Chakra spacing is 4px a step.
    expect(Number(ANCHOR_SCROLL_MARGIN_TOP) * 4).toBeGreaterThan(65);
    expect(ADMIN_DISPUTES_QUEUE_PATH).toBe('/admin/disputes');
    expect(ADMIN_LEDGER_HOLDS_PATH).toBe('/admin/audit-failures');
    expect(hashTargetId('#market-maker-recall')).toBe('market-maker-recall');
    expect(hashTargetId('market-judgements')).toBe('market-judgements');
    expect(hashTargetId('#%ED%9A%8C%EC%88%98')).toBe('회수');
    expect(hashTargetId('#%E0%A4%A')).toBe('%E0%A4%A');
    expect(hashTargetId('')).toBeNull();
    expect(hashTargetId('#')).toBeNull();
  });

  it('links a waiting registration or correction to 판정 승인 대기 and a holding dispute to 이의 접수', () => {
    const base = { holdingDisputes: 0, correctionPending: false } as const;
    expect(judgementRowLinks({ ...base, stage: 'unregistered' })).toEqual({
      approvals: false,
      disputes: false,
    });
    expect(judgementRowLinks({ ...base, stage: 'awaiting_approval' })).toEqual({
      approvals: true,
      disputes: false,
    });
    expect(
      judgementRowLinks({
        stage: 'dispute_or_correction',
        holdingDisputes: 2,
        correctionPending: true,
      }),
    ).toEqual({ approvals: true, disputes: true });
    expect(
      judgementRowLinks({
        stage: 'dispute_or_correction',
        holdingDisputes: 1,
        correctionPending: false,
      }),
    ).toEqual({ approvals: false, disputes: true });
  });
});

describe('운영 대기열’s words (145-18 "이대로")', () => {
  it('names the screen, its lists and its sub-choices as approved', () => {
    expect(copy.adminOperations).toBe('운영 대기열');
    expect(copy.adminOperationsIntro).toBe(
      '마감 예정·판정 대기·정산 실패 시장을 모아 보고, 시장을 눌러 처리 화면으로 갑니다. 예정 시각이 지나도 목록이 시장의 상태나 결과를 바꾸지는 않습니다.',
    );
    expect(copy.adminOperationsOtherLists).toBe('개설 검수와 이의 접수는 각 목록에서 봅니다.');
    expect(ADMIN_OPERATIONS_LISTS.map((list) => ADMIN_OPERATIONS_LIST_TEXT[list].label)).toEqual([
      '마감 예정',
      '판정 대기·지연',
      '정산 실패',
    ]);
    expect(ADMIN_OPERATIONS_LISTS.map((list) => ADMIN_OPERATIONS_LIST_TEXT[list].empty)).toEqual([
      '마감 예정 시장이 없습니다.',
      '판정을 기다리는 시장이 없습니다.',
      '정산 실패·처리 멈춤·회수 실패 시장이 없습니다.',
    ]);
    expect(copy.adminOperationsWithin).toBe('마감까지');
    expect(OPERATIONS_CLOSING_WINDOWS.map((within) => OPERATIONS_WINDOW_LABEL[within])).toEqual([
      '24시간',
      '3일',
      '7일',
    ]);
    expect(Object.values(OPERATIONS_FILTER_LABEL)).toEqual(['전체', '지연만']);
    // Not '마감 처리 중': the same row can be 처리 멈춤 at once (145-18).
    expect(copy.adminOperationsOverdue).toBe('마감 시각 지남');
  });

  it('words each stage (145-11), each kind (145-8, 145-18) and each stuck transition (145-4)', () => {
    expect(OPERATIONS_JUDGEMENT_STAGES.map((stage) => OPERATIONS_STAGE_LABEL[stage])).toEqual([
      '판정 등록 전',
      '판정 승인 대기',
      '이의·정정 대기',
    ]);
    expect(OPERATIONS_FAILURE_KINDS.map((kind) => OPERATIONS_KIND_LABEL[kind])).toEqual([
      '정산 실패',
      '처리 멈춤',
      '봇 자금 회수 실패',
    ]);
    expect(OPERATIONS_STUCK_STAGES.map((stage) => OPERATIONS_STUCK_STAGE_LABEL[stage])).toEqual([
      '거래 마감',
      '결과 확정',
      '지급 시작',
      '지급 완료',
    ]);
    expect(stuckStageText('start')).toBe('처리 멈춤 · 지급 시작');
    expect([
      copy.adminOperationsDelayed,
      copy.adminOperationsDelayReason,
      copy.adminOperationsNextReview,
      copy.adminOperationsReviewOverdue,
      copy.adminOperationsLongDelayReached,
      copy.adminOperationsToApprovals,
      copy.adminOperationsToDisputes,
      copy.adminOperationsLastError,
      copy.adminOperationsLastAttempt,
      copy.adminOperationsLedgerHeld,
      copy.adminOperationsToLedger,
      copy.adminOperationsToRecall,
    ]).toEqual([
      '판정 지연',
      '지연 사유',
      '다음 검토',
      '갱신 대기',
      '장기 지연 기한 도달',
      '판정 승인 대기로',
      '이의 접수로',
      '마지막 오류',
      '마지막 시도',
      '대사 보류',
      '대사 보류 보기',
      '회수 칸 보기',
    ]);
    // '갱신 대기' is the word the admin detail and the public detail already use.
    expect(copy.adminOperationsReviewOverdue).toBe(copy.marketNextReviewPassed);
    // A failed recall's code in the market maker panel's own sentence (ADR-0125).
    expect(OPERATIONS_RECALL_REASON_TEXT).toEqual({
      books_inconsistent: copy.marketMakerRecallBooks,
      recall_inconsistent: copy.marketMakerRecallBooks,
      execution_failed: copy.marketMakerRecallExecution,
    });
  });

  it('says when a stuck transition was due, with the code’s 30 minutes, and counts attempts', () => {
    const due = '2026-11-23T03:00:00.000Z';
    expect(stuckSinceText(due)).toBe(
      `${formatKst(due)}에 일어났어야 했는데 30분 넘게 그대로입니다`,
    );
    // 145-4 "30분은 코드 고정값이다": the sentence says the constant.
    expect(copy.adminOperationsStuckSince).toContain(`${String(OPERATIONS_STUCK_AFTER_MINUTES)}분`);
    expect(attemptsText(1)).toBe('시도 1회');
    expect(attemptsText(1234)).toBe('시도 1,234회');
  });

  it('says no record of a CLOSED market, none of this version on a PROVISIONAL one', () => {
    expect(noDelayRecordText({ status: 'closed' })).toBe('지연 기록 없음');
    expect(noDelayRecordText({ status: 'provisional' })).toBe('이 판정 버전의 지연 기록 없음');
  });

  it('shows the 장기 지연 기한 on 거래 마감 rows alone (145-17)', () => {
    const deadline = '2026-12-15T01:00:00.000Z';
    expect(shownLongDelayDeadline({ status: 'closed', longDelayDeadline: deadline })).toBe(
      deadline,
    );
    expect(shownLongDelayDeadline({ status: 'closed', longDelayDeadline: null })).toBeNull();
    expect(
      shownLongDelayDeadline({ status: 'provisional', longDelayDeadline: deadline }),
    ).toBeNull();
  });

  it('words the retry as approved (145-18 — the button and the title alike)', () => {
    expect(copy.adminSettlementRetry).toBe('정산 다시 시도');
    expect(copy.adminSettlementRetryTitle).toBe('정산 다시 시도');
    expect(copy.adminSettlementRetryHint).toBe(
      '매 분 자동 재시도와 같은 검사로 지금 한 번 지급을 시도합니다. 지급액과 검사는 바꿀 수 없고, 사유와 결과가 작업 이력에 남습니다.',
    );
    expect(copy.adminSettlementRetryDone).toBe('지급을 마쳤습니다.');
    expect(copy.adminSettlementRetryFailed).toBe('다시 시도했지만 지급하지 못했습니다.');
    expect(copy.adminSettlementRetryNotSettling).toBe(
      '이 시장은 이미 지급 중이 아닙니다. 목록을 다시 읽었습니다.',
    );
    // Two labels, one meaning each: the lists' load-error button keeps '다시 시도' (145-18).
    expect(copy.adminSettlementRetry).not.toBe(copy.retry);
  });
});

describe('a refused 정산 다시 시도 (145-7, 145-14)', () => {
  it('closes with a fresh read when the market is no longer 지급 중', () => {
    expect(
      settlementRetryFailure(
        refused(400, 'VALIDATION_ERROR', [{ path: ['status'], message: 'not settling' }]),
      ),
    ).toEqual({ kind: 'not_settling' });
  });

  it('says the reason under its field, another account’s cookie in a toast', () => {
    expect(
      settlementRetryFailure(
        refused(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'Too small' }]),
      ),
    ).toEqual({ kind: 'field', message: copy.errMarketReviewReason });
    expect(
      settlementRetryFailure(
        refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'Different account' }]),
      ),
    ).toEqual({ kind: 'toast', message: copy.sessionChanged });
  });

  it('keeps the dialog over everything else, reading again only when the market is gone', () => {
    expect(settlementRetryFailure(refused(409, 'TRANSACTION_BUSY'))).toEqual({
      kind: 'alert',
      message: copy.errTransactionBusy,
      refresh: false,
    });
    expect(settlementRetryFailure(refused(404, 'NOT_FOUND'))).toEqual({
      kind: 'alert',
      message: copy.adminMarketNotFound,
      refresh: true,
    });
    expect(settlementRetryFailure(refused(401, 'UNAUTHENTICATED'))).toEqual({
      kind: 'alert',
      message: copy.errUnauthenticated,
      refresh: false,
    });
    expect(settlementRetryFailure(refused(403, 'FORBIDDEN'))).toEqual({
      kind: 'alert',
      message: copy.adminOnly,
      refresh: false,
    });
    expect(settlementRetryFailure(refused(500, 'INTERNAL'))).toEqual({
      kind: 'alert',
      message: copy.errUnknown,
      refresh: false,
    });
    expect(settlementRetryFailure(new TypeError('Failed to fetch'))).toEqual({
      kind: 'alert',
      message: copy.errNetwork,
      refresh: false,
    });
    // A VALIDATION_ERROR on no field the dialog knows is no field's.
    expect(settlementRetryFailure(refused(400, 'VALIDATION_ERROR'))).toEqual({
      kind: 'alert',
      message: copy.errUnknown,
      refresh: false,
    });
  });
});
