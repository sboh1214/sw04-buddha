import * as z from 'zod';
import { type MarketStatus } from './enums.js';
import { storableInstantSchema } from './market-rules.js';
import { TIME_ZONE_MAX_LENGTH } from './time-zone.js';

/**
 * 시장 시간 (#22, ADR-0098): the times a market's rules fix, one item per key (ADR-0093 decision 2
 * #172 items 11–14). As with the rule items (market-rules.ts), a key names its item everywhere —
 * the create and update body field, the `Market` field, the open-items check (`OPEN_ITEMS`) and
 * #80's rule versions — and the list is in the admin form's order:
 *
 * - `scheduledOpenAt` 예정 개장 시각: the market opens no earlier (ADR-0093 decision 3 '#21 앞당긴
 *   개장') — the worker opens a SCHEDULED market at it, or its approval does when that comes later
 *   (#21); `openAt` stays the actual open (ADR-0065).
 * - `closeAt` 거래 마감 시각: the worker closes the market at it. After the open it only moves later,
 *   and never past the scheduled judgement (#172 item 14, owner answer 2026-10-31 A2).
 * - `scheduledAnnouncementAt` 발표 예정 시각 (#172 item 13): when the source is to publish; null is
 *   '없음', an event with no scheduled release. The close must lead it by the release setting
 *   `market.lead_close_gap` (선행 마감).
 * - `scheduledJudgementAt` 예정 판정 시각: never edited after the open (#172 item 14); once it has
 *   passed a CLOSED market reads '판정 지연' (`isJudgementDelayed`, #173 item 11), and the long
 *   delay counts from it (`longDelayDeadline`, #172 item 10).
 * - `judgementTimeZone` 판정 기준 시간대 (#172 item 11): one IANA zone, Asia/Seoul pre-filled by the
 *   form for the operator to confirm. The public detail shows the times in it too when it differs
 *   from the viewer's zone (ADR-0093 decision 3 '#22 시간대').
 *
 * The times are instants (UTC) and are stored as entered; every ORDER between them compares whole
 * minutes (`minuteOf`, #172 item 12), while "has it passed" stays an instant on the server clock.
 */
export const TIME_ITEMS = [
  'scheduledOpenAt',
  'closeAt',
  'scheduledAnnouncementAt',
  'scheduledJudgementAt',
  'judgementTimeZone',
] as const;
export type TimeItem = (typeof TIME_ITEMS)[number];
export const timeItemSchema = z.enum(TIME_ITEMS);

/**
 * The time items the open-items check requires (N03 §2: 개장·거래 마감·예정 판정 시각, and the zone,
 * #22 AC 4), in TIME_ITEMS order. The close is listed although a market always has one, as the
 * title is (ADR-0097 7-10); the announcement is optional ('없음', #172 item 13).
 */
export const REQUIRED_TIME_ITEMS = [
  'scheduledOpenAt',
  'closeAt',
  'scheduledJudgementAt',
  'judgementTimeZone',
] as const satisfies readonly TimeItem[];
export type RequiredTimeItem = (typeof REQUIRED_TIME_ITEMS)[number];

/** The zone the admin form pre-fills for the operator to confirm (#172 item 11). */
export const DEFAULT_JUDGEMENT_TIME_ZONE = 'Asia/Seoul';

/**
 * The ceiling of the release setting `market.lead_close_gap` (LEAD_CLOSE_GAP_SETTING): a week of
 * minutes. It guards against a typo, no product rule.
 */
export const LEAD_CLOSE_GAP_MAX_MINUTES = 10_080;

/**
 * The time items as a market carries them (`Market`, `AdminMarket`) beside its summary's `closeAt`.
 * Null is an item not filled in — a draft may save any of them blank and the open-items check
 * names the required ones (`missingTimeItems`); a market opened before #22 has them all null — and
 * for the announcement it is '없음'.
 */
export const marketTimesSchema = z.object({
  /** 예정 개장 시각. */
  scheduledOpenAt: storableInstantSchema.nullable(),
  /** 발표 예정 시각; null is '없음'. */
  scheduledAnnouncementAt: storableInstantSchema.nullable(),
  /** 예정 판정 시각. */
  scheduledJudgementAt: storableInstantSchema.nullable(),
  /**
   * 판정 기준 시간대, an IANA name as the admin picked it. Checked on entry only (`timeZoneSchema`);
   * a read is not checked again, as with the member's zone (`me.ts`), so a client checks it is
   * one it knows (`isKnownTimeZone`) before it formats a time in it.
   */
  judgementTimeZone: z.string().max(TIME_ZONE_MAX_LENGTH).nullable(),
});
export type MarketTimes = z.infer<typeof marketTimesSchema>;

/** Every time item's value (TIME_ITEMS): the four of `MarketTimes` and the close. */
export type MarketTimeItems = MarketTimes & { closeAt: string };

/** One minute, the unit every order between market times is compared in. */
const MINUTE_MS = 60_000;

/**
 * The whole minute `iso` falls in, counted from the epoch: the unit every order between market
 * times compares (#172 item 12). It floors toward −∞ as the database CHECKs' `date_trunc('minute',
 * … AT TIME ZONE 'UTC')` does, so before 1970 too 23:59:59.999 is in the minute of 23:59:00.
 */
export function minuteOf(iso: string): number {
  return Math.floor(Date.parse(iso) / MINUTE_MS);
}

/** `ms` floored to its minute (10:00:59.999 → 10:00:00.000). */
export function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** `ms` raised to the next whole minute unless it is one (10:00:00.001 → 10:01:00.000). */
export function ceilToMinute(ms: number): number {
  const floored = floorToMinute(ms);
  return floored === ms ? ms : floored + MINUTE_MS;
}

/**
 * The time rules (#22), each between two items, compared in whole minutes (`minuteOf`):
 *
 * - `openBeforeClose`: scheduled open < close (#172 item 12; the same minute is refused).
 * - `closeByJudgement`: close ≤ scheduled judgement (#172 item 12; the same minute is fine).
 * - `deadlineByJudgement`: 사건 기한 ≤ scheduled judgement (owner answer 2026-10-31 A1). There is no
 *   order between the deadline and the close (ADR-0097 result 4 (a)).
 * - `leadClose` 선행 마감: close ≤ announcement − the gap (#172 item 13), the gap being the release
 *   setting `market.lead_close_gap` in minutes.
 *
 * The first three are the open-items check's `timeOrder` (TIME_ORDER_RULES) and the database holds
 * them too; the lead close depends on a setting, so only the open-items check (`leadClose`) and an
 * open market's close or announcement edit check it. Nothing orders the announcement against the
 * judgement or the open, and there is no minimum trading period: #78's reviewer looks (#172 item
 * 12).
 */
export const TIME_RULES = [
  'openBeforeClose',
  'closeByJudgement',
  'deadlineByJudgement',
  'leadClose',
] as const;
export type TimeRule = (typeof TIME_RULES)[number];

/** The order rules: the open-items check's `timeOrder`, and the three database CHECKs. */
export const TIME_ORDER_RULES = [
  'openBeforeClose',
  'closeByJudgement',
  'deadlineByJudgement',
] as const satisfies readonly TimeRule[];
export type TimeOrderRule = (typeof TIME_ORDER_RULES)[number];

/** A field a time rule compares: a time item, or 사건 기한 (a rule item, #23). */
export type TimeRuleField =
  | 'scheduledOpenAt'
  | 'closeAt'
  | 'scheduledAnnouncementAt'
  | 'scheduledJudgementAt'
  | 'eventDeadline';

/** Each rule's two ends, the earlier first. */
export const TIME_RULE_FIELDS = {
  openBeforeClose: ['scheduledOpenAt', 'closeAt'],
  closeByJudgement: ['closeAt', 'scheduledJudgementAt'],
  deadlineByJudgement: ['eventDeadline', 'scheduledJudgementAt'],
  leadClose: ['closeAt', 'scheduledAnnouncementAt'],
} as const satisfies { readonly [R in TimeRule]: readonly [TimeRuleField, TimeRuleField] };

/**
 * The refusal detail of a broken rule on each of its ends (ADR-0098): the API names both fields,
 * each with the message for that end, and the web maps a detail to its sentence by these values.
 * A field's messages differ from rule to rule, so a detail's path and message name its rule.
 */
export const TIME_RULE_MESSAGES = {
  openBeforeClose: {
    scheduledOpenAt: 'must be before closeAt',
    closeAt: 'must be after scheduledOpenAt',
  },
  closeByJudgement: {
    closeAt: 'must be at or before scheduledJudgementAt',
    scheduledJudgementAt: 'must be at or after closeAt',
  },
  deadlineByJudgement: {
    eventDeadline: 'must be at or before scheduledJudgementAt',
    scheduledJudgementAt: 'must be at or after eventDeadline',
  },
  leadClose: {
    closeAt: 'must be at least the lead-close gap before scheduledAnnouncementAt',
    scheduledAnnouncementAt: 'must be at least the lead-close gap after closeAt',
  },
} as const satisfies {
  readonly [R in TimeRule]: { readonly [F in (typeof TIME_RULE_FIELDS)[R][number]]: string };
};

/**
 * Why a lead close could not be judged: the release setting `market.lead_close_gap` is undecided
 * (`TimeRuleViolation.reason`). The open-items check's `leadClose` detail says it.
 */
export const LEAD_CLOSE_GAP_UNDECIDED = 'gap undecided';

/**
 * The detail of a write the lead close could not be checked for, on the lead field it sent: the
 * gap is undecided and the market has none of its own (an open market's close extension, ADR-0098).
 */
export const LEAD_CLOSE_GAP_UNDECIDED_MESSAGE = 'lead-close gap undecided';

/**
 * A rule a market's times break (`timeRuleViolations`), naming its two ends. A lead close the
 * undecided gap cannot judge carries `reason` LEAD_CLOSE_GAP_UNDECIDED: it does not hold either.
 */
export interface TimeRuleViolation {
  rule: TimeRule;
  fields: readonly [TimeRuleField, TimeRuleField];
  reason?: typeof LEAD_CLOSE_GAP_UNDECIDED;
}

/**
 * What the time rules read: the times and 사건 기한, each an ISO instant or null for not filled in
 * — the close too, so the admin form can check a half-filled one.
 */
export type TimeRuleInput = MarketTimes & { closeAt: string | null; eventDeadline: string | null };

/** Whether `rule` holds between `earlier` and `later` (both set), in whole minutes. */
function holds(rule: TimeRule, earlier: string, later: string, gapMinutes: number): boolean {
  const from = minuteOf(earlier);
  const to = minuteOf(later);
  switch (rule) {
    case 'openBeforeClose':
      return from < to;
    case 'closeByJudgement':
    case 'deadlineByJudgement':
      return from <= to;
    case 'leadClose':
      return from <= to - gapMinutes;
  }
}

/**
 * The time rules `times` break, in TIME_RULES order (#22): a rule is checked only when both of its
 * ends are set, so a half-filled draft breaks none it cannot judge yet. The lead close is checked
 * only with an announcement; `gapMinutes` is the 선행 마감 gap — the one the market's lead close was
 * last checked against (`markets.lead_close_gap_minutes`), else the setting's reading — and null
 * while the setting is undecided, when a market with an announcement breaks it with
 * LEAD_CLOSE_GAP_UNDECIDED (it cannot open until the owner enters the gap). The server, the admin
 * form and the seed's tests share it, so the three agree on every rule.
 */
export function timeRuleViolations(
  times: TimeRuleInput,
  gapMinutes: number | null,
): TimeRuleViolation[] {
  const violations: TimeRuleViolation[] = [];
  for (const rule of TIME_RULES) {
    const fields = TIME_RULE_FIELDS[rule];
    const [earlier, later] = [times[fields[0]], times[fields[1]]];
    if (earlier === null || later === null) continue;
    if (rule === 'leadClose' && gapMinutes === null) {
      violations.push({ rule, fields, reason: LEAD_CLOSE_GAP_UNDECIDED });
    } else if (!holds(rule, earlier, later, gapMinutes ?? 0)) {
      violations.push({ rule, fields });
    }
  }
  return violations;
}

/**
 * The refusal details of `violations`, one per end of each broken rule with its TIME_RULE_MESSAGES
 * message — an undecided lead close says LEAD_CLOSE_GAP_UNDECIDED_MESSAGE on the ends `sent` names
 * (on both when it names neither). The ends a write sent come first, then the others, each group
 * in the rules' order, so a client that shows the first detail shows it under the field the admin
 * changed (ADR-0098): a PATCH that moved only the judgement reads under 예정 판정 시각.
 */
export function timeRuleIssues(
  violations: readonly TimeRuleViolation[],
  sent: Iterable<string>,
): { path: [TimeRuleField]; message: string }[] {
  const wrote = new Set(sent);
  const issues = violations.flatMap(({ rule, fields, reason }) => {
    if (reason === LEAD_CLOSE_GAP_UNDECIDED) {
      const named = fields.filter((field) => wrote.has(field));
      return (named.length > 0 ? named : fields).map((field) => ({
        path: [field] as [TimeRuleField],
        message: LEAD_CLOSE_GAP_UNDECIDED_MESSAGE,
      }));
    }
    const messages: Partial<Record<TimeRuleField, string>> = TIME_RULE_MESSAGES[rule];
    return fields.map((field) => ({
      path: [field] as [TimeRuleField],
      message: messages[field] ?? '',
    }));
  });
  return [
    ...issues.filter((issue) => wrote.has(issue.path[0])),
    ...issues.filter((issue) => !wrote.has(issue.path[0])),
  ];
}

/**
 * The required time items `times` misses, in TIME_ITEMS order — the open-items check's share
 * (#22): a null scheduled open, judgement or zone. The close is never missing on a stored market.
 */
export function missingTimeItems(
  times: MarketTimes & { closeAt: string | null },
): RequiredTimeItem[] {
  return REQUIRED_TIME_ITEMS.filter((item) => times[item] === null);
}

function sameInstant(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);
}

/** When two values of each time item say the same. */
const SAME: {
  readonly [K in TimeItem]: (a: MarketTimeItems[K], b: MarketTimeItems[K]) => boolean;
} = {
  // Instants, not strings: '…00Z' and '…00.000Z' are the same moment.
  scheduledOpenAt: sameInstant,
  closeAt: sameInstant,
  scheduledAnnouncementAt: sameInstant,
  scheduledJudgementAt: sameInstant,
  // As stored: `Asia/Seoul` and its alias `ROK` are two entries.
  judgementTimeZone: (a, b) => a === b,
};

/** Whether `a` and `b` say the same for time item `item`: an instant by moment, a zone by name. */
export function sameTimeItem<K extends TimeItem>(
  item: K,
  a: MarketTimeItems[K],
  b: MarketTimeItems[K],
): boolean {
  return SAME[item](a, b);
}

/**
 * The time items whose value an edit changed, in TIME_ITEMS order (#22): an instant by its moment
 * (`…00Z` and `…00.000Z` are one), the zone by its name. #80's versions can list them.
 */
export function changedTimeItems(before: MarketTimeItems, after: MarketTimeItems): TimeItem[] {
  return TIME_ITEMS.filter((item) => !sameTimeItem(item, before[item], after[item]));
}

/** One day in milliseconds: N days of the long delay are N × 24 hours (#172 item 10). */
const DAY_MS = 86_400_000;

/**
 * 장기 지연 기한 as an instant (#172 item 10): `days` × 24 hours after the scheduled judgement, an
 * addition of instants, so across a daylight-saving change the wall clock of the judgement zone
 * moves by the hour. Null while either is not filled in. The public detail shows it, and #142 and
 * #145 reuse it, so the instant the system acts on and the shown one are the same.
 */
export function longDelayDeadline(judgementIso: string | null, days: number | null): string | null {
  if (judgementIso === null || days === null) return null;
  return new Date(Date.parse(judgementIso) + days * DAY_MS).toISOString();
}

/**
 * Whether a market reads '판정 지연' (ADR-0093 decision 1 #173 item 11, ADR-0098): a CLOSED market
 * whose scheduled judgement has passed by `nowMs` — an instant on the reader's clock, which for a
 * DTO is the server's at the read (`judgementDelayed`). It is a display, not a status: nothing
 * changes at the judgement time, and no list filters by it (ADR-0095 8-6). A PROVISIONAL market
 * whose objection review is late (#175) and the delay record's reason and next review time (#142)
 * are their issues'.
 */
export function isJudgementDelayed(
  market: { status: MarketStatus; scheduledJudgementAt: string | null },
  nowMs: number,
): boolean {
  return (
    market.status === 'closed' &&
    market.scheduledJudgementAt !== null &&
    nowMs >= Date.parse(market.scheduledJudgementAt)
  );
}
