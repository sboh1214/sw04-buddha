import {
  MARKET_STATUSES,
  PROPOSED_CONTRACT_TERMS,
  formatCoin,
  longDelayDeadline,
} from '@buddha/shared';
import { type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { KstTimeZone, TimeZoneScope } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { SEOUL_TIME_ZONE, formatInTimeZone } from '@/lib/datetime';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { RulesSection, type RulesSectionMarket } from './rules-section';

const ID = 'rules';

/** A market with every rule item filled in and two fallbacks. */
const FULL: RulesSectionMarket = {
  yesCondition: '2026년 11월 30일까지 첫눈이 관측되면 YES입니다.\n서울 관측소 기준입니다.',
  noCondition: '사건 기한까지 첫눈이 관측되지 않으면 NO입니다.',
  eventDeadline: '2026-11-30T14:59:00.000Z',
  primarySource: { name: '기상청 날씨누리', url: 'https://www.weather.go.kr/w/index.do' },
  fallbackSources: [
    { name: '기상자료개방포털', url: 'https://data.kma.go.kr' },
    { name: '서울기상관측소 발표', url: 'http://example.com/seoul' },
  ],
  fallbackCondition: '1차 출처가 12월 7일까지 발표하지 않으면 대체 출처를 순서대로 확인합니다.',
  longDelayDays: 14,
  delayHandling: '장기 지연 기한까지 확인할 수 없으면 무효로 판정합니다.',
  status: 'open',
  // #22's times: 11-01 09:00, 11-30 00:00, 11-30 11:00 and 12-01 10:00 KST.
  scheduledOpenAt: '2026-11-01T00:00:00.000Z',
  closeAt: '2026-11-29T15:00:00.000Z',
  scheduledAnnouncementAt: '2026-11-30T02:00:00.000Z',
  scheduledJudgementAt: '2026-12-01T01:00:00.000Z',
  judgementTimeZone: 'Asia/Seoul',
};

/** A market opened before #23 and #22: every rule item blank, and no time but the close. */
const BLANK: RulesSectionMarket = {
  yesCondition: '',
  noCondition: '',
  eventDeadline: null,
  primarySource: null,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: null,
  delayHandling: '',
  status: 'open',
  scheduledOpenAt: null,
  closeAt: '2026-11-29T15:00:00.000Z',
  scheduledAnnouncementAt: null,
  scheduledJudgementAt: null,
  judgementTimeZone: null,
};

/** As the server renders it: outside any time-zone provider, so KST and never settled. */
const draw = (market: RulesSectionMarket, wrap: (node: ReactNode) => ReactNode = (node) => node) =>
  renderWithQueries(wrap(<RulesSection market={market} data-testid={ID} />));

/** As a settled viewer in `zone` reads it, once hydrated and the profile known (ADR-0063). */
const settledIn = (zone: string) => (node: ReactNode) => (
  <TimeZoneScope zone={zone} settled>
    {node}
  </TimeZoneScope>
);

/** The test ids of a time's two lines inside a row (`DateTimeText`). */
const LINE = /-(viewer|judgement)-zone$/;

/** The row values' test ids, in the order they are drawn. */
const rows = (html: string) => testIdsStartingWith(html, `${ID}-`).filter((id) => !LINE.test(id));

/** Every time row's test id but the long delay's, in the order they are drawn. */
const TIME_ROWS = ['event-deadline', 'close-at', 'announcement-at', 'judgement-at'];

const NEW_YORK = 'America/New_York';

const value = (html: string, row: string) => byTestId(html, `${ID}-${row}`)?.text;

/**
 * 규칙 on the market detail (#23, ADR-0097): every rule item but 배경 — its own section — one row
 * each, the fixed 무효 지급 line and the times with the 판정 기준 시간대 (#22, ADR-0098), never
 * collapsed (ADR-0093 decision 3 '#23 문장 길이와 표시'). Rendered as the server's HTML is, which is
 * what AC 2 reads out of view-source, and as a settled viewer reads it (`settledIn`) for the
 * judgement zone's second line. The e2e (market-rules.spec.ts, market-times.spec.ts) fills the
 * items through the admin form and reads the public detail.
 */
describe('RulesSection', () => {
  it('draws every rule item in the form order, then 무효 지급 and the times (#22)', () => {
    const html = draw(FULL);
    expect(rows(html)).toEqual([
      `${ID}-yes`,
      `${ID}-no`,
      `${ID}-event-deadline`,
      `${ID}-primary-source`,
      `${ID}-fallback-sources`,
      `${ID}-fallback-condition`,
      `${ID}-long-delay`,
      `${ID}-delay-handling`,
      `${ID}-void-payout`,
      `${ID}-close-at`,
      `${ID}-announcement-at`,
      `${ID}-judgement-at`,
      `${ID}-judgement-time-zone`,
    ]);
    expect(byTagName(html, 'h2').map((heading) => heading.text)).toEqual([copy.rulesSectionTitle]);
    expect(byTagName(html, 'dt').map((label) => label.text)).toEqual([
      copy.rulesYes,
      copy.rulesNo,
      copy.rulesEventDeadline,
      copy.rulesPrimarySource,
      copy.rulesFallbackSources,
      copy.rulesFallbackCondition,
      copy.rulesLongDelay,
      copy.rulesDelayHandling,
      copy.rulesVoidPayout,
      copy.rulesCloseAt,
      copy.rulesAnnouncementAt,
      copy.rulesJudgementAt,
      copy.rulesJudgementTimeZone,
    ]);
    // No row label is a status badge's word: '거래 마감' and '개장 예정' are statuses (C12).
    const labels = byTagName(html, 'dt').map((label) => label.text);
    expect(labels).not.toContain(copy.marketStatusClosed);
    expect(labels).not.toContain(copy.marketStatusScheduled);
  });

  it('writes each text as it was written, line breaks kept, and the times in KST on the server', () => {
    const html = draw(FULL);
    expect(value(html, 'yes')).toBe(FULL.yesCondition);
    expect(value(html, 'no')).toBe(FULL.noCondition);
    expect(value(html, 'fallback-condition')).toBe(FULL.fallbackCondition);
    expect(value(html, 'delay-handling')).toBe(FULL.delayHandling);
    // Outside a time-zone provider, as on the server, every time is KST (ADR-0063).
    const kst = (iso: string | null) => formatInTimeZone(iso ?? '', SEOUL_TIME_ZONE);
    expect(value(html, 'event-deadline')).toBe(kst(FULL.eventDeadline));
    expect(value(html, 'close-at')).toBe(kst(FULL.closeAt));
    expect(value(html, 'announcement-at')).toBe(kst(FULL.scheduledAnnouncementAt));
    expect(value(html, 'judgement-at')).toBe(kst(FULL.scheduledJudgementAt));
    // Each time's own line has an element of its own, for a test to read it by.
    for (const row of TIME_ROWS) {
      expect(value(html, `${row}-viewer-zone`), row).toBe(value(html, row));
    }
    // AC 2: the YES 조건 is in the HTML itself, before any script runs.
    expect(html).toContain('서울 관측소 기준입니다.');
  });

  it('shows 예정 개장 시각 before the open only, right before the close (#22)', () => {
    for (const status of MARKET_STATUSES) {
      const html = draw({ ...FULL, status });
      const before = status === 'draft' || status === 'review' || status === 'scheduled';
      expect(byTestId(html, `${ID}-scheduled-open-at`) !== undefined, status).toBe(before);
      if (!before) continue;
      const drawn = rows(html);
      expect(drawn.indexOf(`${ID}-scheduled-open-at`), status).toBe(
        drawn.indexOf(`${ID}-close-at`) - 1,
      );
      expect(value(html, 'scheduled-open-at')).toBe(
        formatInTimeZone(FULL.scheduledOpenAt ?? '', SEOUL_TIME_ZONE),
      );
      expect(byTagName(html, 'dt').map((label) => label.text)).toContain(copy.rulesScheduledOpenAt);
    }
    // A draft in the admin preview with none yet reads '—'.
    expect(value(draw({ ...BLANK, status: 'draft' }), 'scheduled-open-at')).toBe('—');
  });

  it("reads '없음' for no announcement time and '—' for a judgement or zone not filled in", () => {
    const html = draw({ ...FULL, scheduledAnnouncementAt: null });
    expect(value(html, 'announcement-at')).toBe(copy.rulesAnnouncementNone);
    const blank = draw(BLANK);
    expect(value(blank, 'announcement-at')).toBe(copy.rulesAnnouncementNone);
    expect(value(blank, 'judgement-at')).toBe('—');
    expect(value(blank, 'judgement-time-zone')).toBe('—');
    expect(value(blank, 'close-at')).toBe(formatInTimeZone(BLANK.closeAt, SEOUL_TIME_ZONE));
  });

  it('names the judgement zone by its IANA name on the server, and writes no marker there', () => {
    // The Korean name is the browser's ICU's (`TimeZoneNameText`), so the HTML holds the name only.
    const html = draw({ ...FULL, judgementTimeZone: NEW_YORK });
    expect(value(html, 'judgement-time-zone')).toBe(NEW_YORK);
    // Nor the second line: the server never draws it, whatever the zone (ADR-0063).
    expect(testIdsStartingWith(html, ID).filter((id) => id.endsWith('-judgement-zone'))).toEqual(
      [],
    );
    expect(html).not.toContain('(GMT');
    expect(html).not.toContain(copy.rulesJudgementZoneLine + ' ');
  });

  it('adds the long-delay instant after its days once there is a scheduled judgement (#22)', () => {
    const deadline = longDelayDeadline(FULL.scheduledJudgementAt, FULL.longDelayDays) ?? '';
    // 12-01 10:00 KST plus 14 × 24 hours.
    expect(deadline).toBe('2026-12-15T01:00:00.000Z');
    expect(value(draw(FULL), 'long-delay')).toBe(
      `예정 판정 시각에서 14일 뒤 · ${formatInTimeZone(deadline, SEOUL_TIME_ZONE)}`,
    );
    expect(value(draw(FULL), 'long-delay-viewer-zone')).toBe(
      formatInTimeZone(deadline, SEOUL_TIME_ZONE),
    );
    // No judgement yet: the days alone. No days: '—', judgement or not.
    expect(value(draw({ ...FULL, scheduledJudgementAt: null }), 'long-delay')).toBe(
      '예정 판정 시각에서 14일 뒤',
    );
    expect(value(draw({ ...FULL, longDelayDays: null }), 'long-delay')).toBe('—');
  });

  it('reads every time in the judgement zone too once settled in another zone, labelled (#22)', () => {
    const html = draw(FULL, settledIn(NEW_YORK));
    const deadline = longDelayDeadline(FULL.scheduledJudgementAt, FULL.longDelayDays) ?? '';
    const times: Record<string, string> = {
      'event-deadline': FULL.eventDeadline ?? '',
      'long-delay': deadline,
      'close-at': FULL.closeAt,
      'announcement-at': FULL.scheduledAnnouncementAt ?? '',
      'judgement-at': FULL.scheduledJudgementAt ?? '',
    };
    for (const [row, iso] of Object.entries(times)) {
      // The viewer's line in their own zone, marked; the second in Seoul, unmarked, so labelled.
      expect(value(html, `${row}-viewer-zone`), row).toBe(formatInTimeZone(iso, NEW_YORK));
      expect(value(html, `${row}-viewer-zone`), row).toMatch(/\(GMT-[45]\)$/);
      expect(value(html, `${row}-judgement-zone`), row).toBe(
        `${copy.rulesJudgementZoneLine} ${formatInTimeZone(iso, SEOUL_TIME_ZONE)}`,
      );
    }
    // The reverse: a Seoul viewer, a market judged in New York — its line carries the marker.
    const reverse = draw({ ...FULL, judgementTimeZone: NEW_YORK }, settledIn(SEOUL_TIME_ZONE));
    expect(value(reverse, 'close-at-viewer-zone')).toBe(
      formatInTimeZone(FULL.closeAt, SEOUL_TIME_ZONE),
    );
    expect(value(reverse, 'close-at-judgement-zone')).toBe(
      `${copy.rulesJudgementZoneLine} ${formatInTimeZone(FULL.closeAt, NEW_YORK)}`,
    );
    expect(value(reverse, 'close-at-judgement-zone')).toMatch(/\(GMT-[45]\)$/);
  });

  it('reads one line when the zones are one, when unsettled, and in the admin preview (#22)', () => {
    const second = (html: string) =>
      testIdsStartingWith(html, ID).filter((id) => id.endsWith('-judgement-zone'));
    // The same zone, under its own name or an alias the engine resolves to it.
    expect(second(draw(FULL, settledIn(SEOUL_TIME_ZONE)))).toEqual([]);
    expect(second(draw({ ...FULL, judgementTimeZone: 'ROK' }, settledIn(SEOUL_TIME_ZONE)))).toEqual(
      [],
    );
    // A market opened before #22 has no zone to read it in.
    expect(second(draw(BLANK, settledIn(NEW_YORK)))).toEqual([]);
    // The admin layout holds Seoul and never settles: KST alone, as every admin screen (#22 시간대).
    const preview = draw({ ...FULL, judgementTimeZone: NEW_YORK }, (node) => (
      <KstTimeZone>{node}</KstTimeZone>
    ));
    expect(second(preview)).toEqual([]);
    expect(preview).not.toContain('(GMT');
  });

  it('links each source name to its address in a new tab, the fallbacks numbered in priority order', () => {
    const html = draw(FULL);
    const links = byTagName(html, 'a');
    expect(links.map((link) => [link.text, link.attributes.href])).toEqual([
      ['기상청 날씨누리', 'https://www.weather.go.kr/w/index.do'],
      ['기상자료개방포털', 'https://data.kma.go.kr'],
      ['서울기상관측소 발표', 'http://example.com/seoul'],
    ]);
    for (const link of links) {
      expect(link.attributes.target).toBe('_blank');
      // The operator wrote the address, so not `ugc`; an outside one, so `nofollow`.
      expect(link.attributes.rel).toBe('noopener noreferrer nofollow');
    }
    expect(byTestId(html, `${ID}-primary-source`)?.text).toBe('기상청 날씨누리');
    // One ordered list: the browser numbers it 1. 2., the order being the priority.
    const [list, ...more] = byTagName(html, 'ol');
    expect(more).toEqual([]);
    expect(list?.text).toBe('기상자료개방포털서울기상관측소 발표');
    expect(byTagName(html, 'li').map((item) => item.text)).toEqual([
      '기상자료개방포털',
      '서울기상관측소 발표',
    ]);
  });

  it("reads '없음' for no fallback, and has no switch-condition row then", () => {
    const html = draw({ ...FULL, fallbackSources: [], fallbackCondition: '' });
    expect(value(html, 'fallback-sources')).toBe(copy.rulesFallbackNone);
    expect(byTestId(html, `${ID}-fallback-condition`)).toBeUndefined();
    expect(byTagName(html, 'ol')).toEqual([]);
    expect(byTagName(html, 'dt').map((label) => label.text)).not.toContain(
      copy.rulesFallbackCondition,
    );
  });

  it("shows '—' for every item a market opened before #23 has blank, and still the VOID line", () => {
    const html = draw(BLANK);
    expect(rows(html)).toEqual([
      `${ID}-yes`,
      `${ID}-no`,
      `${ID}-event-deadline`,
      `${ID}-primary-source`,
      `${ID}-fallback-sources`,
      `${ID}-long-delay`,
      `${ID}-delay-handling`,
      `${ID}-void-payout`,
      `${ID}-close-at`,
      `${ID}-announcement-at`,
      `${ID}-judgement-at`,
      `${ID}-judgement-time-zone`,
    ]);
    for (const row of [
      'yes',
      'no',
      'event-deadline',
      'primary-source',
      'long-delay',
      'delay-handling',
    ]) {
      expect(value(html, row), row).toBe('—');
    }
    expect(value(html, 'fallback-sources')).toBe(copy.rulesFallbackNone);
    expect(value(html, 'void-payout')).toBe(value(draw(FULL), 'void-payout'));
    expect(byTagName(html, 'a')).toEqual([]);
    // A whitespace-only text is blank too, and an empty switch condition beside a fallback.
    const spaced = draw({
      ...BLANK,
      yesCondition: ' \n ',
      fallbackSources: [{ name: '대체', url: 'https://example.com' }],
    });
    expect(value(spaced, 'yes')).toBe('—');
    expect(value(spaced, 'fallback-condition')).toBe('—');
  });

  it('draws a half-filled source as text, never as a link it cannot follow', () => {
    const html = draw({
      ...BLANK,
      // A name with no address yet: an adopted proposal's 예상 출처 (ADR-0089).
      primarySource: { name: '한국은행 보도자료', url: '' },
      fallbackSources: [
        // An address with no name: the address, as text.
        { name: '', url: 'https://example.com/only-url' },
        // Not http(s): the API refuses it, and this is the second lock.
        { name: '이상한 주소', url: 'javascript:alert(1)' },
      ],
    });
    expect(byTagName(html, 'a')).toEqual([]);
    expect(value(html, 'primary-source')).toBe('한국은행 보도자료');
    expect(byTagName(html, 'li').map((item) => item.text)).toEqual([
      'https://example.com/only-url',
      '이상한 주소',
    ]);
    expect(html).not.toContain('javascript:');
  });

  it("states VOID's 50/50 from the contract terms, as a rule and never as a refund", () => {
    const text = value(draw(FULL), 'void-payout') ?? '';
    expect(text).toBe(
      `무효로 판정되면 YES 계약은 계약마다 ${formatCoin(PROPOSED_CONTRACT_TERMS.voidPayoutYesCoin)}, NO 계약은 계약마다 ${formatCoin(PROPOSED_CONTRACT_TERMS.voidPayoutNoCoin)}을 지급합니다. 모든 시장에 같은 규칙입니다.`,
    );
    expect(text).toContain('50 Coin');
    for (const word of ['환불', '원금', '돌려']) expect(text).not.toContain(word);
  });

  it('has nothing that could fold it: no button, disclosure or hidden content', () => {
    const html = draw(FULL);
    for (const marker of [
      '<button',
      '<details',
      '<summary',
      'aria-expanded',
      'hidden',
      'data-state',
    ]) {
      expect(html, marker).not.toContain(marker);
    }
  });
});
