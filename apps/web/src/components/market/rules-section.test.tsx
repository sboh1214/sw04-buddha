import { PROPOSED_CONTRACT_TERMS, formatCoin } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
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
  closeAt: '2026-11-29T15:00:00.000Z',
};

/** A market opened before #23: every rule item blank. */
const BLANK: RulesSectionMarket = {
  yesCondition: '',
  noCondition: '',
  eventDeadline: null,
  primarySource: null,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: null,
  delayHandling: '',
  closeAt: '2026-11-29T15:00:00.000Z',
};

const draw = (market: RulesSectionMarket) =>
  renderWithQueries(<RulesSection market={market} data-testid={ID} />);

/** The row values' test ids, in the order they are drawn. */
const rows = (html: string) => testIdsStartingWith(html, `${ID}-`);

const value = (html: string, row: string) => byTestId(html, `${ID}-${row}`)?.text;

/**
 * 규칙 on the market detail (#23, ADR-0097): every rule item but 배경 — its own section — one row
 * each, the fixed 무효 지급 line and 마감, never collapsed (ADR-0093 decision 3 '#23 문장 길이와
 * 표시'). Rendered as the server's HTML is, which is what AC 2 reads out of view-source. The e2e
 * (market-rules.spec.ts) fills the items through the admin form and reads the public detail.
 */
describe('RulesSection', () => {
  it('draws every rule item in the form order, then 무효 지급 and 마감', () => {
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
    ]);
  });

  it('writes each text as it was written, line breaks kept, and the times in KST on the server', () => {
    const html = draw(FULL);
    expect(value(html, 'yes')).toBe(FULL.yesCondition);
    expect(value(html, 'no')).toBe(FULL.noCondition);
    expect(value(html, 'fallback-condition')).toBe(FULL.fallbackCondition);
    expect(value(html, 'delay-handling')).toBe(FULL.delayHandling);
    expect(value(html, 'long-delay')).toBe('예정 판정 시각에서 14일 뒤');
    // Outside a time-zone provider, as on the server, both times are KST (ADR-0063).
    expect(value(html, 'event-deadline')).toBe(
      formatInTimeZone(FULL.eventDeadline ?? '', SEOUL_TIME_ZONE),
    );
    expect(value(html, 'close-at')).toBe(formatInTimeZone(FULL.closeAt, SEOUL_TIME_ZONE));
    // AC 2: the YES 조건 is in the HTML itself, before any script runs.
    expect(html).toContain('서울 관측소 기준입니다.');
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
