import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type Market, type MarketJudgementDelay } from '@/lib/api';
import { byTestId, renderWithQueries } from '@/test/render';
import { StatusNotice } from './market-detail';

const SCHEDULED_JUDGEMENT_AT = '2026-12-01T01:00:00.000Z';

/** A CLOSED market past its scheduled judgement: it reads 판정 지연 (#173 item 11, #22). */
const delayed: Market = {
  id: '1f2e3d4c-0000-4000-8000-0000000000aa',
  slug: 'first-snow',
  title: '첫눈이 올까?',
  category: { slug: 'weather', nameKo: '날씨' },
  imageUrl: null,
  status: 'closed',
  judgementDelayed: true,
  disputeUnderReview: false,
  lastPrice: 63,
  lastFillAt: '2026-09-07T00:00:00.000Z',
  lastPrice24hAgo: null,
  volumeCoin: '123456',
  tradeCount: 789,
  traderCount: 321,
  closeAt: '2026-11-29T15:00:00.000Z',
  openAt: '2026-11-01T00:00:00.000Z',
  resolvedResult: null,
  judgementVersion: null,
  disputeDeadline: null,
  disputeOpen: false,
  judgementDelay: null,
  statusEventId: '3',
  createdAt: '2026-10-01T00:00:00.000Z',
  description: null,
  yesCondition: '관측되면 YES',
  noCondition: '',
  eventDeadline: null,
  primarySource: null,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: 14,
  delayHandling: '',
  scheduledOpenAt: null,
  scheduledAnnouncementAt: null,
  scheduledJudgementAt: SCHEDULED_JUDGEMENT_AT,
  judgementTimeZone: 'America/New_York',
  resolvedAt: null,
  settledAt: null,
  tags: [],
  ruleVersion: 1,
  ruleVersions: [],
};

const record: MarketJudgementDelay = {
  reason: '출처의 발표가 늦어지고 있습니다.\n다음 주에 다시 확인합니다.',
  nextReviewAt: '2026-12-02T01:00:00.000Z',
  nextReviewPassed: false,
};

const notice = (market: Market, now?: number) =>
  renderWithQueries(<StatusNotice market={market} now={now} />);

/**
 * The detail's 상태별 안내 with a 판정 지연 기록 (#142, ADR-0106; ADR-0093 decision 3 '#142 지연
 * 사유', #173 items 11·13, owner answer 2026-11-03 (2)): the current record's reason and next
 * review time under the delay's sentence, '갱신 대기' once that time has passed, never who recorded
 * it or when. What the API sends is its own (private-data.test.ts); the e2e (delay.spec.ts) watches
 * the marker come without a reload.
 */
describe('StatusNotice: 판정 지연 기록 (#142)', () => {
  it('adds the reason and the next review time under a delayed CLOSED market’s sentence', () => {
    const html = notice({ ...delayed, judgementDelay: record });
    expect(byTestId(html, 'market-status-notice')?.text).toContain(
      copy.marketJudgementDelayedNotice,
    );
    expect(byTestId(html, 'market-detail-delay-reason')?.text).toBe(record.reason);
    const row = byTestId(html, 'market-detail-next-review');
    expect(row?.text).toContain(copy.marketNextReviewAt);
    expect(row?.attributes['data-passed']).toBe('false');
    // The viewer's zone (and, once the zone is settled, the 판정 기준 시간대: `DateTimeText`).
    expect(byTestId(html, 'market-detail-next-review-viewer-zone')?.text).toContain('2026');
    // Not passed yet: no marker, no note.
    expect(byTestId(html, 'market-detail-next-review-passed')).toBeUndefined();
    expect(byTestId(html, 'market-detail-next-review-passed-note')).toBeUndefined();
    // The result row stays away: there is none (never a NO for being late).
    expect(byTestId(html, 'market-detail-result')).toBeUndefined();
  });

  it('marks the time passed as 갱신 대기, keeping the reason, and says nothing came of it', () => {
    const html = notice({ ...delayed, judgementDelay: { ...record, nextReviewPassed: true } });
    expect(byTestId(html, 'market-detail-delay-reason')?.text).toBe(record.reason);
    expect(byTestId(html, 'market-detail-next-review')?.attributes['data-passed']).toBe('true');
    expect(byTestId(html, 'market-detail-next-review-passed')?.text).toBe(
      copy.marketNextReviewPassed,
    );
    expect(byTestId(html, 'market-detail-next-review-passed-note')?.text).toBe(
      copy.marketNextReviewPassedNote,
    );
    // The first render is the API's flag alone, whatever the anchor says (no clock in render).
    const ahead = notice({ ...delayed, judgementDelay: record }, Date.parse(record.nextReviewAt));
    expect(byTestId(ahead, 'market-detail-next-review-passed')).toBeUndefined();
  });

  it('draws no rows for a delay with no record, nor for a record on a market not delayed', () => {
    const bare = notice(delayed);
    expect(byTestId(bare, 'market-status-notice')?.text).toContain(
      copy.marketJudgementDelayedNotice,
    );
    expect(byTestId(bare, 'market-detail-delay-reason')).toBeUndefined();
    expect(byTestId(bare, 'market-detail-next-review')).toBeUndefined();
    // A row the socket moved on keeps no record (`applyStatus` resets both): none is drawn.
    const moved = notice({ ...delayed, judgementDelayed: false, judgementDelay: record });
    expect(byTestId(moved, 'market-detail-delay-reason')).toBeUndefined();
    expect(byTestId(moved, 'market-status-notice')?.text).toContain(copy.marketClosedNotice);
  });

  it('adds the rows under a 잠정 결과 held past its deadline, after its result and deadline', () => {
    const held: Market = {
      ...delayed,
      status: 'provisional',
      resolvedResult: 'NO',
      judgementVersion: 1,
      disputeDeadline: '2026-12-01T03:00:00.000Z',
      disputeUnderReview: true,
      judgementDelay: record,
    };
    const html = notice(held);
    expect(byTestId(html, 'market-status-notice-detail')?.text).toBe(copy.marketProvisionalDelayed);
    expect(byTestId(html, 'market-detail-result')?.text).toBe('NO');
    expect(byTestId(html, 'market-detail-dispute-deadline')).toBeDefined();
    expect(byTestId(html, 'market-detail-delay-reason')?.text).toBe(record.reason);
    expect(html.indexOf('market-detail-dispute-deadline')).toBeLessThan(
      html.indexOf('market-detail-delay-reason'),
    );
    // The two delay rows are a list of their own; the result and deadline rows keep theirs.
    const rows = byTestId(html, 'market-detail-delay-rows');
    expect(rows?.text).toContain(record.reason);
    expect(rows?.text).toContain(copy.marketNextReviewAt);
    expect(rows?.text).not.toContain(copy.marketResolvedResult);
    expect(rows?.text).not.toContain(copy.marketDisputeDeadline);
  });

  it('puts each delay row’s label above its value below md, the result rows beside as before', () => {
    // A static render holds no media query, so the layout is pinned in the source: a reason of up
    // to 500 characters gets the phone's width, not a strip beside a 120px label column.
    const source = readFileSync(new URL('./market-detail.tsx', import.meta.url), 'utf8');
    const component = source.slice(source.indexOf('export function StatusNotice('));
    const at = component.indexOf('data-testid="market-detail-delay-rows"');
    expect(component.slice(component.lastIndexOf('<DataList.Root', at), at)).toContain(
      "orientation={{ base: 'vertical', md: 'horizontal' }}",
    );
    const delayRows = component.slice(at, component.indexOf('</DataList.Root>', at));
    expect(delayRows).toContain('data-testid="market-detail-delay-reason"');
    expect(delayRows).toContain('data-testid="market-detail-next-review"');
    // Each item restates its direction, or the vertical recipe's column lasts past md (`RuleRow`).
    expect(delayRows.match(/<DataList\.Item\b[^>]*>/g)).toHaveLength(2);
    for (const item of delayRows.match(/<DataList\.Item\b[^>]*>/g) ?? []) {
      expect(item).toContain("flexDirection={{ base: 'column', md: 'row' }}");
    }
    expect(component.slice(component.indexOf('{resultRows && ('), at)).toContain(
      '<DataList.Root orientation="horizontal" size="sm">',
    );
  });

  it('names no operator and promises no result in its words (#173 item 13, N03 §4)', () => {
    for (const text of [
      copy.marketJudgementDelayReason,
      copy.marketNextReviewAt,
      copy.marketNextReviewPassed,
      copy.marketNextReviewPassedNote,
    ]) {
      expect(text).not.toMatch(/관리자|운영자|NO|환불|원금/);
    }
    const html = notice({ ...delayed, judgementDelay: { ...record, nextReviewPassed: true } });
    expect(byTestId(html, 'market-status-notice')?.text).not.toMatch(/관리자|운영자/);
  });

  it('flips the marker by a one-shot timer from the server’s now, never a clock read in render', () => {
    // No component renders under node with effects, so the wiring is pinned in the source: the
    // timer waits for the shown record's time while the API read it ahead, from the detail's `now`.
    const source = readFileSync(new URL('./market-detail.tsx', import.meta.url), 'utf8');
    const component = source.slice(source.indexOf('export function StatusNotice('));
    expect(component).toContain('const delay = shownJudgementDelay(market);');
    expect(component).toContain(
      'const reviewCame = useInstantReached(nextReviewWaitAt(delay), now, readAgain);',
    );
    expect(component).toContain(
      'const reviewPassed = delay !== null && (delay.nextReviewPassed || reviewCame);',
    );
    expect(component.slice(0, component.indexOf('\n}\n'))).not.toContain('Date.now()');
  });
});
