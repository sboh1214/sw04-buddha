import { RULE_VERSION_ITEMS } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminRuleVersion, type MarketRuleContent, type MarketRuleVersion } from '@/lib/api';
import { SEOUL_TIME_ZONE, formatInTimeZone } from '@/lib/datetime';
import { RULE_VERSION_PUBLIC_LABEL } from '@/lib/rule-versions';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { RuleVersionsSection, type RuleVersionsMarket } from './rule-versions-section';

const ID = 'versions';

/** v1 as the open fixed it: 11-01 09:00 KST open, 11-30 00:00 KST close. */
const V1: MarketRuleContent = {
  title: '첫눈이 올까?',
  description: '서울 관측소 기준 배경',
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
/** v2: the 배경 and the close supplemented. */
const V2: MarketRuleContent = {
  ...V1,
  description: '서울 관측소 기준 배경 (오타 수정)',
  closeAt: '2026-11-30T00:00:00.000Z',
};

const OPENED_AT = '2026-11-01T00:00:00.000Z';
const APPROVED_AT = '2026-11-05T03:00:00.000Z';

const v1: MarketRuleVersion = {
  version: 1,
  createdAt: OPENED_AT,
  changedItems: [],
  reason: null,
  content: V1,
};
const v2: MarketRuleVersion = {
  version: 2,
  createdAt: APPROVED_AT,
  changedItems: ['description', 'closeAt'],
  reason: '배경의 오타를 고치고 마감을 늦춥니다.',
  content: V2,
};

const draw = (market: RuleVersionsMarket) =>
  renderWithQueries(<RuleVersionsSection market={market} data-testid={ID} />);

/** As the server renders a time: outside any provider, so in KST. */
const kst = (iso: string) => formatInTimeZone(iso, SEOUL_TIME_ZONE);

/**
 * 규칙 버전 on the public detail (#80, ADR-0101; ADR-0093 decision 3 '#80 보충의 형태'): the current
 * version and the history, newest first, each later version's reason and each changed item's text
 * before and after, every earlier version's full text behind a disclosure — rendered as the
 * server's HTML is, which a signed-out visitor and a closed market read (N02 §2, N05 §3). The e2e
 * (rule-versions.spec.ts) drives a supplement from the admin screens to this card.
 */
describe('RuleVersionsSection', () => {
  it('draws nothing for a market with no version: not opened, or opened before #80 (D4)', () => {
    expect(draw({ ruleVersion: null, ruleVersions: [] })).toBe('');
    expect(draw({ ruleVersion: null, ruleVersions: [v1] })).toBe('');
  });

  it('draws v1 alone as the current version, fixed at the open, with nothing to unfold', () => {
    const html = draw({ ruleVersion: 1, ruleVersions: [v1] });
    expect(byTagName(html, 'h2').map((heading) => heading.text)).toEqual([copy.ruleVersionsTitle]);
    expect(byTestId(html, `${ID}-current`)?.text).toBe(`${copy.ruleVersionsCurrent} v1`);
    expect(byTestId(html, `${ID}-version-1`)?.attributes['data-current']).toBe('true');
    expect(byTestId(html, `${ID}-version-1-fixed`)?.text).toBe(copy.ruleVersionsFixedAtOpen);
    expect(byTestId(html, `${ID}-version-1-at-viewer-zone`)?.text).toBe(kst(OPENED_AT));
    expect(byTestId(html, `${ID}-version-1-reason`)).toBeUndefined();
    expect(byTestId(html, `${ID}-version-1-changes`)).toBeUndefined();
    // The current version's full text is the rules area above, which never folds.
    expect(byTestId(html, `${ID}-version-1-full`)).toBeUndefined();
    expect(html).not.toContain('<details');
  });

  it('lists the newest first, each later one with its reason and every change before and after', () => {
    const html = draw({ ruleVersion: 2, ruleVersions: [v2, v1] });
    expect(byTestId(html, `${ID}-current`)?.text).toBe(`${copy.ruleVersionsCurrent} v2`);
    expect(
      testIdsStartingWith(html, `${ID}-version-`).filter((id) => /-version-\d+$/.test(id)),
    ).toEqual([`${ID}-version-2`, `${ID}-version-1`]);
    expect(byTestId(html, `${ID}-version-2`)?.attributes['data-current']).toBe('true');
    expect(byTestId(html, `${ID}-version-1`)?.attributes['data-current']).toBeUndefined();
    expect(byTestId(html, `${ID}-version-2-at-viewer-zone`)?.text).toBe(kst(APPROVED_AT));
    expect(byTestId(html, `${ID}-version-2-reason`)?.text).toBe(v2.reason);
    expect(byTestId(html, `${ID}-version-2-fixed`)).toBeUndefined();
    // Each changed item in RULE_VERSION_ITEMS order, under its public name.
    expect(
      testIdsStartingWith(html, `${ID}-version-2-change-`).filter(
        (id) => !/-(before|after)/.test(id),
      ),
    ).toEqual([`${ID}-version-2-change-description`, `${ID}-version-2-change-closeAt`]);
    expect(byTestId(html, `${ID}-version-2-change-description`)?.text).toContain(
      RULE_VERSION_PUBLIC_LABEL.description,
    );
    expect(byTestId(html, `${ID}-version-2-change-description-before`)?.text).toBe(V1.description);
    expect(byTestId(html, `${ID}-version-2-change-description-after`)?.text).toBe(V2.description);
    // A time in the viewer's zone, as the rules area reads it.
    expect(byTestId(html, `${ID}-version-2-change-closeAt-before-viewer-zone`)?.text).toBe(
      kst(V1.closeAt),
    );
    expect(byTestId(html, `${ID}-version-2-change-closeAt-after-viewer-zone`)?.text).toBe(
      kst(V2.closeAt),
    );
    expect(byTestId(html, `${ID}-version-2-changes`)?.text).toContain(copy.ruleVersionsBefore);
    expect(byTestId(html, `${ID}-version-2-changes`)?.text).toContain(copy.ruleVersionsAfter);
  });

  it('opens each earlier version’s full text in a disclosure, every item as the rules area words it', () => {
    const html = draw({ ruleVersion: 2, ruleVersions: [v2, v1] });
    // The current one has none; v1 has one, a native details that needs no script.
    expect(byTestId(html, `${ID}-version-2-full`)).toBeUndefined();
    const full = byTestId(html, `${ID}-version-1-full`);
    expect(full?.text).toContain(copy.ruleVersionsFullText);
    expect(html).toMatch(new RegExp(`<details[^>]*data-testid="${ID}-version-1-full"`));
    // Every item but the switch condition, which shows only with a fallback (#172 item 9).
    expect(
      testIdsStartingWith(html, `${ID}-version-1-full-`).filter(
        (id) => !/-(viewer|judgement)-zone$/.test(id),
      ),
    ).toEqual(
      RULE_VERSION_ITEMS.filter((item) => item !== 'fallbackCondition').map(
        (item) => `${ID}-version-1-full-${item}`,
      ),
    );
    expect(byTestId(html, `${ID}-version-1-full-title`)?.text).toBe(V1.title);
    expect(byTestId(html, `${ID}-version-1-full-description`)?.text).toBe(V1.description);
    expect(byTestId(html, `${ID}-version-1-full-primarySource`)?.text).toBe('기상청');
    expect(byTestId(html, `${ID}-version-1-full-fallbackSources`)?.text).toBe(
      copy.rulesFallbackNone,
    );
    expect(byTestId(html, `${ID}-version-1-full-scheduledAnnouncementAt`)?.text).toBe(
      copy.rulesAnnouncementNone,
    );
    expect(byTestId(html, `${ID}-version-1-full-longDelayDays`)?.text).toContain(
      `${copy.rulesLongDelayBefore} 14${copy.rulesLongDelayTail}`,
    );
    expect(byTestId(html, `${ID}-version-1-full-closeAt-viewer-zone`)?.text).toBe(kst(V1.closeAt));
    // A source's name links to its address, as in the rules area.
    expect(byTagName(html, 'a').map((link) => link.attributes.href)).toContain(
      'https://www.weather.go.kr',
    );
  });

  it('draws the switch condition of a version that had a fallback', () => {
    const withFallback: MarketRuleVersion = {
      ...v1,
      content: {
        ...V1,
        fallbackSources: [{ name: '연합뉴스', url: 'https://yna.co.kr' }],
        fallbackCondition: '1차 출처가 없으면',
      },
    };
    const html = draw({ ruleVersion: 2, ruleVersions: [v2, withFallback] });
    expect(byTestId(html, `${ID}-version-1-full-fallbackCondition`)?.text).toBe(
      '1차 출처가 없으면',
    );
  });

  it('names nobody and shows no 정산 영향 검토, even handed the admin’s versions', () => {
    // The public API sends neither (#172 item 15, #173 item 13); the card draws only what the
    // public version holds, so the admin's own list drawn here would not leak them either.
    const admin: AdminRuleVersion = {
      ...v2,
      approvalId: 'a1b2c3d4-0000-4000-8000-000000000001',
      requestedBy: { id: 'requester-id', nickname: '요청한이' },
      createdBy: { id: 'approver-id', nickname: '승인한이' },
      settlementImpact: 'IMPACT-SENTINEL',
    };
    const html = draw({ ruleVersion: 2, ruleVersions: [admin, v1] });
    for (const secret of [
      '요청한이',
      '승인한이',
      'requester-id',
      'approver-id',
      'IMPACT-SENTINEL',
      admin.approvalId ?? '',
    ]) {
      expect(html, secret).not.toContain(secret);
    }
  });
});
