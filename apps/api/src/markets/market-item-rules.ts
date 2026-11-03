import { schema, type Db } from '@buddha/db';
import {
  TIME_ORDER_RULES,
  missingRuleItems,
  timeRuleIssues,
  timeRuleViolations,
  type MarketRuleContent,
  type MarketRuleItems,
  type MarketStatus,
  type MarketTimeItems,
  type RuleItem,
  type TimeItem,
  type TimeRuleField,
  type TimeRuleInput,
  type UpdateMarketBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { type MarketRow } from './market.service.js';

/**
 * The rules a market's version items are written under (#23 rule items, #22 times; #80, ADR-0101:
 * the title, the rule items and the times are its rule version's items), shared by the two paths
 * that write them — a draft's PATCH (MarketAdminService.update) and an open or paused market's
 * supplement (MarketSupplementService, ADR-0093 decision 2 #172 items 14·15), which took over the
 * open market's checks the PATCH made until #80 with the same messages: how a body's values merge
 * with the stored ones, the columns they become, the switch condition, the close in the future,
 * the time order, the lead close and RULES_REQUIRED.
 */

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Reads that run either inside a transaction or on the pool. */
export type Executor = Db | Tx;

export function fieldError(path: string, message: string, detail: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ path: [path], message: detail }],
  });
}

/** Any state-machine violation other than the ones with their own code names `status`. */
export function wrongStatus(status: MarketStatus): AppError {
  return fieldError('status', `Market is ${status}`, `market is ${status}`);
}

/** The row under `FOR UPDATE`, or NOT_FOUND. Callers hold the market lock when it matters. */
export async function lockedMarketRow(tx: Tx, id: string): Promise<MarketRow> {
  const [row] = await tx
    .select()
    .from(schema.markets)
    .where(eq(schema.markets.id, id))
    .limit(1)
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', { message: 'Market not found' });
  return row;
}

/**
 * What RULES_REQUIRED names: a rule item (#23), or the judgement time zone (#22), a 판정 항목 of
 * ADR-0093 decision 2 #172 item 7 too.
 */
type RequiredWhileOpen = RuleItem | 'judgementTimeZone';

/**
 * PLAN 12: a market trades against its rules, so a supplement may not leave a rule item missing on
 * an open or paused market that it had filled (#23, ADR-0097), nor clear its judgement time zone
 * (#22, ADR-0098) — the PATCH's rule until #80 moved the open market's rules to the supplement:
 * one issue per such item, in RULE_ITEMS order, the zone last, 'required while open'. An item
 * missing already — every one, on a market opened before #23, and the zone on one opened before
 * #22 — blocks no other change, and sending null for it again is no change. (A draft without them
 * is refused review by the open-items check, `openItemsMissing`.)
 */
export function assertRulesKept(
  before: Pick<MarketRuleContent, RuleItem | 'judgementTimeZone'>,
  after: Pick<MarketRuleContent, RuleItem | 'judgementTimeZone'>,
): void {
  const missingBefore = missingRuleItems(before);
  const newlyMissing: RequiredWhileOpen[] = missingRuleItems(after).filter(
    (item) => !missingBefore.includes(item),
  );
  if (before.judgementTimeZone !== null && after.judgementTimeZone === null) {
    newlyMissing.push('judgementTimeZone');
  }
  if (newlyMissing.length === 0) return;
  throw new AppError('RULES_REQUIRED', {
    message: `Rule items cannot be left missing while the market is open: ${newlyMissing.join(', ')}`,
    details: newlyMissing.map((item) => ({ path: [item], message: 'required while open' })),
  });
}

/** The rule-item fields of a create or update body (`marketFields`, #23) or a supplement's. */
export type RuleItemsBody = Pick<WithoutExpectedAccount<UpdateMarketBody>, RuleItem>;

/**
 * The rule items a write leaves (#23): the body's value of each item it sends, the stored one of
 * each it does not — null clears a nullable item, and `fallbackSources` replaces the whole ordered
 * list. The event deadline as an ISO instant, as `ruleItemsOf` reads it back.
 */
export function withRuleItems(stored: MarketRuleItems, body: RuleItemsBody): MarketRuleItems {
  const { eventDeadline } = body;
  return {
    description: body.description === undefined ? stored.description : body.description,
    yesCondition: body.yesCondition ?? stored.yesCondition,
    noCondition: body.noCondition ?? stored.noCondition,
    eventDeadline:
      eventDeadline === undefined
        ? stored.eventDeadline
        : eventDeadline === null
          ? null
          : new Date(eventDeadline).toISOString(),
    primarySource: body.primarySource === undefined ? stored.primarySource : body.primarySource,
    fallbackSources: body.fallbackSources ?? stored.fallbackSources,
    fallbackCondition: body.fallbackCondition ?? stored.fallbackCondition,
    longDelayDays: body.longDelayDays === undefined ? stored.longDelayDays : body.longDelayDays,
    delayHandling: body.delayHandling ?? stored.delayHandling,
  };
}

/** The time-item fields of a create or update body (`marketFields`, #22) or a supplement's. */
export type TimesBody = Partial<Pick<WithoutExpectedAccount<UpdateMarketBody>, TimeItem>>;

/**
 * The time items a write leaves (#22, ADR-0098): the body's value of each item it sends, the stored
 * one of each it does not — null clears one (on a draft; a supplement's refusals are its own).
 * Instants as ISO, as `timesOf` reads them back; the zone as sent, trimmed by the body schema.
 */
export function withTimes(stored: MarketTimeItems, body: TimesBody): MarketTimeItems {
  const instant = (sent: string | null | undefined, kept: string | null) =>
    sent === undefined ? kept : sent === null ? null : new Date(sent).toISOString();
  return {
    scheduledOpenAt: instant(body.scheduledOpenAt, stored.scheduledOpenAt),
    closeAt: body.closeAt === undefined ? stored.closeAt : new Date(body.closeAt).toISOString(),
    scheduledAnnouncementAt: instant(body.scheduledAnnouncementAt, stored.scheduledAnnouncementAt),
    scheduledJudgementAt: instant(body.scheduledJudgementAt, stored.scheduledJudgementAt),
    judgementTimeZone:
      body.judgementTimeZone === undefined ? stored.judgementTimeZone : body.judgementTimeZone,
  };
}

/** The rule items of a full rule text (#80), in RULE_ITEMS order. */
export function ruleItemsOfContent(content: MarketRuleContent): MarketRuleItems {
  return {
    description: content.description,
    yesCondition: content.yesCondition,
    noCondition: content.noCondition,
    eventDeadline: content.eventDeadline,
    primarySource: content.primarySource,
    fallbackSources: content.fallbackSources,
    fallbackCondition: content.fallbackCondition,
    longDelayDays: content.longDelayDays,
    delayHandling: content.delayHandling,
  };
}

/** The time items of a full rule text (#80). */
export function timesOfContent(content: MarketRuleContent): MarketTimeItems {
  return {
    scheduledOpenAt: content.scheduledOpenAt,
    closeAt: content.closeAt,
    scheduledAnnouncementAt: content.scheduledAnnouncementAt,
    scheduledJudgementAt: content.scheduledJudgementAt,
    judgementTimeZone: content.judgementTimeZone,
  };
}

/**
 * The full rule text (#80) a write of `body` leaves on `stored`: the title it sends or the stored
 * one, and the rule items and times as `withRuleItems` and `withTimes` merge them — so each instant
 * is ISO as `ruleContentOf` (@buddha/db) reads it back, and a comparison with
 * `changedRuleVersionItems` names exactly the items the write changes.
 */
export function withContent(
  stored: MarketRuleContent,
  body: RuleItemsBody & TimesBody & { title?: string },
): MarketRuleContent {
  return {
    title: body.title ?? stored.title,
    ...withRuleItems(ruleItemsOfContent(stored), body),
    ...withTimes(timesOfContent(stored), body),
  };
}

/** The `markets` columns of the time items (#22). */
export function timeColumns(times: MarketTimeItems) {
  const at = (iso: string | null) => (iso === null ? null : new Date(iso));
  return {
    scheduledOpenAt: at(times.scheduledOpenAt),
    closeAt: new Date(times.closeAt),
    scheduledAnnouncementAt: at(times.scheduledAnnouncementAt),
    scheduledJudgementAt: at(times.scheduledJudgementAt),
    judgementTimeZone: times.judgementTimeZone,
  };
}

/** The `markets` columns of the rule items; the sources are `market_sources` rows. */
export function ruleItemColumns(items: MarketRuleItems) {
  return {
    description: items.description,
    yesCondition: items.yesCondition,
    noCondition: items.noCondition,
    eventDeadline: items.eventDeadline === null ? null : new Date(items.eventDeadline),
    fallbackCondition: items.fallbackCondition,
    longDelayDays: items.longDelayDays,
    delayHandling: items.delayHandling,
  };
}

/** The fields a time rule compares that a write's body sends, null included (#22). */
export function sentTimeFields(
  body: TimesBody & { eventDeadline?: string | null },
): Set<TimeRuleField> {
  const fields: TimeRuleField[] = [
    'scheduledOpenAt',
    'closeAt',
    'scheduledAnnouncementAt',
    'scheduledJudgementAt',
    'eventDeadline',
  ];
  return new Set(fields.filter((field) => body[field] !== undefined));
}

/**
 * The order of the times a write leaves (#22, ADR-0098): scheduled open < close ≤ scheduled
 * judgement (ADR-0093 decision 2 #172 item 12) and 사건 기한 ≤ scheduled judgement (owner answer
 * 2026-10-31 A1), in whole minutes (`timeRuleViolations`, TIME_ORDER_RULES). A write whose result
 * breaks one is VALIDATION_ERROR naming both ends of each broken rule, the fields the body sent
 * first (`timeRuleIssues`). Only a rule with an end the body sends is checked: the database CHECKs
 * of migration 0051 keep the stored ones in order, and this refusal comes before them, so a CHECK
 * violation is a bug and never an answer. On a supplement it is also what keeps an extended close
 * at or before the unchanged scheduled judgement (owner answer 2026-10-31 A2).
 */
export function assertTimeOrder(times: TimeRuleInput, sent: ReadonlySet<TimeRuleField>): void {
  const broken = timeRuleViolations(times, null).filter(
    (violation) =>
      (TIME_ORDER_RULES as readonly string[]).includes(violation.rule) &&
      violation.fields.some((field) => sent.has(field)),
  );
  if (broken.length === 0) return;
  throw new AppError('VALIDATION_ERROR', {
    message: `The market times are out of order: ${broken.map((v) => v.rule).join(', ')}`,
    details: timeRuleIssues(broken, sent),
  });
}

/**
 * 선행 마감 after the open (#22, ADR-0098; ADR-0093 decision 2 #172 items 13–14): a supplement that
 * changes the close or the announcement of a market with an announcement time has the close checked
 * again, close ≤ announcement − `gapMinutes` in whole minutes. The gap is the one the market's lead
 * close was last checked against, else the release setting's reading; with neither — the setting
 * undecided — it cannot be checked and is refused on the lead fields sent ('lead-close gap
 * undecided'). A draft is never refused it: its open-items check names `leadClose` instead.
 */
export function assertLeadClose(
  times: TimeRuleInput,
  gapMinutes: number | null,
  sent: ReadonlySet<TimeRuleField>,
): void {
  const broken = timeRuleViolations(times, gapMinutes).filter(
    (violation) => violation.rule === 'leadClose',
  );
  if (broken.length === 0) return;
  throw new AppError('VALIDATION_ERROR', {
    message:
      gapMinutes === null
        ? 'The lead-close gap is undecided: the release setting market.lead_close_gap has no value'
        : `The close must be at least ${gapMinutes} minutes before the announcement time`,
    details: timeRuleIssues(broken, sent),
  });
}

/**
 * A switch condition says when the judgement moves to a fallback source (#172 item 9), so a write
 * whose result has one and no fallback is refused naming it (#23): the body's items over the
 * stored ones. The caller asks only when the write sends either, so a row stored that way by
 * another writer blocks no unrelated edit.
 */
export function assertFallbackCondition(items: MarketRuleItems): void {
  if (items.fallbackSources.length === 0 && items.fallbackCondition.trim() !== '') {
    throw fieldError(
      'fallbackCondition',
      'A switch condition needs a fallback source to switch to',
      'no fallback source',
    );
  }
}

export function assertFutureCloseAt(closeAt: Date, now: Date): void {
  if (closeAt.getTime() <= now.getTime()) {
    throw fieldError('closeAt', 'closeAt must be in the future', 'must be in the future');
  }
}
