import {
  MARKET_EVENT_TYPES,
  MARKET_SNAPSHOT_CHANGE_FIELDS,
  MARKET_WORK_ACTION_TYPES,
  MARKET_WORK_ENTRY_TYPES,
  MARKET_WORK_KINDS,
  MARKET_NO_FILL_CANCEL_REASON,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminMarketWorkEntry } from './api';
import { formatKst } from './datetime';
import { MARKET_EVENT_LABEL, judgementVersionName } from './market-admin';
import {
  MARKET_WORK_ACTION_LABEL,
  MARKET_WORK_BASIS_TEXT,
  MARKET_WORK_FIELD_LABEL,
  MARKET_WORK_KIND_LABEL,
  MARKET_WORK_LABEL,
  MARKET_WORK_RETRY_OUTCOME_TEXT,
  marketWorkActorText,
  marketWorkChangeText,
  marketWorkDetailsJson,
  marketWorkKindParam,
  marketWorkLabel,
  marketWorkPath,
  marketWorkRows,
  marketWorkSystemRule,
  marketWorkValueText,
  retryErrorOf,
} from './market-work';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/** An entry as the API answers it, a 시스템 one unless told otherwise. */
function workEntry(fields: Partial<AdminMarketWorkEntry> = {}): AdminMarketWorkEntry {
  return {
    id: 'e:1',
    source: 'market_event',
    type: 'closed',
    kind: 'other',
    at: '2026-11-20T03:00:00.000Z',
    actor: null,
    reason: null,
    reasonBasis: 'system',
    details: { closedAt: '2026-11-20T03:00:00.000Z', source: 'job' },
    changes: [],
    relatedMarket: null,
    settlement: null,
    retryOutcome: null,
    ...fields,
  };
}

/**
 * 시장별 작업 이력 (#145 part 2, ADR-0164): the address and its kind, one name per history type,
 * what stands for a reason (145-16) in the words the owner approved (145-18), and the details.
 */
describe('작업 이력’s address', () => {
  it('reads `?kind=` as one of the five kinds, anything else as 전체', () => {
    for (const kind of MARKET_WORK_KINDS) expect(marketWorkKindParam(kind)).toBe(kind);
    for (const param of [undefined, null, '', 'all', 'EDIT', 'payout', ['edit', 'pause']]) {
      expect(marketWorkKindParam(param)).toBeUndefined();
    }
  });

  it('is a child of the admin detail, the bare path for 전체', () => {
    expect(marketWorkPath(ID)).toBe(`/admin/markets/${ID}/work-history`);
    expect(marketWorkPath(ID, 'settlement')).toBe(
      `/admin/markets/${ID}/work-history?kind=settlement`,
    );
  });
});

describe('작업 이력’s words (145-18)', () => {
  it('names the five kinds and 전체 as approved', () => {
    expect(Object.keys(MARKET_WORK_KIND_LABEL)).toEqual([...MARKET_WORK_KINDS]);
    expect(MARKET_WORK_KIND_LABEL).toEqual({
      edit: '수정',
      pause: '중단',
      judgement: '판정',
      settlement: '지급',
      other: '그 밖',
    });
    expect(copy.adminMarketWorkKindAll).toBe('전체');
    expect(copy.adminMarketWorkHistory).toBe('작업 이력');
  });

  it('says the approved basis lines, the step record and the retry’s two results', () => {
    expect(MARKET_WORK_BASIS_TEXT).toEqual({
      changed_items: '사유를 받지 않는 작업 — 바뀐 항목을 남깁니다',
      actor_time: '사유를 받지 않는 작업 — 담당자와 시각만 남깁니다',
      retracted: '요청 철회 — 사유는 그 요청에 있습니다',
    });
    expect(copy.adminMarketWorkStep).toBe('정산 실패 기록');
    expect(MARKET_WORK_RETRY_OUTCOME_TEXT).toEqual({
      settled: '결과: 지급 완료',
      failed: '결과: 실패',
    });
  });

  it('has one name for every history type, the event log’s for the events', () => {
    expect(Object.keys(MARKET_WORK_ACTION_LABEL).sort()).toEqual(
      [...MARKET_WORK_ACTION_TYPES].sort(),
    );
    expect(Object.keys(MARKET_WORK_LABEL).sort()).toEqual([...MARKET_WORK_ENTRY_TYPES].sort());
    for (const type of MARKET_EVENT_TYPES) {
      expect(MARKET_WORK_LABEL[type]).toBe(MARKET_EVENT_LABEL[type]);
    }
    for (const label of Object.values(MARKET_WORK_LABEL)) expect(label.trim()).not.toBe('');
    // 145-12's words where the history names an action of its own.
    expect(MARKET_WORK_LABEL.market_settlement_retry).toBe(copy.adminSettlementRetry);
    expect(MARKET_WORK_LABEL.reconciliation_recovery_approve).toBe('대사 보류 복구 승인');
    expect(MARKET_WORK_LABEL.market_conflict_declare).toBe('이해충돌 신고');
    expect(MARKET_WORK_LABEL.reconciliation_run).toBe('대사 실행');
    expect(MARKET_WORK_LABEL.proposal_link).toBe('시장 제안 연결');
    expect(MARKET_WORK_LABEL.settlement_step).toBe('정산 실패 기록');
  });

  it('names a liquidity setting and an early close by what they were', () => {
    expect(marketWorkLabel({ type: 'market_update', details: {} })).toBe('시장 수정');
    expect(
      marketWorkLabel({
        type: 'market_update',
        details: { liquidity: { version: 2 }, reason: '예산을 줄입니다' },
      }),
    ).toBe('유동성 설정');
    expect(
      marketWorkLabel({
        type: 'closed',
        details: {
          closedAt: '2026-11-20T03:00:00.000Z',
          source: 'early_close',
          reviewResult: null,
        },
      }),
    ).toBe(copy.eventEarlyClosed);
    expect(marketWorkLabel({ type: 'closed', details: { source: 'job' } })).toBe(copy.eventClosed);
  });

  it('names a 판정 정정’s registration, approval, 반려 and 철회 as a correction’s (#176)', () => {
    const correction = { baseVersion: 1, reason: '출처 수치가 고쳐졌습니다', disputeIds: [] };
    expect(marketWorkLabel({ type: 'market_judgement_request', details: { correction } })).toBe(
      '판정 정정 등록',
    );
    expect(marketWorkLabel({ type: 'market_judgement_approve', details: { correction } })).toBe(
      '판정 정정 승인',
    );
    expect(
      marketWorkLabel({ type: 'market_judgement_reject', details: { reopenedDisputeIds: [] } }),
    ).toBe('판정 정정 반려');
    expect(
      marketWorkLabel({ type: 'market_judgement_retract', details: { reopenedDisputeIds: [] } }),
    ).toBe('판정 정정 철회');
    // A first judgement's keep their names.
    expect(
      marketWorkLabel({ type: 'market_judgement_request', details: { correction: null } }),
    ).toBe('판정 등록');
    expect(
      marketWorkLabel({ type: 'market_judgement_approve', details: { correction: null } }),
    ).toBe('판정 승인');
    expect(marketWorkLabel({ type: 'market_judgement_reject', details: { result: 'YES' } })).toBe(
      '판정 반려',
    );
    expect(marketWorkLabel({ type: 'market_judgement_retract', details: {} })).toBe(
      '판정 등록 철회',
    );
  });

  it('writes 시스템 for no actor, the nickname otherwise, 탈퇴한 사용자 for a closed account', () => {
    expect(marketWorkActorText(null)).toBe('시스템');
    expect(marketWorkActorText({ id: 'a', nickname: '운영자1' })).toBe('운영자1');
    expect(marketWorkActorText({ id: 'a', nickname: null })).toBe(copy.postAuthorFormer);
  });
});

describe('a 시스템 entry’s rule (145-16 "시스템 처리는 그 규칙을 사유로 보인다")', () => {
  it('names the rule of each processing the worker does', () => {
    const rule = (type: AdminMarketWorkEntry['type'], details: Record<string, unknown> = {}) =>
      marketWorkSystemRule(workEntry({ type, details }));
    expect(rule('opened', { source: 'job' })).toBe('예정 개장 시각');
    // An approval or a reschedule that found the scheduled open already come opened at once.
    expect(rule('opened', { source: 'approval' })).toBe('예정 개장 시각이 지남');
    expect(rule('opened', { source: 'reschedule' })).toBe('예정 개장 시각이 지남');
    expect(rule('closed', { source: 'job' })).toBe('거래 마감 시각');
    expect(rule('resolved', { version: 1, result: 'YES' })).toBe(
      '이의 기한이 지나고 남은 이의·정정이 없음',
    );
    expect(rule('settling', { source: 'job' })).toBe('결과 확정 뒤 자동 지급');
    expect(rule('finalized', { result: 'YES' })).toBe('모든 지급과 대사를 마침');
    expect(rule('paused', { reason: 'ledger_failure', resultPublishedAt: null })).toBe(
      copy.pauseReasonLedgerFailure,
    );
    // A type no rule writes says nothing.
    expect(rule('resumed')).toBeNull();
    expect(
      marketWorkSystemRule(workEntry({ type: 'settlement_step', source: 'settlement_step' })),
    ).toBeNull();
  });

  it('shows the no-fill cancel’s stored sentence as it is', () => {
    expect(
      marketWorkSystemRule(
        workEntry({ type: 'cancelled', reason: MARKET_NO_FILL_CANCEL_REASON, details: {} }),
      ),
    ).toBe(MARKET_NO_FILL_CANCEL_REASON);
  });
});

describe('바뀐 항목 (145-16: 항목: 이전 → 새)', () => {
  it('names every compared field', () => {
    expect(Object.keys(MARKET_WORK_FIELD_LABEL)).toEqual([...MARKET_SNAPSHOT_CHANGE_FIELDS]);
    expect(MARKET_WORK_FIELD_LABEL.tags).toBe(copy.adminMarketTags);
    expect(MARKET_WORK_FIELD_LABEL.categoryId).toBe(copy.adminMarketCategory);
  });

  it('reads each value in the screen’s own form', () => {
    expect(marketWorkChangeText({ field: 'tags', before: ['서울', '물가'], after: ['서울'] })).toBe(
      '태그: 서울, 물가 → 서울',
    );
    expect(marketWorkChangeText({ field: 'title', before: null, after: '첫눈이 올까?' })).toBe(
      '질문: — → 첫눈이 올까?',
    );
    const close = '2026-11-24T03:00:00.000Z';
    expect(marketWorkValueText('closeAt', close)).toBe(formatKst(close));
    // A category by its current name (the server's {id, nameKo}); '#id' only for an id no
    // category holds, or a bare id.
    expect(marketWorkValueText('categoryId', { id: 12, nameKo: '물가' })).toBe('물가');
    expect(marketWorkValueText('categoryId', { id: 12, nameKo: null })).toBe('#12');
    expect(marketWorkValueText('categoryId', 12)).toBe('#12');
    expect(
      marketWorkChangeText({
        field: 'categoryId',
        before: { id: 3, nameKo: '경제' },
        after: { id: 7, nameKo: '물가' },
      }),
    ).toBe(`${copy.adminMarketCategory}: 경제 → 물가`);
    expect(marketWorkValueText('priceProtectionTicks', 5)).toBe(
      `5${copy.adminMarketPriceProtectionTicks}`,
    );
    expect(marketWorkValueText('priceProtectionTicks', null)).toBe('—');
    expect(marketWorkValueText('leadCloseGapMinutes', 30)).toBe(
      `30${copy.adminMarketLeadCloseGapMinutes}`,
    );
    expect(
      marketWorkValueText('primarySource', { name: '통계청', url: 'https://kostat.go.kr' }),
    ).toBe('통계청 (https://kostat.go.kr)');
    expect(marketWorkValueText('fallbackSources', [])).toBe('—');
    expect(marketWorkValueText('description', '  ')).toBe('—');
    expect(marketWorkValueText('currentLiquidityVersion', 3)).toBe('3');
    // An unexpected shape is one JSON line, never a blank.
    expect(marketWorkValueText('primarySource', { name: 1 })).toBe('{"name":1}');
  });
});

describe('an entry’s details', () => {
  it('reads an event as the event log does, and the step record as nothing more', () => {
    expect(marketWorkRows(workEntry())).toEqual([
      { label: copy.adminMarketCloseAtShort, value: formatKst('2026-11-20T03:00:00.000Z') },
    ]);
    expect(
      marketWorkRows(workEntry({ source: 'settlement_step', type: 'settlement_step' })),
    ).toEqual([]);
  });

  it('reads the action shapes worth a row, and leaves the rest to one JSON line', () => {
    const action = (type: AdminMarketWorkEntry['type'], details: Record<string, unknown>) =>
      workEntry({ source: 'admin_action', id: 'a:x', type, details, reasonBasis: 'recorded' });
    expect(
      marketWorkRows(action('market_pause', { reason: 'ledger_failure', note: '멈춥니다' })),
    ).toEqual([{ label: copy.adminMarketPauseReason, value: copy.pauseReasonLedgerFailure }]);
    expect(
      marketWorkRows(action('market_pause_decision_request', { path: 'resume', reason: 'r' })),
    ).toEqual([{ label: copy.pauseLogPath, value: '재개' }]);
    expect(marketWorkRows(action('market_judgement_request', { result: 'NO' }))).toEqual([
      { label: copy.marketResolvedResult, value: 'NO' },
    ]);
    // A 판정 정정: the version it corrects, its 정정 사유 (its 설명 is the 사유 column's, 145-16)
    // and the disputes registered with it; the approval's 정정 사유; a 반려's or 철회's disputes
    // sent back to review.
    const DISPUTE = '3f2504e0-4f89-11d3-9a0c-0305e82c3309';
    const correction = {
      baseVersion: 1,
      reason: '출처 수치가 고쳐졌습니다',
      disputeIds: [DISPUTE],
    };
    expect(
      marketWorkRows(
        action('market_judgement_request', {
          result: 'YES',
          description: '고친 수치를 확인했습니다',
          correction,
        }),
      ),
    ).toEqual([
      { label: copy.marketResolvedResult, value: 'YES' },
      { label: copy.adminMarketWorkCorrectionBase, value: judgementVersionName(1) },
      { label: copy.adminMarketJudgementCorrectionReason, value: '출처 수치가 고쳐졌습니다' },
      {
        label: copy.adminMarketJudgementCorrectionDisputesRegistered,
        value: `1${copy.adminMarketDisputesHoldingUnit}`,
      },
    ]);
    expect(
      marketWorkRows(
        action('market_judgement_approve', {
          version: 2,
          result: 'YES',
          disputeDeadline: '2026-11-25T03:00:00.000Z',
          correction,
        }),
      ),
    ).toContainEqual({
      label: copy.adminMarketJudgementCorrectionReason,
      value: '출처 수치가 고쳐졌습니다',
    });
    expect(
      marketWorkRows(
        action('market_judgement_retract', { result: 'YES', reopenedDisputeIds: [DISPUTE] }),
      ),
    ).toEqual([
      { label: copy.marketResolvedResult, value: 'YES' },
      {
        label: copy.adminMarketWorkReopenedDisputes,
        value: `1${copy.adminMarketDisputesHoldingUnit}`,
      },
    ]);
    expect(
      marketWorkRows(action('market_price_protection_change', { before: null, after: 4 })),
    ).toEqual([
      { label: copy.eventRulesBefore, value: copy.adminMarketPriceProtectionUndecided },
      { label: copy.eventRulesAfter, value: `4${copy.adminMarketPriceProtectionTicks}` },
    ]);
    const link = action('market_link', { marketId: ID, relatedMarketId: 'b' });
    expect(marketWorkRows(link)).toBeUndefined();
    expect(marketWorkDetailsJson(link)).toBe(`{"marketId":"${ID}","relatedMarketId":"b"}`);
  });

  it('names a 판정 오류 사건’s four steps and reads their results, never the evidence (#144)', () => {
    const action = (type: AdminMarketWorkEntry['type'], details: Record<string, unknown>) =>
      workEntry({ source: 'admin_action', id: 'a:x', type, details, reasonBasis: 'recorded' });
    expect(
      (
        [
          'market_judgement_incident_register',
          'market_judgement_incident_confirm',
          'market_judgement_incident_dismiss',
          'market_judgement_incident_retract',
        ] as const
      ).map((type) => marketWorkLabel({ type, details: {} })),
    ).toEqual([
      '판정 오류 사건 등록',
      '판정 오류 확인',
      '판정 오류 사건 기각',
      '판정 오류 사건 철회',
    ]);
    // The registration: the paid version and result and the correct one (오류 내용 is the reason
    // column's, 145-16).
    expect(
      marketWorkRows(
        action('market_judgement_incident_register', {
          approvalId: ID,
          judgementVersion: 1,
          originalResult: 'YES',
          correctedResult: 'VOID',
          description: '정정 발표가 있었습니다',
          evidence: { links: ['https://example.com/fix'], collectedAt: '2026-11-25T03:00:00.000Z' },
        }),
      ),
    ).toEqual([
      { label: copy.adminMarketJudgementIncidentPaidVersion, value: judgementVersionName(1) },
      { label: copy.adminMarketJudgementIncidentPaidResult, value: 'YES' },
      { label: copy.adminMarketJudgementIncidentCorrectedResult, value: '무효' },
    ]);
    for (const type of [
      'market_judgement_incident_confirm',
      'market_judgement_incident_dismiss',
      'market_judgement_incident_retract',
    ] as const) {
      expect(
        marketWorkRows(action(type, { approvalId: ID, correctedResult: 'NO', reason: 'r' })),
        type,
      ).toEqual([{ label: copy.adminMarketJudgementIncidentCorrectedResult, value: 'NO' }]);
    }
  });

  it('leaves out of the JSON line what the row already says: the reason and a retry’s error', () => {
    const retry = workEntry({
      source: 'admin_action',
      id: 'a:r',
      type: 'market_settlement_retry',
      kind: 'settlement',
      reason: '복구 뒤 다시 시도',
      reasonBasis: 'recorded',
      details: { reason: '복구 뒤 다시 시도', outcome: 'failed', error: '55000: held' },
      retryOutcome: 'failed',
    });
    expect(marketWorkRows(retry)).toBeUndefined();
    expect(marketWorkDetailsJson(retry)).toBe('{"outcome":"failed"}');
    expect(retryErrorOf(retry)).toBe('55000: held');
    expect(retryErrorOf({ ...retry, details: { outcome: 'settled' } })).toBeNull();
    expect(retryErrorOf({ ...retry, type: 'market_pause' })).toBeNull();
    expect(
      marketWorkDetailsJson(
        workEntry({ type: 'market_unlink', source: 'admin_action', details: {} }),
      ),
    ).toBe('');
  });
});
