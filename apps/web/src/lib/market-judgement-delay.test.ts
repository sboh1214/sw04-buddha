import {
  APPROVAL_REASON_MAX_LENGTH,
  JUDGEMENT_DELAY_REVIEW_MAX_DAYS,
  JUDGEMENT_DELAY_REVIEW_MAX_MS,
  MARKET_JUDGEMENT_DELAY_REFUSALS,
  MARKET_STATUSES,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminJudgementDelay, type AdminMarket, ApiError } from './api';
import { formatKst, isoToKstLocal } from './datetime';
import {
  JUDGEMENT_DELAY_UNAVAILABLE_NOTE,
  currentJudgementDelayRecord,
  judgementDelayActorName,
  judgementDelayDefaults,
  judgementDelayDisplayState,
  judgementDelayDraft,
  judgementDelayDraftWait,
  judgementDelayFailure,
  judgementDelayInstantWait,
  judgementDelayLate,
  judgementDelayRows,
  judgementDelayStartsAt,
  judgementDelayUnavailable,
  judgementLongDelayDeadline,
  judgementLongDelayWarned,
  showsJudgementDelays,
} from './market-judgement-delay';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);
const refused = (path: string, message: string) =>
  apiError(400, 'VALIDATION_ERROR', [{ path: [path], message }]);

const SCHEDULED_JUDGEMENT_AT = '2026-12-01T01:00:00.000Z';
const SCHEDULED = Date.parse(SCHEDULED_JUDGEMENT_AT);
const DEADLINE = '2026-12-03T01:00:00.000Z';
const RECORDER = { id: 'recorder', nickname: '기록한이' };
const DAY_MS = 86_400_000;

/** What the section reads of a market (`AdminMarket`'s fields the lib takes). */
type DelayMarket = Pick<
  AdminMarket,
  | 'status'
  | 'judgementDelayed'
  | 'scheduledJudgementAt'
  | 'disputeDeadline'
  | 'disputes'
  | 'judgement'
  | 'judgementDelay'
  | 'judgementDelays'
  | 'longDelayDays'
>;

/** A CLOSED market whose scheduled judgement is 12-01 01:00 UTC, never judged, no record. */
const closed: DelayMarket = {
  status: 'closed',
  judgementDelayed: false,
  scheduledJudgementAt: SCHEDULED_JUDGEMENT_AT,
  disputeDeadline: null,
  disputes: { holding: 0, items: [] },
  judgement: { current: null, history: [], pending: null, log: [], disputeWindowUndecided: false },
  judgementDelay: null,
  judgementDelays: [],
  longDelayDays: 14,
};

/** A PROVISIONAL v1 market whose 이의 기한 is 12-03 01:00 UTC, held by one dispute. */
const held: DelayMarket = {
  ...closed,
  status: 'provisional',
  disputeDeadline: DEADLINE,
  disputes: { holding: 1, items: [] },
};

const record = (patch: Partial<AdminJudgementDelay> = {}): AdminJudgementDelay => ({
  id: 'a1b2c3d4-0000-4000-8000-0000000000d1',
  reason: '출처의 발표가 늦어지고 있습니다.',
  nextReviewAt: '2026-12-02T01:00:00.000Z',
  marketStatus: 'closed',
  judgementVersion: null,
  recordedAt: '2026-12-01T02:00:00.000Z',
  recordedBy: RECORDER,
  current: true,
  ...patch,
});

/** A `datetime-local` value in KST for an instant. */
const local = (iso: string) => isoToKstLocal(iso);

describe('the 판정 지연 기록 section (#142)', () => {
  it('is drawn on CLOSED and PROVISIONAL, and on any market with a record', () => {
    for (const status of MARKET_STATUSES) {
      expect(showsJudgementDelays({ status, judgementDelays: [] }), status).toBe(
        status === 'closed' || status === 'provisional',
      );
      // A confirmed market keeps its history, read-only.
      expect(showsJudgementDelays({ status, judgementDelays: [record()] }), status).toBe(true);
    }
  });

  it('reads the market as isJudgementDelayed does: a waiting correction holds a 잠정 결과', () => {
    expect(judgementDelayDisplayState(held)).toEqual({
      status: 'provisional',
      scheduledJudgementAt: SCHEDULED_JUDGEMENT_AT,
      disputeDeadline: DEADLINE,
      disputeHoldCount: 1,
      correctionPending: false,
    });
    const pending = { requestId: 'r' } as unknown as AdminMarket['judgement']['pending'];
    const correcting = {
      ...held,
      disputes: { holding: 0, items: [] },
      judgement: { ...held.judgement, pending },
    };
    expect(judgementDelayDisplayState(correcting).correctionPending).toBe(true);
    // On CLOSED a waiting registration is a first judgement's: it holds nothing.
    expect(
      judgementDelayDisplayState({ ...closed, judgement: { ...closed.judgement, pending } })
        .correctionPending,
    ).toBe(false);
  });

  it('offers a record only while the market reads 판정 지연, saying why not otherwise', () => {
    // CLOSED: from the scheduled judgement on, to the millisecond, with no record needed.
    expect(judgementDelayUnavailable(closed, SCHEDULED - 1)).toBe('early');
    expect(judgementDelayUnavailable(closed, SCHEDULED)).toBeNull();
    // The server's flag at the read stands for a screen whose clock runs behind.
    expect(judgementDelayUnavailable({ ...closed, judgementDelayed: true }, SCHEDULED - 1)).toBe(
      null,
    );
    // Opened before #22: never.
    expect(judgementDelayUnavailable({ ...closed, scheduledJudgementAt: null }, SCHEDULED)).toBe(
      'unscheduled',
    );
    // PROVISIONAL: held, from the 이의 기한 on; not before, and not with nothing holding it.
    const deadline = Date.parse(DEADLINE);
    expect(judgementDelayUnavailable(held, deadline - 1)).toBe('unheld');
    expect(judgementDelayUnavailable(held, deadline)).toBeNull();
    expect(
      judgementDelayUnavailable({ ...held, disputes: { holding: 0, items: [] } }, deadline),
    ).toBe('unheld');
    // Every other status: no button at all.
    for (const status of MARKET_STATUSES.filter((s) => s !== 'closed' && s !== 'provisional')) {
      expect(judgementDelayUnavailable({ ...closed, status }, SCHEDULED), status).toBe('status');
      expect(
        judgementDelayUnavailable({ ...closed, status, judgementDelayed: true }, SCHEDULED),
        status,
      ).toBe('status');
    }
    // A waiting judgement registration refuses nothing (#173 item 2).
    const pending = { requestId: 'r' } as unknown as AdminMarket['judgement']['pending'];
    expect(
      judgementDelayUnavailable(
        { ...closed, judgement: { ...closed.judgement, pending } },
        SCHEDULED,
      ),
    ).toBeNull();
    expect(JUDGEMENT_DELAY_UNAVAILABLE_NOTE).toEqual({
      unscheduled: copy.adminMarketJudgementDelayUnscheduled,
      early: copy.adminMarketJudgementDelayEarly,
      unheld: copy.adminMarketJudgementDelayUnheld,
    });
  });

  it('waits for the instant the market starts to read 판정 지연', () => {
    expect(judgementDelayStartsAt(closed)).toBe(SCHEDULED_JUDGEMENT_AT);
    expect(judgementDelayStartsAt({ ...closed, scheduledJudgementAt: null })).toBeNull();
    expect(judgementDelayStartsAt(held)).toBe(DEADLINE);
    expect(judgementDelayStartsAt({ ...held, disputes: { holding: 0, items: [] } })).toBeNull();
    expect(judgementDelayStartsAt({ ...closed, status: 'resolved' })).toBeNull();
    // A second past it, a day at most; none once it has come.
    expect(judgementDelayInstantWait(SCHEDULED_JUDGEMENT_AT, SCHEDULED - 60_000)).toBe(61_000);
    expect(judgementDelayInstantWait(SCHEDULED_JUDGEMENT_AT, SCHEDULED)).toBeNull();
    expect(judgementDelayInstantWait(SCHEDULED_JUDGEMENT_AT, SCHEDULED - 3 * DAY_MS)).toBe(DAY_MS);
    expect(judgementDelayInstantWait(null, SCHEDULED)).toBeNull();
  });

  it('finds the current record, the API’s flag, never the newest alone', () => {
    expect(currentJudgementDelayRecord(closed)).toBeNull();
    const newest = record({ id: 'a1b2c3d4-0000-4000-8000-0000000000d2', current: false });
    const older = record();
    expect(currentJudgementDelayRecord({ judgementDelays: [newest, older] })).toBe(older);
    expect(currentJudgementDelayRecord({ judgementDelays: [newest] })).toBeNull();
  });

  it('says the update is late once a delayed market’s current next review time has passed', () => {
    const current = record();
    const at = Date.parse(current.nextReviewAt);
    expect(judgementDelayLate(closed, current, true, at - 1)).toBe(false);
    expect(judgementDelayLate(closed, current, true, at)).toBe(true);
    // Not while the market does not read 판정 지연, nor with no current record.
    expect(judgementDelayLate(closed, current, false, at)).toBe(false);
    expect(judgementDelayLate(closed, null, true, at)).toBe(false);
    // The server said so at the read, for that record: late whatever the screen's clock says.
    const read = {
      judgementDelay: {
        reason: current.reason,
        nextReviewAt: current.nextReviewAt,
        nextReviewPassed: true,
      },
    };
    expect(judgementDelayLate(read, current, true, at - DAY_MS)).toBe(true);
    // The flag of another record (a new one since) does not.
    expect(
      judgementDelayLate(read, record({ nextReviewAt: '2026-12-05T01:00:00.000Z' }), true, at),
    ).toBe(false);
  });

  it('warns a CLOSED market past its 장기 지연 기한 only, and waits for it', () => {
    const deadline = SCHEDULED + 14 * DAY_MS;
    expect(judgementLongDelayDeadline(closed)).toBe(new Date(deadline).toISOString());
    expect(judgementLongDelayWarned(closed, deadline - 1)).toBe(false);
    expect(judgementLongDelayWarned(closed, deadline)).toBe(true);
    // A result exists on PROVISIONAL: the rule's handling is about the source's lateness.
    expect(judgementLongDelayDeadline(held)).toBeNull();
    expect(judgementLongDelayWarned(held, deadline)).toBe(false);
    // Either time not filled in: none.
    expect(judgementLongDelayDeadline({ ...closed, longDelayDays: null })).toBeNull();
    expect(judgementLongDelayDeadline({ ...closed, scheduledJudgementAt: null })).toBeNull();
    expect(judgementLongDelayWarned({ ...closed, longDelayDays: null }, deadline)).toBe(false);
  });

  it('names the recorder by nickname and reads a record’s rows in the time given', () => {
    expect(judgementDelayActorName(RECORDER)).toBe('기록한이');
    expect(judgementDelayActorName({ nickname: null })).toBe(copy.postAuthorFormer);
    const current = record();
    expect(judgementDelayRows(current, formatKst)).toEqual([
      { label: copy.adminMarketJudgementDelayReason, value: current.reason },
      {
        label: copy.adminMarketJudgementDelayNextReviewAt,
        value: formatKst(current.nextReviewAt),
      },
    ]);
  });

  it('opens the dialog with the current record’s reason and no time', () => {
    expect(judgementDelayDefaults(closed)).toEqual({ reasonText: '', nextLocal: '' });
    expect(judgementDelayDefaults({ judgementDelays: [record()] })).toEqual({
      reasonText: record().reason,
      nextLocal: '',
    });
  });
});

describe('judgementDelayDraft', () => {
  const NOW = Date.parse('2026-12-01T03:00:30.000Z');
  const ahead = (ms: number) => new Date(NOW + ms).toISOString();

  it('sends the reason trimmed and the time in UTC once both are good', () => {
    const at = '2026-12-02T03:00:00.000Z';
    expect(judgementDelayDraft('  출처가 늦습니다.  ', local(at), NOW)).toEqual({
      ready: true,
      reason: '출처가 늦습니다.',
      nextReviewAt: at,
      reasonError: null,
      nextReviewError: null,
    });
  });

  it('holds the time to after now and within 7 × 24 hours, as the API does (owner answer (1))', () => {
    // A `datetime-local` holds minutes: the minute now is in has begun, so it is not after now.
    expect(judgementDelayDraft('사유', local('2026-12-01T03:00:00.000Z'), NOW)).toMatchObject({
      ready: false,
      nextReviewAt: null,
      nextReviewError: copy.errMarketJudgementDelayNextReviewAfter,
    });
    expect(judgementDelayDraft('사유', local(ahead(30_000)), NOW).nextReviewError).toBeNull();
    // Exactly 7 × 24 hours from now is taken; a minute more is not. A whole-minute now, so the
    // minute typed is the bound itself.
    const wholeMinute = Date.parse('2026-12-01T03:00:00.000Z');
    const edge = new Date(wholeMinute + JUDGEMENT_DELAY_REVIEW_MAX_MS).toISOString();
    expect(Date.parse(edge) - wholeMinute).toBe(JUDGEMENT_DELAY_REVIEW_MAX_MS);
    expect(judgementDelayDraft('사유', local(edge), wholeMinute)).toMatchObject({
      ready: true,
      nextReviewAt: edge,
      nextReviewError: null,
    });
    const past = new Date(Date.parse(edge) + 60_000).toISOString();
    expect(judgementDelayDraft('사유', local(past), wholeMinute).nextReviewError).toBe(
      copy.errMarketJudgementDelayNextReviewTooFar,
    );
    expect(JUDGEMENT_DELAY_REVIEW_MAX_DAYS).toBe(7);
    expect(copy.errMarketJudgementDelayNextReviewTooFar).toContain(
      `${String(JUDGEMENT_DELAY_REVIEW_MAX_DAYS)}일`,
    );
    expect(copy.adminMarketJudgementDelayNextReviewHint).toContain(
      `${String(JUDGEMENT_DELAY_REVIEW_MAX_DAYS)}일`,
    );
  });

  it('says nothing of a blank time, and an unreadable one at once', () => {
    expect(judgementDelayDraft('사유', '', NOW)).toMatchObject({
      ready: false,
      nextReviewAt: null,
      nextReviewError: null,
    });
    expect(judgementDelayDraft('사유', 'garbage', NOW).nextReviewError).toBe(
      copy.errMarketJudgementDelayNextReviewTime,
    );
    expect(judgementDelayDraft('사유', '0099-12-31T23:00', NOW).nextReviewError).toBe(
      copy.errMarketJudgementDelayNextReviewTime,
    );
  });

  it('needs a reason of 1..500 characters', () => {
    const at = local(ahead(DAY_MS));
    for (const text of ['', '   ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1)]) {
      expect(judgementDelayDraft(text, at, NOW)).toMatchObject({
        ready: false,
        reasonError: copy.errMarketJudgementDelayReason,
      });
    }
    expect(judgementDelayDraft('x'.repeat(APPROVAL_REASON_MAX_LENGTH), at, NOW).ready).toBe(true);
  });

  it('draws again at the next bound: a good time as it passes, a far one as it comes within', () => {
    // A day at most, waited again from the draw it ends in.
    expect(judgementDelayDraftWait(local('2026-12-03T03:00:00.000Z'), NOW)).toBe(DAY_MS);
    const near = '2026-12-01T03:02:00.000Z';
    expect(judgementDelayDraftWait(local(near), NOW)).toBe(90_000 + 1_000);
    expect(judgementDelayDraft('사유', local(near), NOW + 91_000).nextReviewError).toBe(
      copy.errMarketJudgementDelayNextReviewAfter,
    );
    // Too far by 30 s (its minute): drawn again a second past the moment it comes within the bound.
    const far = new Date(NOW + JUDGEMENT_DELAY_REVIEW_MAX_MS + 60_000).toISOString();
    const farLocal = local(far);
    const farAt = Date.parse(far) - (Date.parse(far) % 60_000);
    expect(judgementDelayDraft('사유', farLocal, NOW).nextReviewError).toBe(
      copy.errMarketJudgementDelayNextReviewTooFar,
    );
    const within = judgementDelayDraftWait(farLocal, NOW);
    expect(within).toBe(farAt - JUDGEMENT_DELAY_REVIEW_MAX_MS - NOW + 1_000);
    expect(within).toBe(30_000 + 1_000);
    expect(judgementDelayDraft('사유', farLocal, NOW + (within ?? 0)).nextReviewError).toBeNull();
    // Not after now (it stays so), unreadable or blank: nothing to wait for.
    expect(judgementDelayDraftWait(local('2026-12-01T03:00:00.000Z'), NOW)).toBeNull();
    expect(judgementDelayDraftWait('garbage', NOW)).toBeNull();
    expect(judgementDelayDraftWait('', NOW)).toBeNull();
  });
});

describe('judgementDelayFailure', () => {
  it('closes on another account’s cookie, and says a session, a role or the market gone', () => {
    const another = apiError(403, 'FORBIDDEN', [
      { path: ['expectedAccountId'], message: 'session belongs to another account' },
    ]);
    expect(judgementDelayFailure(another)).toEqual({ kind: 'toast', message: copy.sessionChanged });
    expect(judgementDelayFailure(apiError(401, 'UNAUTHENTICATED'))).toEqual({
      kind: 'alert',
      message: copy.errUnauthenticated,
      refresh: false,
    });
    expect(judgementDelayFailure(apiError(403, 'FORBIDDEN'))).toEqual({
      kind: 'alert',
      message: copy.adminOnly,
      refresh: false,
    });
    expect(judgementDelayFailure(apiError(404, 'NOT_FOUND'))).toEqual({
      kind: 'alert',
      message: copy.adminMarketNotFound,
      refresh: true,
    });
    expect(judgementDelayFailure(new Error('offline'))).toEqual({
      kind: 'alert',
      message: copy.errNetwork,
      refresh: false,
    });
    expect(judgementDelayFailure(apiError(500, 'INTERNAL'))).toEqual({
      kind: 'alert',
      message: copy.errUnknown,
      refresh: false,
    });
  });

  it('says the four refusals of the record where they belong, reading the market again', () => {
    const { status, nextReviewAt } = MARKET_JUDGEMENT_DELAY_REFUSALS;
    expect(judgementDelayFailure(refused('status', status.notAwaitingJudgement))).toEqual({
      kind: 'alert',
      message: copy.errMarketJudgementDelayStatus,
      refresh: true,
    });
    expect(judgementDelayFailure(refused('status', status.notDelayed))).toEqual({
      kind: 'alert',
      message: copy.errMarketJudgementDelayNotDelayed,
      refresh: true,
    });
    expect(judgementDelayFailure(refused('nextReviewAt', nextReviewAt.notAfterNow))).toEqual({
      kind: 'field',
      field: 'nextReviewAt',
      message: copy.errMarketJudgementDelayNextReviewAfter,
    });
    expect(judgementDelayFailure(refused('nextReviewAt', nextReviewAt.tooFarAhead))).toEqual({
      kind: 'field',
      field: 'nextReviewAt',
      message: copy.errMarketJudgementDelayNextReviewTooFar,
    });
  });

  it('says the body’s own refusals under their fields, and anything else above the buttons', () => {
    expect(judgementDelayFailure(refused('nextReviewAt', 'Invalid ISO datetime'))).toEqual({
      kind: 'field',
      field: 'nextReviewAt',
      message: copy.errMarketJudgementDelayNextReviewTime,
    });
    expect(judgementDelayFailure(refused('reason', 'Too small'))).toEqual({
      kind: 'field',
      field: 'reason',
      message: copy.errMarketJudgementDelayReason,
    });
    expect(judgementDelayFailure(refused('expectedAccountId', 'Invalid input'))).toEqual({
      kind: 'alert',
      message: copy.errMarketInvalid,
      refresh: false,
    });
  });
});
