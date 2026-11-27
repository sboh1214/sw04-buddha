import { findExcludedText } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { TimeZoneScope } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { BUSINESS_INFO } from '@/legal/business-info';
import { formatInTimeZone } from '@/lib/datetime';
import { serviceGuideHref } from '@/lib/service-guide';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import {
  MarketJudgingRecord,
  type JudgingRecordMarket,
  postPayoutReportText,
  showsPostPayoutReport,
} from './market-judging-record';

const ID = 'public-record';
const EMPTY: JudgingRecordMarket = {
  status: 'open',
  judgementDelayed: false,
  disputeUnderReview: false,
  resolvedResult: null,
  resolvedAt: null,
  settledAt: null,
  judgementTimeZone: 'Asia/Seoul',
  judgingRecord: {
    versions: [],
    pauses: [],
    delays: [],
    disputes: { total: 0, byVersion: [], decisions: [] },
    cancellation: null,
    payoutDelayed: false,
    correction: null,
  },
};
const VERSION: JudgingRecordMarket['judgingRecord']['versions'][number] = {
  version: 1,
  result: 'YES',
  source: { priority: 0, name: '공식 발표', url: 'https://example.com/official' },
  fallbackReason: null,
  voidReason: null,
  correctionReason: null,
  evidence: { links: ['https://example.com/evidence'], collectedAt: '2026-11-09T01:00:00.000Z' },
  description: '발표 원문에서 결과를 확인했습니다.\n규칙에 적힌 기간을 따랐습니다.',
  ruleVersion: 3,
  publishedAt: '2026-11-09T02:00:00.000Z',
  disputeDeadline: '2026-11-10T02:00:00.000Z',
};
/**
 * The record's links out to its sources: every link but the head's own to the service guide's
 * 판정과 이의 (#136, ADR-0177), which stays in the service.
 */
const evidenceLinks = (html: string) =>
  byTagName(html, 'a').filter((link) => link.attributes.href !== serviceGuideHref('judgement'));

const draw = (market: JudgingRecordMarket = EMPTY) =>
  renderWithQueries(<MarketJudgingRecord market={market} testId={ID} />);

describe('public judging record (#24)', () => {
  it('carries the anchor 거래·정산 이력 links to, on its own card (#124, ADR-0143)', () => {
    const card = byTestId(draw(), ID);
    expect(card?.attributes['data-anchor']).toBe('judging-record');
    expect(card?.attributes.id).toBeUndefined();
  });

  it.each([
    ['closed', true, false, copy.marketStatusJudgementDelayed],
    ['provisional', false, true, copy.marketStatusDisputeUnderReview],
  ] as const)(
    'uses the public display label for %s with delay/review flags',
    (status, judgementDelayed, disputeUnderReview, expected) => {
      const html = draw({ ...EMPTY, status, judgementDelayed, disputeUnderReview });
      expect(byTestId(html, `${ID}-status`)?.text).toContain(expected);
    },
  );

  it('hides retained history after a correction while keeping the principle and current status', () => {
    const fresh: JudgingRecordMarket = {
      ...EMPTY,
      status: 'provisional',
      resolvedResult: 'NO',
      judgingRecord: { ...EMPTY.judgingRecord, versions: [VERSION] },
    };
    const stale = draw({ ...fresh, judgingRecordStale: true });
    expect(byTestId(stale, `${ID}-stale`)?.text).toBe(copy.judgingRecordStale);
    expect(byTestId(stale, `${ID}-principle`)?.text).toBe(copy.judgingPrinciple);
    expect(byTestId(stale, `${ID}-status`)?.text).toContain('잠정 결과');
    expect(byTestId(stale, `${ID}-version-1`)).toBeUndefined();
    expect(byTestId(stale, `${ID}-disputes`)).toBeUndefined();
    expect(byTestId(stale, `${ID}-empty`)).toBeUndefined();
    expect(stale).not.toContain(VERSION.description);
    expect(stale).not.toContain(copy.judgingCurrentVersion);

    const recovered = draw({
      ...fresh,
      judgingRecord: {
        ...fresh.judgingRecord,
        versions: [
          { ...VERSION, version: 2, result: 'NO', correctionReason: '정정된 근거' },
          VERSION,
        ],
      },
    });
    expect(byTestId(recovered, `${ID}-stale`)).toBeUndefined();
    expect(byTestId(recovered, `${ID}-version-2-result`)?.text).toBe('NO');
    expect(byTestId(recovered, `${ID}-version-2`)?.text).toContain(copy.judgingCurrentVersion);
  });

  it('hides completion times and all status-specific history while the snapshot is stale', () => {
    const html = draw({
      ...EMPTY,
      status: 'settled',
      resolvedResult: 'YES',
      resolvedAt: '2026-11-11T02:00:00.000Z',
      settledAt: '2026-11-11T02:05:00.000Z',
      judgingRecordStale: true,
      judgingRecord: {
        ...EMPTY.judgingRecord,
        versions: [VERSION],
        payoutDelayed: true,
        cancellation: { reason: '이전 취소 기록', cancelledAt: '2026-11-09T03:00:00.000Z' },
        pauses: [
          {
            reason: 'basis_change',
            note: '이전 중단 기록',
            pausedAt: '2026-11-09T01:00:00.000Z',
            resultPublishedAt: null,
            reviewResult: null,
            endKind: null,
            endedAt: null,
          },
        ],
        delays: [
          { reason: '이전 지연 기록', nextReviewAt: '2026-11-10T00:00:00.000Z', current: true },
        ],
      },
    });
    expect(byTestId(html, `${ID}-stale`)?.text).toBe(copy.judgingRecordStale);
    for (const suffix of [
      'resolved-at',
      'settled-at',
      'payout-delay',
      'version-1',
      'cancellation',
      'pauses',
      'delays',
      'disputes',
    ]) {
      expect(byTestId(html, `${ID}-${suffix}`), suffix).toBeUndefined();
    }
    expect(byTagName(html, 'time')).toHaveLength(0);
  });

  it('shows the fixed judging principle and actual status in every public state', () => {
    for (const status of [
      'scheduled',
      'open',
      'paused',
      'closed',
      'provisional',
      'resolved',
      'settling',
      'settled',
      'cancelled',
    ] as const) {
      const html = draw({ ...EMPTY, status });
      expect(byTestId(html, `${ID}-principle`)?.text).toBe(copy.judgingPrinciple);
      // Beside it, on every state, the link to the guide's 판정과 이의 (ADR-0107 결정 4 #24, #136).
      const guide = byTestId(html, `${ID}-guide-link`);
      expect(guide?.attributes.href).toBe('/guide#judgement');
      expect(guide?.text).toBe(copy.guideLinkJudgement);
      expect(html).not.toContain('href="/principles');
      expect(html).not.toContain(copy.comingSoon);
    }
  });

  it('distinguishes an unpublished judgement, a legacy result and a cancelled market', () => {
    expect(byTestId(draw(), `${ID}-empty`)?.text).toContain(copy.judgingNoVersion);
    const legacy = draw({ ...EMPTY, status: 'settled', resolvedResult: 'NO' });
    expect(byTestId(legacy, `${ID}-empty`)?.text).toContain(copy.judgingLegacyNoGrounds);
    expect(legacy).not.toContain(copy.judgingNoVersion);
    const cancelled = draw({
      ...EMPTY,
      status: 'cancelled',
      judgingRecord: {
        ...EMPTY.judgingRecord,
        cancellation: {
          reason: '사람의 체결이 없어 취소합니다.',
          cancelledAt: '2026-11-09T03:00:00.000Z',
        },
      },
    });
    expect(byTestId(cancelled, `${ID}-empty`)?.text).toContain(copy.judgingCancelledNoJudgement);
    expect(byTestId(cancelled, `${ID}-cancellation`)?.text).toContain(
      '사람의 체결이 없어 취소합니다.',
    );
    expect(byTestId(cancelled, `${ID}-cancelled-at-viewer-zone`)).toBeDefined();
  });

  it('renders approved evidence, fallback and correction grounds with earlier versions in disclosures', () => {
    const html = draw({
      ...EMPTY,
      status: 'provisional',
      resolvedResult: 'NO',
      judgingRecord: {
        ...EMPTY.judgingRecord,
        versions: [
          {
            ...VERSION,
            version: 2,
            result: 'NO',
            source: { priority: 1, name: '대체 발표', url: 'https://example.com/fallback' },
            fallbackReason: '1차 출처의 발표가 지연되었습니다.',
            correctionReason: '정정된 공식 자료를 반영했습니다.',
          },
          VERSION,
        ],
      },
    });
    expect(byTestId(html, `${ID}-version-2-source`)?.text).toContain(
      `${copy.judgingFallbackSource} 1`,
    );
    expect(byTestId(html, `${ID}-version-2-fallback`)?.text).toContain(
      '1차 출처의 발표가 지연되었습니다.',
    );
    expect(byTestId(html, `${ID}-version-2-correction`)?.text).toContain(
      '정정된 공식 자료를 반영했습니다.',
    );
    expect(byTestId(html, `${ID}-version-2-description`)?.text).toBe(VERSION.description);
    expect(byTestId(html, `${ID}-version-2-rule-version`)?.text).toBe('v3');
    expect(byTagName(html, 'details')).toHaveLength(1);
    expect(byTagName(html, 'details')[0]?.attributes.open).toBeUndefined();
    expect(evidenceLinks(html).every((link) => link.attributes.rel === 'noopener noreferrer')).toBe(
      true,
    );
    expect(evidenceLinks(html).map((link) => link.attributes.href)).toContain(
      VERSION.evidence.links[0],
    );
    const ids = testIdsStartingWith(html, ID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('labels VOID as 무효 and shows its reason without inventing a source or rule version', () => {
    const html = draw({
      ...EMPTY,
      status: 'provisional',
      resolvedResult: 'VOID',
      judgingRecord: {
        ...EMPTY.judgingRecord,
        versions: [
          {
            ...VERSION,
            result: 'VOID',
            source: null,
            ruleVersion: null,
            voidReason: '공식 기록이 없어 규칙으로 판정할 수 없습니다.',
          },
        ],
      },
    });
    expect(byTestId(html, `${ID}-version-1-result`)?.text).toBe('무효');
    expect(byTestId(html, `${ID}-version-1-source`)?.text).toBe(copy.judgingNoSource);
    expect(byTestId(html, `${ID}-version-1-rule-version`)?.text).toBe(copy.judgingNoRuleVersion);
    expect(byTestId(html, `${ID}-version-1-void`)?.text).toContain('공식 기록이 없어');
  });

  it('separates confirmation and payout completion and shows a payout delay only when reported', () => {
    const settling: JudgingRecordMarket = {
      ...EMPTY,
      status: 'settling',
      resolvedResult: 'YES',
      resolvedAt: '2026-11-11T02:00:00.000Z',
      judgingRecord: { ...EMPTY.judgingRecord, versions: [VERSION], payoutDelayed: true },
    };
    const html = draw(settling);
    expect(byTestId(html, `${ID}-resolved-at-viewer-zone`)).toBeDefined();
    expect(byTestId(html, `${ID}-settled-at-viewer-zone`)).toBeUndefined();
    expect(byTestId(html, `${ID}-payout-delay`)?.text).toContain(copy.judgingPayoutDelayed);
    const settled = draw({
      ...settling,
      status: 'settled',
      settledAt: '2026-11-11T02:05:00.000Z',
      judgingRecord: { ...settling.judgingRecord, payoutDelayed: false },
    });
    expect(byTestId(settled, `${ID}-settled-at-viewer-zone`)).toBeDefined();
    expect(byTestId(settled, `${ID}-payout-delay`)).toBeUndefined();
  });

  it('retains public pause, delay and dispute decision history anonymously', () => {
    const html = draw({
      ...EMPTY,
      status: 'provisional',
      judgingRecord: {
        ...EMPTY.judgingRecord,
        pauses: [
          {
            reason: 'early_result',
            note: '사건 결과가 먼저 공개되었습니다.',
            resultPublishedAt: '2026-11-08T01:00:00.000Z',
            pausedAt: '2026-11-08T02:00:00.000Z',
            reviewResult: null,
            endKind: 'early_closed',
            endedAt: '2026-11-08T03:00:00.000Z',
          },
        ],
        delays: [
          { reason: '현재 자료 확인 중', nextReviewAt: '2026-11-10T00:00:00.000Z', current: true },
          { reason: '이전 자료 확인 중', nextReviewAt: '2026-11-09T00:00:00.000Z', current: false },
        ],
        disputes: {
          total: 2,
          byVersion: [
            {
              judgementVersion: 1,
              total: 2,
              counts: {
                pending: 0,
                dismissed: 1,
                accepted: 0,
                retracted: 0,
                closed_by_correction: 1,
              },
            },
          ],
          decisions: [
            { judgementVersion: 1, decision: 'accepted', reason: '새로운 공식 자료를 반영합니다.' },
            { judgementVersion: 1, decision: 'dismissed', reason: '기존 출처와 같은 자료입니다.' },
          ],
        },
      },
    });
    expect(byTestId(html, `${ID}-pauses`)?.text).toContain('사건 결과가 먼저 공개되었습니다.');
    expect(byTestId(html, `${ID}-pause-0-ended`)?.text).toContain('2026');
    expect(byTestId(html, `${ID}-delays`)?.text).toContain(copy.judgingPreviousDelay);
    expect(byTestId(html, `${ID}-disputes`)?.text).toContain('새로운 공식 자료를 반영합니다.');
    expect(byTestId(html, `${ID}-disputes`)?.text).toContain(copy.judgingOperator);
  });

  it('omits a withheld legacy note while retaining public pause times and review facts', () => {
    const html = draw({
      ...EMPTY,
      judgingRecord: {
        ...EMPTY.judgingRecord,
        pauses: [
          {
            reason: 'basis_change',
            note: null,
            resultPublishedAt: null,
            pausedAt: '2026-11-08T02:00:00.000Z',
            reviewResult: 'judgeable',
            endKind: 'resumed',
            endedAt: '2026-11-08T03:00:00.000Z',
          },
        ],
      },
    });
    expect(byTestId(html, `${ID}-pause-0-note`)).toBeUndefined();
    expect(html).not.toContain(copy.judgingPauseNote);
    expect(byTestId(html, `${ID}-pause-0-reason`)?.text).toContain(copy.pauseReasonBasisChange);
    expect(byTestId(html, `${ID}-pause-0-review`)?.text).toContain(copy.pauseReviewJudgeable);
    expect(byTestId(html, `${ID}-pause-0-started`)).toBeDefined();
    expect(byTestId(html, `${ID}-pause-0-ended`)).toBeDefined();
  });

  it('renders viewer and differing judgement time zones using the shared time component', () => {
    const market = { ...EMPTY, judgingRecord: { ...EMPTY.judgingRecord, versions: [VERSION] } };
    const html = renderWithQueries(
      <TimeZoneScope zone="America/New_York" settled>
        <MarketJudgingRecord market={market} testId={ID} />
      </TimeZoneScope>,
    );
    expect(byTestId(html, `${ID}-version-1-collected-at-viewer-zone`)?.text).toBe(
      formatInTimeZone(VERSION.evidence.collectedAt, 'America/New_York'),
    );
    expect(byTestId(html, `${ID}-version-1-collected-at-judgement-zone`)?.text).toContain(
      formatInTimeZone(VERSION.evidence.collectedAt, 'Asia/Seoul'),
    );
  });
});

describe('판정 정정 and the 결과 확정 뒤 report line (#144, ADR-0165)', () => {
  const CORRECTION: NonNullable<JudgingRecordMarket['judgingRecord']['correction']> = {
    result: 'NO',
    originalResult: 'YES',
    judgementVersion: 1,
    confirmedAt: '2026-11-12T03:00:00.000Z',
    description: '1차 출처가 발표를 정정했습니다.\n정정 발표의 결과는 NO입니다.',
    evidence: {
      links: ['https://example.com/fix', 'https://example.com/fix-2'],
      collectedAt: '2026-11-12T01:00:00.000Z',
    },
    compensation: { status: 'preparing', accountCount: null, paidCount: null, totalCoin: null },
  };
  const corrected: JudgingRecordMarket = {
    ...EMPTY,
    status: 'settled',
    // The market row keeps the paid result and its version stays the current one.
    resolvedResult: 'YES',
    resolvedAt: '2026-11-11T02:00:00.000Z',
    settledAt: '2026-11-11T02:05:00.000Z',
    judgingRecord: { ...EMPTY.judgingRecord, versions: [VERSION], correction: CORRECTION },
  };

  it('puts the section above the versions: corrected and original result, the fact, grounds, time', () => {
    const html = draw(corrected);
    const section = byTestId(html, `${ID}-correction`);
    expect(section?.text).toContain(copy.judgingCorrection);
    expect(byTestId(html, `${ID}-correction-result`)?.text).toBe(copy.no);
    expect(byTestId(html, `${ID}-correction-original`)?.text).toBe(`${copy.yes} (v1)`);
    expect(byTestId(html, `${ID}-correction-no-clawback`)?.text).toBe(
      '원래 결과로 지급했고, 지급한 Coin은 회수하지 않습니다.',
    );
    expect(byTestId(html, `${ID}-correction-description`)?.text).toBe(CORRECTION.description);
    for (const link of CORRECTION.evidence.links) {
      expect(byTestId(html, `${ID}-correction-evidence`)?.text).toContain(link);
    }
    expect(byTestId(html, `${ID}-correction-collected-at-viewer-zone`)).toBeDefined();
    expect(byTestId(html, `${ID}-correction-confirmed-at-viewer-zone`)).toBeDefined();
    // Above the versions, which keep the paid version's name '현재 판정' (144-19 (나)).
    expect(html.indexOf(`data-testid="${ID}-correction"`)).toBeLessThan(
      html.indexOf(`data-testid="${ID}-version-1"`),
    );
    expect(byTestId(html, `${ID}-version-1`)?.text).toContain(`${copy.judgingCurrentVersion} v1`);
    // No identity, no reviewer's reason: the public shape has none, and nothing names one.
    expect(section?.text).not.toContain('관리자');
    expect(evidenceLinks(html).every((link) => link.attributes.rel === 'noopener noreferrer')).toBe(
      true,
    );
    const ids = testIdsStartingWith(html, ID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says the 보상 as 144-15 words it: four states, the closed targets apart, no account (#144)', () => {
    const drawnWith = (compensation: typeof CORRECTION.compensation) =>
      byTestId(
        draw({
          ...corrected,
          judgingRecord: {
            ...corrected.judgingRecord,
            correction: { ...CORRECTION, compensation },
          },
        }),
        `${ID}-correction-compensation`,
      )?.text;
    expect(
      drawnWith({ status: 'preparing', accountCount: null, paidCount: null, totalCoin: null }),
    ).toBe('보상 준비 중');
    expect(
      drawnWith({ status: 'none', accountCount: null, paidCount: null, totalCoin: null }),
    ).toBe('보상 대상 없음');
    expect(
      drawnWith({ status: 'pending', accountCount: 3, paidCount: null, totalCoin: null }),
    ).toBe('승인 대기 · 대상 계정 3개');
    expect(drawnWith({ status: 'paid', accountCount: 1, paidCount: 1, totalCoin: '100' })).toBe(
      '지급 완료 · 대상 계정 1개 · 총 100 Coin',
    );
    expect(drawnWith({ status: 'paid', accountCount: 3, paidCount: 2, totalCoin: '1250' })).toBe(
      '지급 완료 · 대상 계정 3개 중 2개 지급 · 총 1,250 Coin',
    );
    // Every target closed: the 대상 count stays beside the 0 Coin.
    expect(drawnWith({ status: 'paid', accountCount: 2, paidCount: 0, totalCoin: '0' })).toBe(
      '지급 완료 · 대상 계정 2개 중 0개 지급 · 총 0 Coin',
    );
    // In the section, after its times; never a word of P&L, refund or 정답.
    const html = draw(corrected);
    expect(byTestId(html, `${ID}-correction`)?.text).toContain('보상 준비 중');
    for (const text of [
      copy.judgingCompensation,
      copy.judgingCompensationPreparing,
      copy.judgingCompensationNone,
      copy.judgingCompensationPending,
      copy.judgingCompensationPaid,
      copy.judgingCompensationPaidPartly,
    ]) {
      expect(findExcludedText(text), text).toEqual([]);
      expect(text, text).not.toMatch(/환불|원금|손익|정답|맞힌|정산 오류|리워드|적립/);
    }
  });

  it('draws no section without a correction, nor while the snapshot is stale', () => {
    expect(
      byTestId(
        draw({ ...corrected, judgingRecord: { ...corrected.judgingRecord, correction: null } }),
        `${ID}-correction`,
      ),
    ).toBeUndefined();
    const stale = draw({ ...corrected, judgingRecordStale: true });
    expect(byTestId(stale, `${ID}-correction`)).toBeUndefined();
    expect(stale).not.toContain(CORRECTION.description);
  });

  it('carries 144-9’s line, with the customer centre’s address, from 결과 확정 on — stale too', () => {
    for (const status of ['resolved', 'settling', 'settled'] as const) {
      const html = draw({ ...EMPTY, status });
      const line = byTestId(html, `${ID}-report`)?.text;
      expect(line, status).toBe(postPayoutReportText());
      expect(line, status).toContain('결과 확정 뒤의 판정 오류는 고객센터 이메일');
      expect(line, status).not.toContain('{{');
      // Outside the body a stale snapshot hides, beside the principle.
      expect(
        byTestId(draw({ ...EMPTY, status, judgingRecordStale: true }), `${ID}-report`),
        status,
      ).toBeDefined();
    }
    expect(postPayoutReportText()).toBe(
      copy.judgingPostPayoutReport.replace('{{email}}', BUSINESS_INFO.email),
    );
    for (const status of [
      'scheduled',
      'open',
      'paused',
      'closed',
      'provisional',
      'cancelled',
    ] as const) {
      expect(byTestId(draw({ ...EMPTY, status }), `${ID}-report`), status).toBeUndefined();
      expect(showsPostPayoutReport(status), status).toBe(false);
    }
  });
});
