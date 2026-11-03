import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { APPROVAL_REASON_MAX_LENGTH } from './approvals.js';
import { JUDGEMENT_DELAY_REVIEW_MAX_DAYS, MARKET_LONG_DELAY_DAYS_MIN } from './constants.js';
import { MARKET_STATUSES } from './enums.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import * as shared from './index.js';
import {
  JUDGEMENT_DELAY_REVIEW_MAX_HOURS,
  JUDGEMENT_DELAY_REVIEW_MAX_MS,
  JUDGEMENT_DELAY_STATUSES,
  type JudgementDelayRecord,
  MARKET_JUDGEMENT_DELAY_REFUSALS,
  type MarketDelayRecordActionPayload,
  type MarketJudgementDelayRecordedPayload,
  adminJudgementDelaySchema,
  currentJudgementDelay,
  isCurrentJudgementDelayEpisode,
  isJudgementDelayStatus,
  isLongDelayDeadlineReached,
  judgementDelayNextReviewRefusal,
  judgementDelayReviewPassed,
  judgementDelayStatusRefusal,
  judgementDelayStatusSchema,
  marketJudgementDelayOf,
  marketJudgementDelaySchema,
  recordJudgementDelayBodySchema,
  withCurrentJudgementDelay,
} from './market-judgement-delay.js';
import { STORABLE_INSTANT_TOO_EARLY } from './market-rules.js';
import { type MarketDisplayState, isJudgementDelayed, longDelayDeadline } from './market-times.js';

const HOUR_MS = 3_600_000;
const judgement = '2026-11-30T01:00:00.000Z';
const at = Date.parse(judgement);
const deadline = '2026-12-01T01:00:00.123Z';
const due = Date.parse(deadline);
const account = 'admin-1';
const delayId = '6c1d2e3f-4a5b-4c6d-9e7f-8091a2b3c4d5';
const recorder = { id: 'admin-1', nickname: '운영자1' };

// A CLOSED market past nothing yet, and a PROVISIONAL one a 판정 이의 holds (#175).
const closed: MarketDisplayState = {
  status: 'closed',
  scheduledJudgementAt: judgement,
  disputeDeadline: null,
  disputeHoldCount: 0,
  correctionPending: false,
};
const held: MarketDisplayState = {
  status: 'provisional',
  scheduledJudgementAt: judgement,
  disputeDeadline: deadline,
  disputeHoldCount: 1,
  correctionPending: false,
};

const issues = (result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];
const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('the delay record’s limits and statuses (#142, owner answer 2026-11-03 (1))', () => {
  it('bounds the next review time by seven days of 24 hours, no release setting', () => {
    expect(JUDGEMENT_DELAY_REVIEW_MAX_DAYS).toBe(7);
    // The CHECK's interval: hours, not '7 days', which follows a session time zone across DST.
    expect(JUDGEMENT_DELAY_REVIEW_MAX_HOURS).toBe(168);
    expect(JUDGEMENT_DELAY_REVIEW_MAX_MS).toBe(7 * 86_400_000);
    expect([...shared.RELEASE_SETTINGS.keys()].filter((key) => /delay|review/.test(key))).toEqual(
      [],
    );
  });

  it('records on the two statuses that read 판정 지연, and on no other', () => {
    expect(JUDGEMENT_DELAY_STATUSES).toEqual(['closed', 'provisional']);
    expect(judgementDelayStatusSchema.options).toEqual([...JUDGEMENT_DELAY_STATUSES]);
    for (const status of MARKET_STATUSES) {
      // Exactly the statuses `isJudgementDelayed` can read delayed, at some instant.
      const delayedSomewhen = [at, due].some(
        (nowMs) =>
          isJudgementDelayed({ ...closed, status }, nowMs) ||
          isJudgementDelayed({ ...held, status }, nowMs),
      );
      expect(isJudgementDelayStatus(status), status).toBe(delayedSomewhen);
      expect(judgementDelayStatusSchema.safeParse(status).success, status).toBe(delayedSomewhen);
    }
  });

  it('names its refusals apart under each path, each a message a client maps', () => {
    expect(MARKET_JUDGEMENT_DELAY_REFUSALS).toEqual({
      status: { notAwaitingJudgement: 'not awaiting a judgement', notDelayed: 'not delayed' },
      nextReviewAt: { notAfterNow: 'not after now', tooFarAhead: 'more than 7 days ahead' },
    });
    for (const [path, messages] of Object.entries(MARKET_JUDGEMENT_DELAY_REFUSALS)) {
      const values = Object.values(messages);
      expect(new Set(values).size, path).toBe(values.length);
    }
  });
});

describe('judgementDelayStatusRefusal (#173 items 2·7·11)', () => {
  it('takes a CLOSED market from its scheduled judgement on, and never one with none', () => {
    expect(judgementDelayStatusRefusal(closed, at - 1)).toBe('not delayed');
    expect(judgementDelayStatusRefusal(closed, at)).toBeNull();
    expect(judgementDelayStatusRefusal(closed, at + 30 * 86_400_000)).toBeNull();
    // Opened before #22: no scheduled judgement, never 판정 지연, never a record.
    expect(judgementDelayStatusRefusal({ ...closed, scheduledJudgementAt: null }, at + 1)).toBe(
      'not delayed',
    );
  });

  it('takes a PROVISIONAL market held past its deadline, by a dispute or a correction', () => {
    // '이의 검토 중' before the deadline takes none (#173 item 7: late means past it).
    expect(judgementDelayStatusRefusal(held, due - 1)).toBe('not delayed');
    expect(judgementDelayStatusRefusal(held, due)).toBeNull();
    const correcting = { ...held, disputeHoldCount: 0, correctionPending: true };
    expect(judgementDelayStatusRefusal(correcting, due - 1)).toBe('not delayed');
    expect(judgementDelayStatusRefusal(correcting, due)).toBeNull();
    // Nothing holds it: the worker confirms it, no delay to record.
    expect(judgementDelayStatusRefusal({ ...held, disputeHoldCount: 0 }, due + 1)).toBe(
      'not delayed',
    );
    // Its scheduled judgement decides nothing once it is PROVISIONAL.
    expect(judgementDelayStatusRefusal(held, at + 1)).toBe('not delayed');
  });

  it('refuses every other status first, whatever its times say', () => {
    for (const status of MARKET_STATUSES.filter((s) => s !== 'closed' && s !== 'provisional')) {
      for (const state of [closed, held]) {
        expect(judgementDelayStatusRefusal({ ...state, status }, due + 1), status).toBe(
          'not awaiting a judgement',
        );
      }
    }
  });

  it('agrees with isJudgementDelayed on the two statuses', () => {
    for (const state of [closed, held, { ...held, disputeHoldCount: 0, correctionPending: true }]) {
      for (const nowMs of [at - 1, at, due - 1, due, due + 1]) {
        expect(judgementDelayStatusRefusal(state, nowMs) === null).toBe(
          isJudgementDelayed(state, nowMs),
        );
      }
    }
  });
});

describe('judgementDelayNextReviewRefusal (owner answer 2026-11-03 (1))', () => {
  const now = Date.parse('2026-12-05T03:04:05.678Z');

  it('takes an instant after now and within 7 × 24 hours, both ends to the millisecond', () => {
    expect(judgementDelayNextReviewRefusal(new Date(now), now)).toBe('not after now');
    expect(judgementDelayNextReviewRefusal(new Date(now - 1), now)).toBe('not after now');
    expect(judgementDelayNextReviewRefusal(new Date(now + 1), now)).toBeNull();
    expect(judgementDelayNextReviewRefusal(new Date(now + HOUR_MS), now)).toBeNull();
    // Exactly seven days ahead is taken, a millisecond more is not.
    const latest = now + JUDGEMENT_DELAY_REVIEW_MAX_MS;
    expect(judgementDelayNextReviewRefusal(new Date(latest), now)).toBeNull();
    expect(judgementDelayNextReviewRefusal(new Date(latest + 1), now)).toBe(
      'more than 7 days ahead',
    );
    expect(judgementDelayNextReviewRefusal(new Date(now + 30 * 86_400_000), now)).toBe(
      'more than 7 days ahead',
    );
  });

  it('reads an ISO string as its instant, whatever its precision', () => {
    expect(judgementDelayNextReviewRefusal('2026-12-12T03:04:05.678Z', now)).toBeNull();
    expect(judgementDelayNextReviewRefusal('2026-12-12T03:04:05.679Z', now)).toBe(
      'more than 7 days ahead',
    );
    expect(judgementDelayNextReviewRefusal('2026-12-05T03:05Z', now)).toBeNull();
    expect(judgementDelayNextReviewRefusal('2026-12-05T03:04:05Z', now)).toBe('not after now');
  });

  it('adds instants, so across a daylight-saving change the bound stays 168 hours', () => {
    // America/New_York leaves daylight saving on 2026-11-01: 10:00 EDT plus seven days of 24 hours
    // is 09:00 EST, and that instant is the latest one taken.
    const before = Date.parse('2026-10-29T14:00:00.000Z');
    expect(judgementDelayNextReviewRefusal('2026-11-05T14:00:00.000Z', before)).toBeNull();
    expect(judgementDelayNextReviewRefusal('2026-11-05T14:00:00.001Z', before)).toBe(
      'more than 7 days ahead',
    );
  });
});

describe('judgementDelayReviewPassed (owner answer 2026-11-03 (2): 갱신 대기)', () => {
  it('reads passed from the instant on, a Date or an ISO string alike', () => {
    const review = '2026-12-02T01:00:00.500Z';
    const ms = Date.parse(review);
    expect(judgementDelayReviewPassed(review, ms - 1)).toBe(false);
    expect(judgementDelayReviewPassed(review, ms)).toBe(true);
    expect(judgementDelayReviewPassed(new Date(ms), ms + 86_400_000)).toBe(true);
    expect(judgementDelayReviewPassed(new Date(ms), ms - 1)).toBe(false);
  });
});

describe('the current record (#142 choice 6: the newest of the current episode)', () => {
  const record = (marketStatus: 'closed' | 'provisional', judgementVersion: number | null) => ({
    reason: `${marketStatus} ${judgementVersion}`,
    nextReviewAt: '2026-12-02T01:00:00.000Z',
    marketStatus,
    judgementVersion,
  });
  // Newest first: two CLOSED records, then one on v1 once PROVISIONAL, then one on v2.
  const closedOne = record('closed', null);
  const closedTwo = { ...record('closed', null), reason: 'closed again' };
  const versionOne = record('provisional', 1);
  const versionTwo = record('provisional', 2);

  it('is the newest record of the status and version the market has now', () => {
    const onClosed = [closedTwo, closedOne];
    expect(currentJudgementDelay(onClosed, { status: 'closed', judgementVersion: null })).toBe(
      closedTwo,
    );
    // The judgement's approval leaves the CLOSED records history: no current one on v1 yet.
    expect(
      currentJudgementDelay(onClosed, { status: 'provisional', judgementVersion: 1 }),
    ).toBeNull();
    const onVersionOne = [versionOne, closedTwo, closedOne];
    expect(
      currentJudgementDelay(onVersionOne, { status: 'provisional', judgementVersion: 1 }),
    ).toBe(versionOne);
    // A rejected or retracted correction keeps v1, and so its record; an approved one moves on.
    expect(
      currentJudgementDelay(onVersionOne, { status: 'provisional', judgementVersion: 2 }),
    ).toBeNull();
    const onVersionTwo = [versionTwo, versionOne, closedTwo, closedOne];
    expect(
      currentJudgementDelay(onVersionTwo, { status: 'provisional', judgementVersion: 2 }),
    ).toBe(versionTwo);
    // The confirmation ends the last episode.
    for (const status of ['resolved', 'settling', 'settled'] as const) {
      expect(
        currentJudgementDelay(onVersionTwo, { status, judgementVersion: 2 }),
        status,
      ).toBeNull();
    }
    expect(currentJudgementDelay([], { status: 'closed', judgementVersion: null })).toBeNull();
  });

  it('matches the status and the version both', () => {
    expect(
      isCurrentJudgementDelayEpisode(closedOne, { status: 'closed', judgementVersion: null }),
    ).toBe(true);
    expect(
      isCurrentJudgementDelayEpisode(versionOne, { status: 'provisional', judgementVersion: 1 }),
    ).toBe(true);
    expect(
      isCurrentJudgementDelayEpisode(versionOne, { status: 'closed', judgementVersion: 1 }),
    ).toBe(false);
    expect(
      isCurrentJudgementDelayEpisode(closedOne, { status: 'provisional', judgementVersion: null }),
    ).toBe(false);
  });

  it('marks at most one record current, the history in its order', () => {
    const marked = withCurrentJudgementDelay([versionOne, closedTwo, closedOne], {
      status: 'provisional',
      judgementVersion: 1,
    });
    expect(marked.map((entry) => entry.current)).toEqual([true, false, false]);
    expect(marked.map((entry) => entry.reason)).toEqual([
      versionOne.reason,
      closedTwo.reason,
      closedOne.reason,
    ]);
    expect(marked[0]).toEqual({ ...versionOne, current: true });
    // Two records of the same episode: the newer is current, the older history.
    expect(
      withCurrentJudgementDelay([closedTwo, closedOne], {
        status: 'closed',
        judgementVersion: null,
      }).map((entry) => entry.current),
    ).toEqual([true, false]);
    expect(
      withCurrentJudgementDelay([closedTwo, closedOne], {
        status: 'resolved',
        judgementVersion: 1,
      }).map((entry) => entry.current),
    ).toEqual([false, false]);
  });
});

describe('marketJudgementDelayOf (Market.judgementDelay)', () => {
  const closedMarket = { ...closed, judgementVersion: null };
  const heldMarket = { ...held, judgementVersion: 1 };
  const review = Date.parse('2026-11-30T05:00:00.000Z');
  const onClosed: JudgementDelayRecord = {
    reason: '출처의 발표가 늦어지고 있습니다.',
    nextReviewAt: new Date(review),
    marketStatus: 'closed',
    judgementVersion: null,
  };

  it('shows the current record while the market reads 판정 지연, the passed time as passed', () => {
    expect(marketJudgementDelayOf([onClosed], closedMarket, at)).toEqual({
      reason: onClosed.reason,
      nextReviewAt: '2026-11-30T05:00:00.000Z',
      nextReviewPassed: false,
    });
    expect(marketJudgementDelayOf([onClosed], closedMarket, review - 1)?.nextReviewPassed).toBe(
      false,
    );
    // The time passing changes the display alone: the same reason, the time marked passed.
    expect(marketJudgementDelayOf([onClosed], closedMarket, review)).toEqual({
      reason: onClosed.reason,
      nextReviewAt: '2026-11-30T05:00:00.000Z',
      nextReviewPassed: true,
    });
    // An ISO string comes out at the millisecond.
    expect(
      marketJudgementDelayOf([{ ...onClosed, nextReviewAt: '2026-11-30T05:00Z' }], closedMarket, at)
        ?.nextReviewAt,
    ).toBe('2026-11-30T05:00:00.000Z');
  });

  it('shows none while the market does not read 판정 지연, nor without a current record', () => {
    // Delayed with no record: '판정 지연' reads with no reason (#173 item 11).
    expect(marketJudgementDelayOf([], closedMarket, at)).toBeNull();
    // A record cannot exist before the scheduled judgement, and would show nothing then.
    expect(marketJudgementDelayOf([onClosed], closedMarket, at - 1)).toBeNull();
    // Once PROVISIONAL a CLOSED-era record labels nothing, delayed or not.
    expect(marketJudgementDelayOf([onClosed], heldMarket, due)).toBeNull();
    expect(marketJudgementDelayOf([onClosed], heldMarket, due - 1)).toBeNull();
    const onVersionOne: JudgementDelayRecord = {
      ...onClosed,
      reason: '판정 이의를 검토하고 있습니다.',
      marketStatus: 'provisional',
      judgementVersion: 1,
    };
    const records = [onVersionOne, onClosed];
    expect(marketJudgementDelayOf(records, heldMarket, due)).toMatchObject({
      reason: onVersionOne.reason,
      nextReviewPassed: true,
    });
    // Nothing holds it any more (the worker is about to confirm): no delay to show.
    expect(marketJudgementDelayOf(records, { ...heldMarket, disputeHoldCount: 0 }, due)).toBeNull();
    // Confirmed: the status reads none.
    expect(marketJudgementDelayOf(records, { ...heldMarket, status: 'resolved' }, due)).toBeNull();
  });
});

describe('isLongDelayDeadlineReached (owner answer 2026-11-03 (3))', () => {
  const market = { status: 'closed' as const, scheduledJudgementAt: judgement, longDelayDays: 14 };
  const longDeadline = Date.parse(longDelayDeadline(judgement, 14)!);

  it('holds for a CLOSED market from its long-delay deadline on', () => {
    expect(longDeadline).toBe(at + 14 * 86_400_000);
    expect(isLongDelayDeadlineReached(market, longDeadline - 1)).toBe(false);
    expect(isLongDelayDeadlineReached(market, longDeadline)).toBe(true);
    expect(isLongDelayDeadlineReached(market, longDeadline + 86_400_000)).toBe(true);
    const shortest = { ...market, longDelayDays: MARKET_LONG_DELAY_DAYS_MIN };
    expect(isLongDelayDeadlineReached(shortest, at + 86_400_000)).toBe(true);
    expect(isLongDelayDeadlineReached(shortest, at + 86_400_000 - 1)).toBe(false);
  });

  it('holds for no other status, and not while either time is not filled in', () => {
    for (const status of MARKET_STATUSES.filter((s) => s !== 'closed')) {
      expect(isLongDelayDeadlineReached({ ...market, status }, longDeadline + 1), status).toBe(
        false,
      );
    }
    expect(isLongDelayDeadlineReached({ ...market, longDelayDays: null }, longDeadline)).toBe(
      false,
    );
    expect(
      isLongDelayDeadlineReached({ ...market, scheduledJudgementAt: null }, longDeadline),
    ).toBe(false);
  });
});

describe('the record body', () => {
  const body = {
    reason: ' 출처의 발표가 늦어지고 있습니다. ',
    nextReviewAt: '2026-12-02T01:00:00.000Z',
    expectedAccountId: account,
  };

  it('takes a trimmed reason, an instant in UTC and the admin on screen', () => {
    expect(recordJudgementDelayBodySchema.parse(body)).toEqual({
      reason: '출처의 발표가 늦어지고 있습니다.',
      nextReviewAt: '2026-12-02T01:00:00.000Z',
      expectedAccountId: account,
    });
    // Any second and millisecond is taken (the dialog sends whole minutes, `:00`); the bound is
    // the service's, on the database clock.
    for (const nextReviewAt of [
      '2026-12-02T01:00:00Z',
      '2026-12-02T01:00:07Z',
      '2026-12-02T01:00:07.5Z',
      '2099-01-01T00:00:00Z',
    ]) {
      expect(recordJudgementDelayBodySchema.parse({ ...body, nextReviewAt }).nextReviewAt).toBe(
        nextReviewAt,
      );
    }
    expect(
      recordJudgementDelayBodySchema.parse({
        ...body,
        reason: 'x'.repeat(APPROVAL_REASON_MAX_LENGTH),
      }).reason,
    ).toHaveLength(APPROVAL_REASON_MAX_LENGTH);
  });

  it('refuses a reason out of bounds, a time that is no UTC instant and no account', () => {
    for (const reason of [undefined, null, '', '   ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1)]) {
      expect(paths(recordJudgementDelayBodySchema.safeParse({ ...body, reason }))).toEqual([
        'reason',
      ]);
    }
    for (const nextReviewAt of [
      undefined,
      null,
      '',
      '2026-12-02 10:00',
      // The seconds are part of the instant's form, as every market time's.
      '2026-12-02T01:00Z',
      '2026-12-02T10:00:00+09:00',
      1_796_000_000_000,
    ]) {
      expect(
        paths(recordJudgementDelayBodySchema.safeParse({ ...body, nextReviewAt })),
        String(nextReviewAt),
      ).toEqual(['nextReviewAt']);
    }
    expect(
      issues(
        recordJudgementDelayBodySchema.safeParse({
          ...body,
          nextReviewAt: '0099-12-31T23:59:59.999Z',
        }),
      ),
    ).toEqual([`nextReviewAt: ${STORABLE_INSTANT_TOO_EARLY}`]);
    for (const expectedAccountId of [undefined, '']) {
      expect(
        paths(recordJudgementDelayBodySchema.safeParse({ ...body, expectedAccountId })),
      ).toEqual(['expectedAccountId']);
    }
    // No classification and no private memo (decision 3): neither is read.
    expect(
      recordJudgementDelayBodySchema.parse({ ...body, category: 'source', memo: 'x' }),
    ).not.toHaveProperty('memo');
  });
});

describe('the delay records and read models', () => {
  const recorded = {
    id: delayId,
    reason: '출처의 발표가 늦어지고 있습니다.',
    nextReviewAt: '2026-12-02T01:00:00.000Z',
    marketStatus: 'closed',
    judgementVersion: null,
    recordedAt: '2026-11-30T02:00:00.000Z',
    recordedBy: recorder,
    current: true,
  };

  it('write the event’s and the admin action’s payload with the same five fields', () => {
    const payload = {
      delayId,
      reason: recorded.reason,
      nextReviewAt: recorded.nextReviewAt,
      marketStatus: 'provisional',
      judgementVersion: 2,
    } satisfies MarketJudgementDelayRecordedPayload;
    const action: MarketDelayRecordActionPayload = payload;
    expect(Object.keys(action).sort()).toEqual([
      'delayId',
      'judgementVersion',
      'marketStatus',
      'nextReviewAt',
      'reason',
    ]);
  });

  it('show the public record without anybody’s name or the record time (#173 item 13)', () => {
    const delay = { reason: recorded.reason, nextReviewAt: recorded.nextReviewAt };
    for (const nextReviewPassed of [false, true]) {
      expect(marketJudgementDelaySchema.parse({ ...delay, nextReviewPassed })).toEqual({
        ...delay,
        nextReviewPassed,
      });
    }
    expect(marketJudgementDelaySchema.parse({ ...recorded, nextReviewPassed: false })).toEqual({
      ...delay,
      nextReviewPassed: false,
    });
    expect(paths(marketJudgementDelaySchema.safeParse(delay))).toEqual(['nextReviewPassed']);
    // Its names pass the private-data guard; who and when would not be needed anyway.
    for (const name of ['judgementDelay', 'reason', 'nextReviewAt', 'nextReviewPassed']) {
      expect(findPrivateField(name), name).toEqual([]);
    }
  });

  it('show each admin record with its episode, who made it and when, and the current one', () => {
    expect(adminJudgementDelaySchema.parse(recorded)).toEqual(recorded);
    const provisional = {
      ...recorded,
      marketStatus: 'provisional',
      judgementVersion: 1,
      recordedBy: { id: 'admin-2', nickname: null },
      current: false,
    };
    expect(adminJudgementDelaySchema.parse(provisional)).toEqual(provisional);
    // Every field is said, null where it has none.
    for (const field of Object.keys(recorded)) {
      const { [field as keyof typeof recorded]: _gone, ...without } = recorded;
      expect(paths(adminJudgementDelaySchema.safeParse(without)), field).toEqual([field]);
    }
    for (const marketStatus of ['open', 'paused', 'resolved', '']) {
      expect(
        paths(adminJudgementDelaySchema.safeParse({ ...recorded, marketStatus })),
        marketStatus,
      ).toEqual(['marketStatus']);
    }
    for (const judgementVersion of [0, 1.5, '1']) {
      expect(
        paths(adminJudgementDelaySchema.safeParse({ ...provisional, judgementVersion })),
      ).toEqual(['judgementVersion']);
    }
    expect(paths(adminJudgementDelaySchema.safeParse({ ...recorded, id: 'delay-1' }))).toEqual([
      'id',
    ]);
  });

  it('store and answer names no excluded feature reads — and none withdraws', () => {
    for (const name of [
      'market_judgement_delays',
      'judgementDelay',
      'judgementDelays',
      'judgement_delay_recorded',
      'market_delay_record',
      'delayId',
      'delay_id',
      'next_review_at',
      'nextReviewAt',
      'nextReviewPassed',
      'market_status',
      'marketStatus',
      'judgement_version',
      'recorded_by',
      'recordedBy',
      'recorded_at',
      'recordedAt',
      'event_id',
      'current',
      ...JUDGEMENT_DELAY_STATUSES,
      ...Object.values(MARKET_JUDGEMENT_DELAY_REFUSALS).flatMap((messages) =>
        Object.values(messages),
      ),
    ]) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'storage'), name).toEqual([]);
    }
    const exported = Object.keys(shared).filter((name) => /delay/i.test(name));
    expect(exported.filter((name) => /withdraw|retract/i.test(name))).toEqual([]);
  });

  it('name each OpenAPI component once, and convert with the admin market', () => {
    const ids = new Set<string>();
    for (const value of Object.values(shared)) {
      if (!(value instanceof z.ZodType)) continue;
      const id = z.globalRegistry.get(value)?.id;
      if (id !== undefined) ids.add(id);
    }
    for (const id of [
      'JudgementDelayStatus',
      'RecordJudgementDelayBody',
      'MarketJudgementDelay',
      'AdminJudgementDelay',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(() =>
      z.toJSONSchema(
        z.object({
          market: shared.adminMarketSchema,
          record: recordJudgementDelayBodySchema,
          delay: marketJudgementDelaySchema,
          entry: adminJudgementDelaySchema,
        }),
      ),
    ).not.toThrow();
  });
});
