import { describe, expect, it } from 'vitest';
import { MARKET_STATUSES } from './enums.js';
import { STORABLE_INSTANT_MIN, STORABLE_INSTANT_TOO_EARLY } from './market-rules.js';
import {
  DEFAULT_JUDGEMENT_TIME_ZONE,
  LEAD_CLOSE_GAP_MAX_MINUTES,
  LEAD_CLOSE_GAP_UNDECIDED,
  LEAD_CLOSE_GAP_UNDECIDED_MESSAGE,
  type MarketTimeItems,
  REQUIRED_TIME_ITEMS,
  TIME_ITEMS,
  TIME_ORDER_RULES,
  TIME_RULES,
  TIME_RULE_FIELDS,
  TIME_RULE_MESSAGES,
  type TimeRuleInput,
  ceilToMinute,
  changedTimeItems,
  floorToMinute,
  isJudgementDelayed,
  longDelayDeadline,
  marketTimesSchema,
  minuteOf,
  missingTimeItems,
  sameTimeItem,
  timeItemSchema,
  timeRuleIssues,
  timeRuleViolations,
} from './market-times.js';
import { isKnownTimeZone } from './time-zone.js';

/** A market's times in order, 사건 기한 included, with an announcement an hour after the close. */
const times: TimeRuleInput = {
  scheduledOpenAt: '2026-11-01T00:00:00.000Z',
  closeAt: '2026-11-26T14:59:59.000Z',
  scheduledAnnouncementAt: '2026-11-27T01:00:00.000Z',
  scheduledJudgementAt: '2026-11-30T01:00:00.000Z',
  judgementTimeZone: DEFAULT_JUDGEMENT_TIME_ZONE,
  eventDeadline: '2026-11-27T14:59:59.000Z',
};

/** Rule ids of `timeRuleViolations`, the reason after a colon. */
const broken = (input: TimeRuleInput, gap: number | null) =>
  timeRuleViolations(input, gap).map(({ rule, reason }) => (reason ? `${rule}: ${reason}` : rule));

describe('the time items (#22)', () => {
  it('lists the five in the form order and requires all but the announcement', () => {
    expect(TIME_ITEMS).toEqual([
      'scheduledOpenAt',
      'closeAt',
      'scheduledAnnouncementAt',
      'scheduledJudgementAt',
      'judgementTimeZone',
    ]);
    expect(timeItemSchema.options).toEqual([...TIME_ITEMS]);
    // N03 §2's 개장·거래 마감·예정 판정 시각 and the zone (#22 AC 4); 발표 예정 may be '없음'.
    expect(REQUIRED_TIME_ITEMS).toEqual([
      'scheduledOpenAt',
      'closeAt',
      'scheduledJudgementAt',
      'judgementTimeZone',
    ]);
    expect(DEFAULT_JUDGEMENT_TIME_ZONE).toBe('Asia/Seoul');
    expect(isKnownTimeZone(DEFAULT_JUDGEMENT_TIME_ZONE)).toBe(true);
  });

  it('carries the four of a market beside its close, each nullable, the instants storable', () => {
    const { closeAt: _close, eventDeadline: _deadline, ...four } = times;
    expect(Object.keys(marketTimesSchema.shape)).toEqual(
      TIME_ITEMS.filter((item) => item !== 'closeAt'),
    );
    expect(marketTimesSchema.parse(four)).toEqual(four);
    const blank = {
      scheduledOpenAt: null,
      scheduledAnnouncementAt: null,
      scheduledJudgementAt: null,
      judgementTimeZone: null,
    };
    expect(marketTimesSchema.parse(blank)).toEqual(blank);
    expect(marketTimesSchema.safeParse({ ...blank, scheduledOpenAt: undefined }).success).toBe(
      false,
    );
    const early = marketTimesSchema.safeParse({
      ...blank,
      scheduledJudgementAt: '0099-12-31T00:00:00Z',
    });
    expect(early.error?.issues).toMatchObject([
      { path: ['scheduledJudgementAt'], message: STORABLE_INSTANT_TOO_EARLY },
    ]);
    // A read is not checked again for a zone this runtime knows: the web checks before it formats.
    expect(
      marketTimesSchema.parse({ ...blank, judgementTimeZone: 'Mars/Olympus' }).judgementTimeZone,
    ).toBe('Mars/Olympus');
    expect(
      marketTimesSchema.safeParse({ ...blank, judgementTimeZone: 'x'.repeat(65) }).success,
    ).toBe(false);
  });
});

describe('minuteOf and the minute helpers', () => {
  it('counts whole minutes from the epoch, flooring toward −∞ as the CHECKs do', () => {
    expect(minuteOf('1970-01-01T00:00:00.000Z')).toBe(0);
    expect(minuteOf('1970-01-01T00:00:59.999Z')).toBe(0);
    expect(minuteOf('1970-01-01T00:01:00Z')).toBe(1);
    // Before 1970: 23:59:59.999 is the minute −1, as date_trunc puts it at 23:59:00.
    expect(minuteOf('1969-12-31T23:59:59.999Z')).toBe(-1);
    expect(minuteOf('1969-12-31T23:59:00.000Z')).toBe(-1);
    expect(minuteOf('1969-12-31T23:58:59.999Z')).toBe(-2);
    // The storage bounds are whole numbers too.
    expect(minuteOf(STORABLE_INSTANT_MIN)).toBe(Date.parse(STORABLE_INSTANT_MIN) / 60_000);
    expect(minuteOf('9999-12-31T23:59:59.999Z')).toBe(
      Date.parse('9999-12-31T23:59:00.000Z') / 60_000,
    );
    // An offset is the same instant.
    expect(minuteOf('2026-11-01T09:00:30+09:00')).toBe(minuteOf('2026-11-01T00:00:00Z'));
  });

  it('floors and raises an instant to its minute', () => {
    const at = Date.parse('2026-11-01T10:00:00.000Z');
    expect(floorToMinute(at)).toBe(at);
    expect(floorToMinute(at + 59_999)).toBe(at);
    expect(ceilToMinute(at)).toBe(at);
    expect(ceilToMinute(at + 1)).toBe(at + 60_000);
    expect(floorToMinute(-1)).toBe(-60_000);
    expect(ceilToMinute(-1)).toBe(0);
  });
});

describe('timeRuleViolations (#172 item 12, owner answer A1, #172 item 13)', () => {
  it('lists the four rules in order, each between two named ends', () => {
    expect(TIME_RULES).toEqual([
      'openBeforeClose',
      'closeByJudgement',
      'deadlineByJudgement',
      'leadClose',
    ]);
    expect(TIME_ORDER_RULES).toEqual(TIME_RULES.slice(0, 3));
    expect(TIME_RULE_FIELDS).toEqual({
      openBeforeClose: ['scheduledOpenAt', 'closeAt'],
      closeByJudgement: ['closeAt', 'scheduledJudgementAt'],
      deadlineByJudgement: ['eventDeadline', 'scheduledJudgementAt'],
      leadClose: ['closeAt', 'scheduledAnnouncementAt'],
    });
  });

  it('finds nothing broken in a market whose times are in order', () => {
    expect(timeRuleViolations(times, 60)).toEqual([]);
    expect(timeRuleViolations(times, 0)).toEqual([]);
  });

  it('names each rule its times break, with its two ends', () => {
    expect(timeRuleViolations({ ...times, scheduledOpenAt: times.closeAt }, 60)).toEqual([
      { rule: 'openBeforeClose', fields: ['scheduledOpenAt', 'closeAt'] },
    ]);
    expect(broken({ ...times, scheduledOpenAt: '2026-12-01T00:00:00Z' }, 60)).toEqual([
      'openBeforeClose',
    ]);
    expect(broken({ ...times, scheduledJudgementAt: '2026-11-26T14:58:00Z' }, 60)).toEqual([
      'closeByJudgement',
      'deadlineByJudgement',
    ]);
    // 사건 기한 after the judgement (A1), and nothing against the close (ADR-0097 result 4 (a)).
    expect(broken({ ...times, eventDeadline: '2026-11-30T01:01:00Z' }, 60)).toEqual([
      'deadlineByJudgement',
    ]);
    expect(broken({ ...times, eventDeadline: '2026-11-01T00:00:00Z' }, 60)).toEqual([]);
    expect(broken({ ...times, closeAt: '2026-11-27T01:00:00Z' }, 60)).toEqual(['leadClose']);
    // All at once, in TIME_RULES order.
    expect(
      broken(
        {
          ...times,
          scheduledOpenAt: '2026-12-31T00:00:00Z',
          scheduledJudgementAt: '2026-11-01T00:00:00Z',
          scheduledAnnouncementAt: '2026-11-26T15:00:00Z',
        },
        60,
      ),
    ).toEqual(['openBeforeClose', 'closeByJudgement', 'deadlineByJudgement', 'leadClose']);
  });

  it('compares whole minutes: close at the judgement passes, open and close in one minute do not', () => {
    const minute = '2026-11-30T01:00:00.000Z';
    const noAnnouncement = { ...times, scheduledAnnouncementAt: null };
    expect(broken({ ...noAnnouncement, closeAt: minute, eventDeadline: minute }, 60)).toEqual([]);
    // 10:00:30 is the minute of 10:00:00: the close may equal the judgement.
    expect(
      broken(
        {
          ...noAnnouncement,
          closeAt: '2026-11-30T01:00:30.000Z',
          eventDeadline: '2026-11-30T01:00:59.999Z',
        },
        60,
      ),
    ).toEqual([]);
    expect(broken({ ...noAnnouncement, closeAt: '2026-11-30T01:01:00.000Z' }, 60)).toEqual([
      'closeByJudgement',
    ]);
    // The open must be a minute before the close: 14:59:00 and 14:59:59 are one minute.
    expect(broken({ ...noAnnouncement, scheduledOpenAt: '2026-11-26T14:59:00.000Z' }, 60)).toEqual([
      'openBeforeClose',
    ]);
    expect(broken({ ...noAnnouncement, scheduledOpenAt: '2026-11-26T14:58:59.999Z' }, 60)).toEqual(
      [],
    );
  });

  it('checks a rule only when both of its ends are set', () => {
    const blank: TimeRuleInput = {
      scheduledOpenAt: null,
      closeAt: null,
      scheduledAnnouncementAt: null,
      scheduledJudgementAt: null,
      judgementTimeZone: null,
      eventDeadline: null,
    };
    expect(timeRuleViolations(blank, null)).toEqual([]);
    // A close alone breaks nothing, even with an undecided gap and no announcement.
    expect(timeRuleViolations({ ...blank, closeAt: times.closeAt }, null)).toEqual([]);
    // A draft without a judgement: only the open and the lead can be judged.
    const withoutJudgement = {
      ...times,
      scheduledJudgementAt: null,
      eventDeadline: '2099-01-01T00:00:00Z',
    };
    expect(broken(withoutJudgement, 60)).toEqual([]);
    expect(broken({ ...withoutJudgement, scheduledOpenAt: '2099-01-01T00:00:00Z' }, 60)).toEqual([
      'openBeforeClose',
    ]);
    // No 사건 기한 yet: no A1.
    expect(
      broken({ ...times, eventDeadline: null, scheduledJudgementAt: times.closeAt }, 0),
    ).toEqual([]);
  });

  it('holds the lead close to the gap in minutes, 0 included; undecided, it cannot pass', () => {
    // The announcement is at 01:00:00; a close at 23:59:59 the day before is the minute 23:59.
    const at = (closeAt: string) => ({ ...times, closeAt });
    expect(broken(at('2026-11-27T00:00:00Z'), 60)).toEqual([]);
    expect(broken(at('2026-11-27T00:00:59.999Z'), 60)).toEqual([]);
    expect(broken(at('2026-11-27T00:01:00Z'), 60)).toEqual(['leadClose']);
    expect(broken(at('2026-11-27T00:01:00Z'), 59)).toEqual([]);
    // Gap 0: the close at or before the announcement, by minute.
    expect(broken(at('2026-11-27T01:00:59Z'), 0)).toEqual([]);
    expect(broken(at('2026-11-27T01:01:00Z'), 0)).toEqual(['leadClose']);
    expect(broken(at('2026-11-27T01:00:00Z'), LEAD_CLOSE_GAP_MAX_MINUTES)).toEqual(['leadClose']);
    // Undecided: a market with an announcement cannot pass, whatever its close.
    expect(timeRuleViolations(at('2026-11-01T00:01:00Z'), null)).toEqual([
      {
        rule: 'leadClose',
        fields: ['closeAt', 'scheduledAnnouncementAt'],
        reason: LEAD_CLOSE_GAP_UNDECIDED,
      },
    ]);
    // '없음' has no lead to check, decided or not.
    const none = { ...times, scheduledAnnouncementAt: null, closeAt: '2026-11-29T00:00:00Z' };
    expect(timeRuleViolations(none, null)).toEqual([]);
    expect(timeRuleViolations(none, 60)).toEqual([]);
  });
});

describe('timeRuleIssues (ADR-0098)', () => {
  it('gives each end of a broken rule its own message, so a path and a message name the rule', () => {
    const details = TIME_RULES.flatMap((rule) =>
      TIME_RULE_FIELDS[rule].map((field) => {
        const ofRule: Partial<Record<string, string>> = TIME_RULE_MESSAGES[rule];
        return { field, message: ofRule[field] };
      }),
    );
    expect(details.every(({ message }) => typeof message === 'string' && message !== '')).toBe(
      true,
    );
    const keys = details.map(({ field, message }) => `${field}: ${message}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(TIME_RULE_MESSAGES)).toEqual([...TIME_RULES]);
  });

  it('names both ends of each rule, those of the fields the write sent first', () => {
    const violations = timeRuleViolations(
      { ...times, scheduledJudgementAt: '2026-11-26T14:00:00Z' },
      60,
    );
    // No sent field named: the rules' own order.
    expect(timeRuleIssues(violations, [])).toEqual([
      { path: ['closeAt'], message: 'must be at or before scheduledJudgementAt' },
      { path: ['scheduledJudgementAt'], message: 'must be at or after closeAt' },
      { path: ['eventDeadline'], message: 'must be at or before scheduledJudgementAt' },
      { path: ['scheduledJudgementAt'], message: 'must be at or after eventDeadline' },
    ]);
    // A PATCH that moved only the judgement reads under the judgement first.
    expect(timeRuleIssues(violations, new Set(['scheduledJudgementAt']))).toEqual([
      { path: ['scheduledJudgementAt'], message: 'must be at or after closeAt' },
      { path: ['scheduledJudgementAt'], message: 'must be at or after eventDeadline' },
      { path: ['closeAt'], message: 'must be at or before scheduledJudgementAt' },
      { path: ['eventDeadline'], message: 'must be at or before scheduledJudgementAt' },
    ]);
    expect(
      timeRuleIssues(timeRuleViolations({ ...times, scheduledOpenAt: times.closeAt }, 60), [
        'closeAt',
        'title',
      ]),
    ).toEqual([
      { path: ['closeAt'], message: 'must be after scheduledOpenAt' },
      { path: ['scheduledOpenAt'], message: 'must be before closeAt' },
    ]);
    expect(
      timeRuleIssues(timeRuleViolations({ ...times, closeAt: '2026-11-27T00:30:00Z' }, 60), [
        'scheduledAnnouncementAt',
      ]),
    ).toEqual([
      {
        path: ['scheduledAnnouncementAt'],
        message: 'must be at least the lead-close gap after closeAt',
      },
      {
        path: ['closeAt'],
        message: 'must be at least the lead-close gap before scheduledAnnouncementAt',
      },
    ]);
    expect(timeRuleIssues([], ['closeAt'])).toEqual([]);
  });

  it('says an undecided gap on the lead field the write sent, on both when it sent neither', () => {
    const undecided = timeRuleViolations(times, null);
    expect(timeRuleIssues(undecided, ['closeAt'])).toEqual([
      { path: ['closeAt'], message: LEAD_CLOSE_GAP_UNDECIDED_MESSAGE },
    ]);
    expect(timeRuleIssues(undecided, ['scheduledAnnouncementAt', 'closeAt'])).toEqual([
      { path: ['closeAt'], message: 'lead-close gap undecided' },
      { path: ['scheduledAnnouncementAt'], message: 'lead-close gap undecided' },
    ]);
    expect(timeRuleIssues(undecided, [])).toEqual([
      { path: ['closeAt'], message: 'lead-close gap undecided' },
      { path: ['scheduledAnnouncementAt'], message: 'lead-close gap undecided' },
    ]);
  });
});

describe('missingTimeItems', () => {
  it('names the required items left null, the announcement never', () => {
    expect(missingTimeItems(times)).toEqual([]);
    expect(missingTimeItems({ ...times, scheduledAnnouncementAt: null })).toEqual([]);
    expect(
      missingTimeItems({
        scheduledOpenAt: null,
        closeAt: times.closeAt,
        scheduledAnnouncementAt: null,
        scheduledJudgementAt: null,
        judgementTimeZone: null,
      }),
    ).toEqual(['scheduledOpenAt', 'scheduledJudgementAt', 'judgementTimeZone']);
    expect(missingTimeItems({ ...times, closeAt: null, judgementTimeZone: null })).toEqual([
      'closeAt',
      'judgementTimeZone',
    ]);
  });
});

describe('changedTimeItems and sameTimeItem', () => {
  const stored: MarketTimeItems = {
    scheduledOpenAt: '2026-11-01T00:00:00.000Z',
    closeAt: '2026-11-26T14:59:59.000Z',
    scheduledAnnouncementAt: null,
    scheduledJudgementAt: '2026-11-30T01:00:00.000Z',
    judgementTimeZone: 'Asia/Seoul',
  };

  it('compares instants as moments and the zone by its name', () => {
    expect(changedTimeItems(stored, { ...stored })).toEqual([]);
    // '…00Z' and '…00.000Z' are one instant, and so is an offset spelling of it.
    expect(
      changedTimeItems(stored, {
        ...stored,
        scheduledOpenAt: '2026-11-01T00:00:00Z',
        scheduledJudgementAt: '2026-11-30T10:00:00+09:00',
      }),
    ).toEqual([]);
    expect(
      changedTimeItems(stored, {
        scheduledOpenAt: null,
        closeAt: '2026-11-26T15:00:00.000Z',
        scheduledAnnouncementAt: '2026-11-27T01:00:00.000Z',
        scheduledJudgementAt: '2026-11-30T01:00:00.001Z',
        judgementTimeZone: 'ROK',
      }),
    ).toEqual([...TIME_ITEMS]);
    expect(sameTimeItem('scheduledAnnouncementAt', null, null)).toBe(true);
    expect(sameTimeItem('scheduledAnnouncementAt', null, stored.closeAt)).toBe(false);
    expect(sameTimeItem('judgementTimeZone', 'Asia/Seoul', 'Asia/Seoul')).toBe(true);
    expect(sameTimeItem('judgementTimeZone', 'Asia/Seoul', null)).toBe(false);
  });
});

describe('longDelayDeadline (#172 item 10)', () => {
  it('is N × 24 hours after the scheduled judgement, or null while either is missing', () => {
    expect(longDelayDeadline('2026-11-30T01:00:00.000Z', 14)).toBe('2026-12-14T01:00:00.000Z');
    expect(longDelayDeadline('2026-11-30T01:00:00Z', 1)).toBe('2026-12-01T01:00:00.000Z');
    expect(longDelayDeadline('2026-12-31T01:00:00.000Z', 365)).toBe('2027-12-31T01:00:00.000Z');
    expect(longDelayDeadline(null, 14)).toBeNull();
    expect(longDelayDeadline('2026-11-30T01:00:00.000Z', null)).toBeNull();
  });

  it('adds instants, so across a daylight-saving change the wall clock moves by the hour', () => {
    // America/New_York leaves daylight saving on 2026-11-01: 10:00 EDT plus three days of 24
    // hours is 09:00 EST — the instant #142 and #145 act on is the one shown.
    const judgement = '2026-10-31T14:00:00.000Z';
    const deadline = longDelayDeadline(judgement, 3);
    expect(deadline).toBe('2026-11-03T14:00:00.000Z');
    const newYorkHour = (iso: string) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(iso));
    expect(newYorkHour(judgement)).toBe('10');
    expect(newYorkHour(deadline!)).toBe('09');
  });
});

describe('isJudgementDelayed (#173 item 11)', () => {
  const judgement = '2026-11-30T01:00:00.000Z';
  const at = Date.parse(judgement);
  const closed = { status: 'closed', scheduledJudgementAt: judgement } as const;

  it('reads a CLOSED market delayed from its scheduled judgement on', () => {
    expect(isJudgementDelayed(closed, at - 1)).toBe(false);
    expect(isJudgementDelayed(closed, at)).toBe(true);
    expect(isJudgementDelayed(closed, at + 86_400_000)).toBe(true);
  });

  it('reads no other status delayed, nor a market with no scheduled judgement', () => {
    for (const status of MARKET_STATUSES) {
      expect(isJudgementDelayed({ ...closed, status }, at + 1), status).toBe(status === 'closed');
    }
    expect(isJudgementDelayed({ status: 'closed', scheduledJudgementAt: null }, at)).toBe(false);
  });
});
