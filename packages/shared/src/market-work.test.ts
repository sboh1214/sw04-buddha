import { describe, expect, it } from 'vitest';
import { ADMIN_ACTION_TYPES, MARKET_EVENT_TYPES } from './enums.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import {
  CATEGORY_CHANGE_TYPES,
  MARKET_EVENT_WORK,
  MARKET_SNAPSHOT_CHANGE_FIELDS,
  MARKET_SNAPSHOT_IGNORED_FIELDS,
  MARKET_WORK_ACTION_KIND,
  MARKET_WORK_ACTION_REASON,
  MARKET_WORK_ACTION_TYPES,
  MARKET_WORK_ENTRY_TYPES,
  MARKET_WORK_EXCLUDED_ACTIONS,
  MARKET_WORK_KINDS,
  MARKET_WORK_REASON_BASES,
  MARKET_WORK_SOURCES,
  adminCategoryChangeSchema,
  adminMarketWorkEntrySchema,
  adminMarketWorkQuerySchema,
  isJudgementCorrection,
  marketSnapshotChanges,
  marketWorkActionTypesOf,
  marketWorkDetailsOf,
  marketWorkEventTypesOf,
  marketWorkKindOf,
  marketWorkReasonOf,
  type MarketWorkKind,
} from './market-work.js';

const MARKET = '0b6c1f5e-6e0c-4b8f-9a3d-2f1e4c5d6a7b';
const ACTION = '1c7d2a6f-7f1d-4c9a-8b4e-3a2f5d6e7b8c';
const AT = '2026-11-23T03:00:00.000Z';

/**
 * The keys `snapshot()` returns (apps/api/src/markets/market-admin.service.ts:470 — `ruleItemsOf`
 * and `timesOf` spread in), in its order. The api's own test pins this list against a real call.
 */
const SNAPSHOT_KEYS = [
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
  'status',
  'lastPrice',
  'volumeCoin',
  'tradeCount',
  'traderCount',
  'statsRevision',
  'openAt',
  'scheduledOpenAt',
  'scheduledAnnouncementAt',
  'scheduledJudgementAt',
  'judgementTimeZone',
  'closeAt',
  'leadCloseGapMinutes',
  'priceProtectionTicks',
  'currentLiquidityVersion',
  'openedLiquidityVersion',
];

/** A snapshot as `snapshot()` writes it. */
function snapshotOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'market-a',
    title: '시장 A',
    description: null,
    yesCondition: 'YES 조건',
    noCondition: 'NO 조건',
    eventDeadline: AT,
    primarySource: { name: '출처', url: 'https://example.com' },
    fallbackSources: [],
    fallbackCondition: null,
    longDelayDays: 14,
    delayHandling: '연기',
    categoryId: 3,
    tags: ['AI'],
    imageUrl: null,
    status: 'open',
    lastPrice: 50,
    volumeCoin: '0',
    tradeCount: 0,
    traderCount: 0,
    statsRevision: '0',
    openAt: AT,
    scheduledOpenAt: AT,
    scheduledAnnouncementAt: null,
    scheduledJudgementAt: AT,
    judgementTimeZone: 'Asia/Seoul',
    closeAt: AT,
    leadCloseGapMinutes: null,
    priceProtectionTicks: 10,
    currentLiquidityVersion: 1,
    openedLiquidityVersion: 1,
    ...overrides,
  };
}

describe('작업 이력 classification (#145, ADR-0164; 145-12, 145-13)', () => {
  it('names the five kinds of 145-5 in screen order', () => {
    expect(MARKET_WORK_KINDS).toEqual(['edit', 'pause', 'judgement', 'settlement', 'other']);
    expect(MARKET_WORK_SOURCES).toEqual(['market_event', 'admin_action', 'settlement_step']);
  });

  it('puts every admin action type in exactly one of the shown and excluded maps', () => {
    for (const type of ADMIN_ACTION_TYPES) {
      const shown = Object.hasOwn(MARKET_WORK_ACTION_KIND, type);
      const excluded = Object.hasOwn(MARKET_WORK_EXCLUDED_ACTIONS, type);
      expect(shown !== excluded, type).toBe(true);
    }
    const known = new Set<string>(ADMIN_ACTION_TYPES);
    for (const type of [
      ...Object.keys(MARKET_WORK_ACTION_KIND),
      ...Object.keys(MARKET_WORK_EXCLUDED_ACTIONS),
    ]) {
      expect(known.has(type), type).toBe(true);
    }
    expect(MARKET_WORK_ACTION_TYPES).toEqual(
      ADMIN_ACTION_TYPES.filter((type) => Object.hasOwn(MARKET_WORK_ACTION_KIND, type)),
    );
    for (const reason of Object.values(MARKET_WORK_EXCLUDED_ACTIONS)) expect(reason).not.toBe('');
  });

  it('classifies exactly as 145-12 lists, 이해충돌 신고 under 판정 and 대사 보류 복구 under 지급', () => {
    const byKind = (kind: MarketWorkKind) => marketWorkActionTypesOf(kind).sort();
    expect(byKind('edit')).toEqual(
      [
        'market_create',
        'market_update',
        'market_supplement_request',
        'market_supplement_approve',
        'market_supplement_reject',
        'market_supplement_retract',
        'market_price_protection_change',
      ].sort(),
    );
    expect(byKind('pause')).toEqual(
      [
        'market_pause',
        'market_pause_decision_request',
        'market_pause_decision_approve',
        'market_pause_decision_reject',
        'market_pause_decision_retract',
      ].sort(),
    );
    expect(byKind('judgement')).toEqual(
      [
        'market_judgement_request',
        'market_judgement_approve',
        'market_judgement_reject',
        'market_judgement_retract',
        'market_dispute_dismiss',
        'market_dispute_accept',
        'market_delay_record',
        'market_conflict_declare',
        'market_resolve',
        // #144 (ADR-0165): the 판정 오류 사건's four, a judgement's review after the payout.
        'market_judgement_incident_register',
        'market_judgement_incident_confirm',
        'market_judgement_incident_dismiss',
        'market_judgement_incident_retract',
      ].sort(),
    );
    expect(byKind('settlement')).toEqual(
      [
        'market_settlement_retry',
        'reconciliation_recovery_request',
        'reconciliation_recovery_approve',
        'reconciliation_recovery_reject',
        'reconciliation_recovery_retract',
      ].sort(),
    );
    expect(byKind('other')).toEqual(
      [
        'market_submit',
        'market_approve',
        'market_reject',
        'market_revert',
        'market_reschedule',
        'market_cancel_request',
        'market_cancel_approve',
        'market_cancel_reject',
        'market_cancel_retract',
        'market_link',
        'market_unlink',
        'reconciliation_run',
        'fill_classification_request',
        'fill_classification_approve',
        'fill_classification_reject',
        'fill_classification_retract',
        'proposal_adopt',
        'proposal_link',
        'market_open',
        'market_close',
      ].sort(),
    );
    expect(marketWorkActionTypesOf()).toHaveLength(MARKET_WORK_ACTION_TYPES.length);
  });

  it('leaves out bots, themes, post and member moderation and the category list (145-13, 145-10)', () => {
    const excluded = Object.keys(MARKET_WORK_EXCLUDED_ACTIONS);
    for (const prefix of [
      'market_maker_control_',
      'theme_',
      'moderation_',
      'category_',
      'reconciliation_correction_',
      'treasury_',
    ]) {
      const ofPrefix = ADMIN_ACTION_TYPES.filter((type) => type.startsWith(prefix));
      expect(ofPrefix.length, prefix).toBeGreaterThan(0);
      for (const type of ofPrefix) expect(excluded, type).toContain(type);
    }
    expect(excluded).toContain('report_dismiss');
    expect(excluded).toEqual(expect.arrayContaining(['proposal_review', 'proposal_reject']));
  });

  it('maps every market event type, reading only `opened` with an admin actor too (145-6)', () => {
    expect(Object.keys(MARKET_EVENT_WORK).sort()).toEqual([...MARKET_EVENT_TYPES].sort());
    const always = MARKET_EVENT_TYPES.filter((type) => MARKET_EVENT_WORK[type].shown === 'always');
    expect(always).toEqual(['opened']);
    // 145-12's system rows: 원장 불일치 자동 중단 (중단), 결과 확정 (판정), 지급 시작·완료 (지급),
    // 예약 개장·거래 마감·자동 취소 (그 밖).
    expect(MARKET_EVENT_WORK.paused.kind).toBe('pause');
    expect(MARKET_EVENT_WORK.resolved.kind).toBe('judgement');
    expect(MARKET_EVENT_WORK.settling.kind).toBe('settlement');
    expect(MARKET_EVENT_WORK.finalized.kind).toBe('settlement');
    for (const type of ['opened', 'closed', 'cancelled'] as const) {
      expect(MARKET_EVENT_WORK[type].kind, type).toBe('other');
    }
    expect(marketWorkEventTypesOf('settlement')).toEqual(['finalized', 'settling']);
    expect(marketWorkEventTypesOf()).toEqual([...MARKET_EVENT_TYPES]);
  });

  it('gives every entry type one kind, the step record under 지급', () => {
    expect(marketWorkKindOf('settlement_step')).toBe('settlement');
    expect(marketWorkKindOf('market_conflict_declare')).toBe('judgement');
    expect(marketWorkKindOf('reconciliation_recovery_approve')).toBe('settlement');
    expect(marketWorkKindOf('paused')).toBe('pause');
    expect(new Set(MARKET_WORK_ENTRY_TYPES).size).toBe(MARKET_WORK_ENTRY_TYPES.length);
    expect(MARKET_WORK_ENTRY_TYPES).toHaveLength(
      MARKET_WORK_ACTION_TYPES.length + MARKET_EVENT_TYPES.length + 1,
    );
  });

  it('names no excluded feature in any value, field or type (sourceOrder, retracted)', () => {
    const names = [
      ...MARKET_WORK_KINDS,
      ...MARKET_WORK_SOURCES,
      ...MARKET_WORK_REASON_BASES,
      ...MARKET_WORK_ENTRY_TYPES,
      ...MARKET_SNAPSHOT_CHANGE_FIELDS,
      ...CATEGORY_CHANGE_TYPES,
      ...Object.keys(adminMarketWorkEntrySchema.shape),
      'sourceOrder',
      'relatedMarket',
      'AdminMarketWorkEntry',
      'AdminCategoryChange',
      'work-history',
      'changes',
    ];
    for (const name of names) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'route'), name).toEqual([]);
    }
  });

  it('keeps the reason basis and the retry outcome private (PRIVATE_DATA `operation-records`)', () => {
    for (const name of ['reasonBasis', 'retryOutcome', 'settlementLastError']) {
      expect(
        findPrivateField(name).map((hit) => hit.item),
        name,
      ).toContain('operation-records');
    }
  });
});

describe('작업 이력 reason basis (145-16)', () => {
  it('shows the stored reason, the registration’s 설명 and a pause’s note', () => {
    expect(marketWorkReasonOf('market_pause_decision_approve', { reason: '재개' })).toEqual({
      reason: '재개',
      reasonBasis: 'recorded',
    });
    expect(
      marketWorkReasonOf('market_judgement_request', { description: '출처 발표', result: 'YES' }),
    ).toEqual({ reason: '출처 발표', reasonBasis: 'recorded' });
    expect(
      marketWorkReasonOf('market_pause', { reason: 'early_result', note: '결과 조기 공개' }),
    ).toEqual({ reason: '결과 조기 공개', reasonBasis: 'recorded' });
    expect(
      marketWorkReasonOf('market_settlement_retry', { reason: '복구 뒤', outcome: 'failed' }),
    ).toEqual({ reason: '복구 뒤', reasonBasis: 'recorded' });
    // An old row with no reason keeps its basis.
    expect(marketWorkReasonOf('market_approve', { approvalId: ACTION })).toEqual({
      reason: null,
      reasonBasis: 'recorded',
    });
  });

  it('shows a 판정 오류 사건 by its 오류 내용 and its decisions by their reasons (#144, ADR-0165)', () => {
    // 145-16 "판정 등록은 그 설명": the incident's registration stands on its description.
    expect(
      marketWorkReasonOf('market_judgement_incident_register', {
        approvalId: ACTION,
        judgementVersion: 1,
        originalResult: 'YES',
        correctedResult: 'NO',
        description: '발표 원문의 수치를 잘못 읽었다',
        evidence: { links: ['https://example.com/a'], collectedAt: AT },
      }),
    ).toEqual({ reason: '발표 원문의 수치를 잘못 읽었다', reasonBasis: 'recorded' });
    for (const type of [
      'market_judgement_incident_confirm',
      'market_judgement_incident_dismiss',
    ] as const) {
      expect(
        marketWorkReasonOf(type, { approvalId: ACTION, correctedResult: 'NO', reason: '확인' }),
      ).toEqual({ reason: '확인', reasonBasis: 'recorded' });
      expect(marketWorkKindOf(type)).toBe('judgement');
    }
    expect(
      marketWorkReasonOf('market_judgement_incident_retract', {
        approvalId: ACTION,
        correctedResult: 'NO',
      }),
    ).toEqual({ reason: null, reasonBasis: 'retracted' });
    // Not a #176 correction: those are the judgement's own four types.
    expect(
      isJudgementCorrection('market_judgement_incident_register', {
        correction: { baseVersion: 1 },
      }),
    ).toBe(false);
  });

  it('shows a 판정 정정’s registration by its 설명 like any 판정 등록 and tells a correction’s four steps (#176)', () => {
    const correction = { baseVersion: 1, reason: '출처 수치 정정', disputeIds: [] };
    // 145-16 "판정 등록은 그 설명": the 정정 사유 is a detail, not the reason.
    expect(
      marketWorkReasonOf('market_judgement_request', {
        description: '고친 수치를 확인했습니다',
        result: 'YES',
        correction,
      }),
    ).toEqual({ reason: '고친 수치를 확인했습니다', reasonBasis: 'recorded' });
    expect(
      marketWorkReasonOf('market_judgement_request', {
        description: '출처 발표',
        correction: null,
      }),
    ).toEqual({ reason: '출처 발표', reasonBasis: 'recorded' });
    // The approval's own reason stays the approver's.
    expect(
      marketWorkReasonOf('market_judgement_approve', { reason: '승인합니다', correction }),
    ).toEqual({ reason: '승인합니다', reasonBasis: 'recorded' });
    expect(isJudgementCorrection('market_judgement_request', { correction })).toBe(true);
    expect(isJudgementCorrection('market_judgement_approve', { correction })).toBe(true);
    expect(isJudgementCorrection('market_judgement_request', { correction: null })).toBe(false);
    expect(isJudgementCorrection('market_judgement_approve', {})).toBe(false);
    expect(isJudgementCorrection('market_judgement_reject', { reopenedDisputeIds: [] })).toBe(true);
    expect(isJudgementCorrection('market_judgement_retract', { reopenedDisputeIds: [] })).toBe(
      true,
    );
    expect(isJudgementCorrection('market_judgement_reject', { result: 'YES' })).toBe(false);
    expect(isJudgementCorrection('market_judgement_retract', { result: 'YES' })).toBe(false);
    expect(isJudgementCorrection('market_update', { correction })).toBe(false);
  });

  it('answers 바뀐 항목 for drafts, edits and submissions, and the reason of a liquidity setting', () => {
    for (const type of ['market_create', 'market_update', 'market_submit'] as const) {
      expect(marketWorkReasonOf(type, { after: snapshotOf() }), type).toEqual({
        reason: null,
        reasonBasis: 'changed_items',
      });
    }
    expect(
      marketWorkReasonOf('market_update', {
        liquidity: { beforeVersion: 1, afterVersion: 2, settings: {} },
        reason: '유동성 조정',
      }),
    ).toEqual({ reason: '유동성 조정', reasonBasis: 'recorded' });
  });

  it('answers 담당자와 시각만 for links, proposals and reconciliation runs', () => {
    for (const type of [
      'market_link',
      'market_unlink',
      'proposal_adopt',
      'proposal_link',
      'reconciliation_run',
    ] as const) {
      expect(marketWorkReasonOf(type, { reason: 'ignored' }), type).toEqual({
        reason: null,
        reasonBasis: 'actor_time',
      });
    }
  });

  it('points a retraction at its request (사유는 그 요청에 있음)', () => {
    const retracts = MARKET_WORK_ACTION_TYPES.filter((type) => type.endsWith('_retract'));
    // #144 added the 판정 오류 사건's (ADR-0165).
    expect(retracts.length).toBe(7);
    for (const type of retracts) {
      expect(MARKET_WORK_ACTION_REASON[type], type).toBe('retracted');
      expect(marketWorkReasonOf(type, { approvalId: ACTION, reason: 'x' }).reason).toBeNull();
    }
  });

  it('gives system processing the `system` basis, the no-fill cancel its stored sentence', () => {
    expect(marketWorkReasonOf('opened', { source: 'job' })).toEqual({
      reason: null,
      reasonBasis: 'system',
    });
    expect(marketWorkReasonOf('paused', { reason: 'ledger_failure' }).reason).toBeNull();
    expect(
      marketWorkReasonOf('cancelled', { source: 'job', reason: '체결이 없어 취소했습니다.' }),
    ).toEqual({ reason: '체결이 없어 취소했습니다.', reasonBasis: 'system' });
    expect(marketWorkReasonOf('settlement_step', null)).toEqual({
      reason: null,
      reasonBasis: 'system',
    });
  });

  it('gives every shown action a basis other than `system`', () => {
    for (const type of MARKET_WORK_ACTION_TYPES) {
      expect(MARKET_WORK_ACTION_REASON[type], type).not.toBe('system');
    }
  });
});

describe('작업 이력 changes (145-16 바뀐 항목)', () => {
  it('puts every snapshot() key in exactly one of the compared and ignored lists', () => {
    const lists = [...MARKET_SNAPSHOT_CHANGE_FIELDS, ...MARKET_SNAPSHOT_IGNORED_FIELDS];
    expect(new Set(lists).size).toBe(lists.length);
    expect([...lists].sort()).toEqual([...SNAPSHOT_KEYS].sort());
    expect(Object.keys(snapshotOf()).sort()).toEqual([...SNAPSHOT_KEYS].sort());
  });

  it('answers nothing for a change of statistics or status alone', () => {
    expect(
      marketSnapshotChanges(
        snapshotOf(),
        snapshotOf({ status: 'paused', lastPrice: 61, tradeCount: 4, statsRevision: '9' }),
      ),
    ).toEqual([]);
  });

  it('names the tags and the category that moved, before and after', () => {
    expect(
      marketSnapshotChanges(snapshotOf(), snapshotOf({ tags: ['AI', '반도체'], categoryId: 4 })),
    ).toEqual([
      { field: 'categoryId', before: 3, after: 4 },
      { field: 'tags', before: ['AI'], after: ['AI', '반도체'] },
    ]);
  });

  it('reads a draft or a submission (no before) as every filled field from null', () => {
    const changes = marketSnapshotChanges(undefined, snapshotOf());
    expect(changes.every((change) => change.before === null)).toBe(true);
    const fields = changes.map((change) => change.field);
    expect(fields).toContain('title');
    expect(fields).toContain('tags');
    // Blank values and ignored keys are not changes.
    for (const field of ['description', 'fallbackSources', 'imageUrl', 'leadCloseGapMinutes']) {
      expect(fields).not.toContain(field);
    }
    expect(fields).not.toContain('status');
  });

  it('answers nothing for a liquidity setting, and keeps its payload as the details', () => {
    const payload = {
      liquidity: { beforeVersion: 1, afterVersion: 2, settings: { b: 100 } },
      reason: '조정',
    };
    expect(marketSnapshotChanges(undefined, undefined)).toEqual([]);
    expect(marketWorkDetailsOf(payload)).toEqual({ details: payload, changes: [] });
  });

  it('drops market snapshots from the details and keeps scalar before and after', () => {
    expect(
      marketWorkDetailsOf({
        approvalId: ACTION,
        reason: '재개',
        before: snapshotOf(),
        after: snapshotOf({ title: '시장 B' }),
      }),
    ).toEqual({
      details: { approvalId: ACTION, reason: '재개' },
      changes: [{ field: 'title', before: '시장 A', after: '시장 B' }],
    });
    const reschedule = { before: AT, after: '2026-11-24T03:00:00.000Z', reason: '일정' };
    expect(marketWorkDetailsOf(reschedule)).toEqual({ details: reschedule, changes: [] });
    expect(marketWorkDetailsOf(null)).toEqual({ details: {}, changes: [] });
  });
});

describe('작업 이력 schemas', () => {
  it('takes every kind or one, nothing else', () => {
    expect(adminMarketWorkQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(adminMarketWorkQuerySchema.parse({ kind: 'pause' }).kind).toBe('pause');
    expect(adminMarketWorkQuerySchema.safeParse({ kind: 'bot' }).success).toBe(false);
  });

  it('parses a system entry, an admin entry and a step record', () => {
    const base = {
      changes: [],
      relatedMarket: null,
      settlement: null,
      retryOutcome: null,
      details: {},
      reason: null,
    };
    expect(
      adminMarketWorkEntrySchema.parse({
        ...base,
        id: 'e:12',
        source: 'market_event',
        type: 'finalized',
        kind: 'settlement',
        at: AT,
        actor: null,
        reasonBasis: 'system',
      }).actor,
    ).toBeNull();
    expect(
      adminMarketWorkEntrySchema.parse({
        ...base,
        id: `a:${ACTION}`,
        source: 'admin_action',
        type: 'market_link',
        kind: 'other',
        at: AT,
        actor: { id: 'admin-1', nickname: null },
        reasonBasis: 'actor_time',
        relatedMarket: { id: MARKET, title: '시장 B' },
      }).relatedMarket,
    ).toEqual({ id: MARKET, title: '시장 B' });
    expect(
      adminMarketWorkEntrySchema.parse({
        ...base,
        id: 's:coin',
        source: 'settlement_step',
        type: 'settlement_step',
        kind: 'settlement',
        at: AT,
        actor: null,
        reasonBasis: 'system',
        details: { step: 'coin' },
        settlement: {
          stepStatus: 'failed',
          settlementAttempts: 3,
          settlementLastError: '55P03: lock',
          completedAt: null,
        },
      }).settlement?.settlementAttempts,
    ).toBe(3);
    // Not a shown type: a bot control never parses as an entry.
    expect(
      adminMarketWorkEntrySchema.safeParse({
        ...base,
        id: `a:${ACTION}`,
        source: 'admin_action',
        type: 'market_maker_control_request',
        kind: 'other',
        at: AT,
        actor: null,
        reasonBasis: 'recorded',
      }).success,
    ).toBe(false);
  });

  it('parses each category record (145-10)', () => {
    const base = { id: ACTION, at: AT, actor: { id: 'admin-1', nickname: '운영' } };
    const parsed = [
      {
        ...base,
        type: 'category_create',
        category: { id: 4, nameKo: '경제' },
        details: { nameKo: '경제', parent: null },
      },
      {
        ...base,
        type: 'category_rename',
        category: { id: 4, nameKo: '경제·금융' },
        details: { before: '경제', after: '경제·금융' },
      },
      {
        ...base,
        type: 'category_reorder',
        category: null,
        details: {
          parent: null,
          before: [
            { id: 1, nameKo: '정치' },
            { id: 4, nameKo: '경제' },
          ],
          after: [
            { id: 4, nameKo: '경제' },
            { id: 1, nameKo: '정치' },
          ],
        },
      },
      { ...base, type: 'category_hide', category: null, details: { before: true, after: false } },
      { ...base, type: 'category_show', category: null, details: { before: false, after: true } },
    ].map((row) => adminCategoryChangeSchema.parse(row).type);
    expect(parsed).toEqual([...CATEGORY_CHANGE_TYPES]);
  });
});
