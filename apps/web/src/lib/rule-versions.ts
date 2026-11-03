import { RULE_VERSION_ITEMS, type RuleVersionItem } from '@buddha/shared';
import { copy } from '@/copy';
import { type MarketRuleContent, type MarketRuleVersion } from './api';

/**
 * 규칙 버전 (#80, ADR-0101; ADR-0093 decision 2 #172 items 6·7·15, decision 3 '#80 보충의 형태'): the
 * pure half of the public detail's 규칙 버전 card (components/market/rule-versions-section.tsx) —
 * a version's name, the items' names as the rules area says them, and each version as the card
 * draws it. The admin screens name the same versions (lib/market-admin.ts' `marketEventRows`, the
 * supplement panel), so this file is a member screen's and its copy is held to the member list
 * (excluded-features.test.ts).
 */

/** A version's name: 'v' and its number ('v3'), composed as copy composes every number. */
export function ruleVersionName(version: number): string {
  return `${copy.ruleVersionName}${String(version)}`;
}

/**
 * The version items' names on the public detail (RULE_VERSION_ITEMS): the rules area's own row
 * names (rules-section.tsx), 배경's section name and 질문 for the title.
 */
export const RULE_VERSION_PUBLIC_LABEL: Readonly<Record<RuleVersionItem, string>> = {
  title: copy.ruleVersionsItemTitle,
  description: copy.marketBackground,
  yesCondition: copy.rulesYes,
  noCondition: copy.rulesNo,
  eventDeadline: copy.rulesEventDeadline,
  primarySource: copy.rulesPrimarySource,
  fallbackSources: copy.rulesFallbackSources,
  fallbackCondition: copy.rulesFallbackCondition,
  longDelayDays: copy.rulesLongDelay,
  delayHandling: copy.rulesDelayHandling,
  scheduledOpenAt: copy.rulesScheduledOpenAt,
  closeAt: copy.rulesCloseAt,
  scheduledAnnouncementAt: copy.rulesAnnouncementAt,
  scheduledJudgementAt: copy.rulesJudgementAt,
  judgementTimeZone: copy.rulesJudgementTimeZone,
};

/** One rule version as the 규칙 버전 card draws it (`ruleVersionViews`). */
export interface RuleVersionView {
  version: number;
  /** When it began: the open for v1, the supplement's approval for a later one. */
  createdAt: string;
  /** The newest version, the current one: its full text is the rules area above the card. */
  current: boolean;
  /** v1, fixed at the open (#172 item 6): no reason, no changed item. */
  fixedAtOpen: boolean;
  /** The supplement's reason, public with its text (#172 item 15); null for v1. */
  reason: string | null;
  /** The items it changed from the version before, in RULE_VERSION_ITEMS order. */
  changes: RuleVersionItem[];
  /** The version before it, whose text each change was ('이전'); null for v1 or one not listed. */
  previous: MarketRuleContent | null;
  content: MarketRuleContent;
}

/**
 * `Market.ruleVersions` as the card draws them, the newest first whatever order they came in
 * (decision 3 '#80 보충의 형태': the current version, then the history): each with the items it
 * changed — the version's own `changedItems`, in RULE_VERSION_ITEMS order — and the text of the
 * version before it, which a change's '이전' is read from. Every version keeps its full text, so
 * an earlier one is read whole too (the card's disclosure).
 */
export function ruleVersionViews(versions: readonly MarketRuleVersion[]): RuleVersionView[] {
  const byNumber = new Map(versions.map((row) => [row.version, row]));
  const newest = Math.max(0, ...versions.map((row) => row.version));
  return [...versions]
    .sort((a, b) => b.version - a.version)
    .map((row) => ({
      version: row.version,
      createdAt: row.createdAt,
      current: row.version === newest,
      fixedAtOpen: row.version === 1,
      reason: row.reason,
      changes: RULE_VERSION_ITEMS.filter((item) => row.changedItems.includes(item)),
      previous: byNumber.get(row.version - 1)?.content ?? null,
      content: row.content,
    }));
}
