import { RULE_VERSION_ITEMS } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type MarketRuleContent, type MarketRuleVersion } from './api';
import { RULE_VERSION_PUBLIC_LABEL, ruleVersionName, ruleVersionViews } from './rule-versions';

const V1: MarketRuleContent = {
  title: '첫눈이 올까?',
  description: '배경',
  yesCondition: '관측되면 YES',
  noCondition: '아니면 NO',
  eventDeadline: '2026-11-30T14:59:00.000Z',
  primarySource: { name: '기상청', url: 'https://www.weather.go.kr' },
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: 14,
  delayHandling: '무효',
  scheduledOpenAt: '2026-11-01T00:00:00.000Z',
  closeAt: '2026-11-29T15:00:00.000Z',
  scheduledAnnouncementAt: null,
  scheduledJudgementAt: '2026-12-01T01:00:00.000Z',
  judgementTimeZone: 'Asia/Seoul',
};
const V2: MarketRuleContent = { ...V1, description: '고친 배경' };
const V3: MarketRuleContent = {
  ...V2,
  title: '서울에 첫눈이 올까?',
  closeAt: '2026-11-30T00:00:00.000Z',
};

const version = (
  number: number,
  content: MarketRuleContent,
  changedItems: MarketRuleVersion['changedItems'] = [],
  reason: string | null = null,
): MarketRuleVersion => ({
  version: number,
  createdAt: `2026-11-0${String(number)}T00:00:00.000Z`,
  changedItems,
  reason,
  content,
});

/**
 * 규칙 버전's pure half (#80, ADR-0101; decision 3 '#80 보충의 형태'): the name, the public labels
 * and each version as the card draws it. The card itself is rule-versions-section.test.tsx.
 */
describe('rule versions', () => {
  it("names a version 'v' and its number, as copy composes numbers", () => {
    expect(ruleVersionName(1)).toBe('v1');
    expect(ruleVersionName(12)).toBe(`${copy.ruleVersionName}12`);
  });

  it('labels every version item as the public rules area does, with 질문 and 배경', () => {
    expect(Object.keys(RULE_VERSION_PUBLIC_LABEL).sort()).toEqual([...RULE_VERSION_ITEMS].sort());
    expect(RULE_VERSION_PUBLIC_LABEL.title).toBe(copy.ruleVersionsItemTitle);
    expect(RULE_VERSION_PUBLIC_LABEL.description).toBe(copy.marketBackground);
    expect(RULE_VERSION_PUBLIC_LABEL.yesCondition).toBe(copy.rulesYes);
    expect(RULE_VERSION_PUBLIC_LABEL.closeAt).toBe(copy.rulesCloseAt);
    expect(RULE_VERSION_PUBLIC_LABEL.judgementTimeZone).toBe(copy.rulesJudgementTimeZone);
  });

  it('lists the newest first, the current one marked and v1 fixed at the open', () => {
    const views = ruleVersionViews([
      version(1, V1),
      version(3, V3, ['closeAt', 'title'], '마감을 늦춥니다'),
      version(2, V2, ['description'], '오타'),
    ]);
    expect(views.map((view) => view.version)).toEqual([3, 2, 1]);
    expect(views.map((view) => view.current)).toEqual([true, false, false]);
    expect(views.map((view) => view.fixedAtOpen)).toEqual([false, false, true]);
    expect(views.map((view) => view.reason)).toEqual(['마감을 늦춥니다', '오타', null]);
  });

  it('reads each change from the version before, in RULE_VERSION_ITEMS order', () => {
    const [v3, v2, v1] = ruleVersionViews([
      version(3, V3, ['closeAt', 'title'], '마감을 늦춥니다'),
      version(2, V2, ['description'], '오타'),
      version(1, V1),
    ]);
    expect(v3?.changes).toEqual(['title', 'closeAt']);
    expect(v3?.previous).toEqual(V2);
    expect(v3?.content).toEqual(V3);
    expect(v2?.changes).toEqual(['description']);
    expect(v2?.previous).toEqual(V1);
    // v1 changes nothing and has none before it.
    expect(v1?.changes).toEqual([]);
    expect(v1?.previous).toBeNull();
  });

  it('keeps a version whose predecessor is missing, with no text to compare', () => {
    const [only] = ruleVersionViews([version(4, V3, ['title'], '제목')]);
    expect(only?.current).toBe(true);
    expect(only?.previous).toBeNull();
    expect(ruleVersionViews([])).toEqual([]);
  });
});
