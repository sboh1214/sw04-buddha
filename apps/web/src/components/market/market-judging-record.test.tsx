import { describe, expect, it } from 'vitest';
import { TimeZoneScope } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { formatInTimeZone } from '@/lib/datetime';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { MarketJudgingRecord, type JudgingRecordMarket } from './market-judging-record';

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
const draw = (market: JudgingRecordMarket = EMPTY) =>
  renderWithQueries(<MarketJudgingRecord market={market} testId={ID} />);

describe('public judging record (#24)', () => {
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
    expect(
      byTagName(html, 'a').every((link) => link.attributes.rel === 'noopener noreferrer'),
    ).toBe(true);
    expect(byTagName(html, 'a').map((link) => link.attributes.href)).toContain(
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
