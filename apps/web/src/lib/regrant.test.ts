import { REGRANT_REFUSALS, findExcludedText } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type RegrantStatus } from './api';
import { isPrivateQueryKey } from './market-keys';
import {
  REGRANT_INTENT,
  REGRANT_REREAD_SLACK_MS,
  REGRANT_STATUS_KEY,
  canApplyRegrant,
  regrantDetailsOf,
  regrantFacts,
  regrantFailure,
  regrantFailureKept,
  regrantFailureShown,
  regrantGrantedText,
  regrantPeriodText,
  type RegrantPressFailure,
  regrantPressFailure,
  regrantRefusalText,
  regrantRefusals,
  regrantRefusedText,
  regrantReplayedText,
  regrantRereadAt,
  regrantResultText,
  regrantStatusKey,
  regrantWaitText,
} from './regrant';

/** A formatter that shows which instant it was given, so a sentence's time is checked exactly. */
const at = (iso: string) => `<${iso}>`;

const WAIT_UNTIL = '2026-11-22T06:00:00.000Z';
const NEXT_PERIOD = '2026-12-01T00:00:00.000Z';

/** An open status nothing refuses: the numbers the e2e settings would give, one re-grant used. */
const eligible: RegrantStatus = {
  open: true,
  eligible: true,
  refusals: [],
  amountCoin: '50000',
  thresholdCoin: '990000',
  waitHours: 0,
  waitUntil: null,
  periodDays: 30,
  periodLimit: 3,
  periodUsed: 1,
  nextPeriodAt: null,
  totalCapCoin: '500000',
  totalGrantedCoin: '50000',
  remainingCapCoin: '450000',
};

/** While a setting is undecided: every number null, and the reasons needing none still named. */
const notReady: RegrantStatus = {
  open: false,
  eligible: false,
  refusals: ['not_ready', 'no_start_grant'],
  amountCoin: null,
  thresholdCoin: null,
  waitHours: null,
  waitUntil: null,
  periodDays: null,
  periodLimit: null,
  periodUsed: null,
  nextPeriodAt: null,
  totalCapCoin: null,
  totalGrantedCoin: null,
  remainingCapCoin: null,
};

/** Every reason an open status can name, in the server's order, with the numbers they need. */
const refusedForAll: RegrantStatus = {
  ...eligible,
  eligible: false,
  refusals: REGRANT_REFUSALS.filter((reason) => reason !== 'not_ready'),
  waitHours: 24,
  waitUntil: WAIT_UNTIL,
  periodUsed: 3,
  nextPeriodAt: NEXT_PERIOD,
  totalGrantedCoin: '460000',
  remainingCapCoin: '40000',
};

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);

describe('the status key', () => {
  it("is the private `me` root's, kept under the account the wallet was drawn for (ADR-0091)", () => {
    expect(REGRANT_STATUS_KEY).toEqual(['me', 'regrant']);
    expect(regrantStatusKey('user-a')).toEqual(['me', 'regrant', 'user-a']);
    expect(isPrivateQueryKey(regrantStatusKey('user-a'))).toBe(true);
    expect(regrantStatusKey('user-a')).not.toEqual(regrantStatusKey('user-b'));
    expect(REGRANT_INTENT).toBe('regrant');
  });
});

describe('canApplyRegrant', () => {
  it('is on only while every setting is decided and nothing refuses it (owner answers 10·12)', () => {
    expect(canApplyRegrant(eligible)).toBe(true);
    expect(canApplyRegrant(refusedForAll)).toBe(false);
    expect(canApplyRegrant(notReady)).toBe(false);
  });
});

describe('the facts the card lists', () => {
  it('names the amount, the threshold, the period left and the cap left, in that order', () => {
    expect(regrantFacts(eligible)).toEqual([
      { testId: 'regrant-amount', label: copy.regrantAmount, value: '50,000 Coin' },
      {
        testId: 'regrant-threshold',
        label: copy.regrantThreshold,
        value: '가용 코인 990,000 Coin 이하',
      },
      { testId: 'regrant-period', label: copy.regrantPeriod, value: '최근 30일 3회 중 2회' },
      {
        testId: 'regrant-remaining-cap',
        label: copy.regrantRemainingCap,
        value: '450,000 Coin (누적 상한 500,000 Coin)',
      },
    ]);
  });

  it('lists nothing while not open: every number is unknown then (owner answer 12)', () => {
    expect(regrantFacts(notReady)).toEqual([]);
  });

  it('never counts a period below none left, a limit lowered under what was used included', () => {
    expect(regrantPeriodText(30, 3, 0)).toBe('최근 30일 3회 중 3회');
    expect(regrantPeriodText(30, 3, 3)).toBe('최근 30일 3회 중 0회');
    expect(regrantPeriodText(7, 1, 4)).toBe('최근 7일 1회 중 0회');
  });

  it('says the 대기기간 only when there is one', () => {
    expect(regrantWaitText(eligible)).toBeNull();
    expect(regrantWaitText(notReady)).toBeNull();
    expect(regrantWaitText({ open: true, waitHours: 24 })).toBe(
      '마지막 재지급(처음이면 시작 Coin을 받은 때) 뒤 24시간이 지나야 받을 수 있습니다.',
    );
    expect(regrantWaitText({ open: true, waitHours: 8760 })).toContain('8,760시간');
  });
});

describe('the refusals', () => {
  it('say every reason in the order asked, each with its numbers and absolute times (owner answer 9)', () => {
    const lines = regrantRefusals(refusedForAll, at);
    expect(lines.map((line) => line.reason)).toEqual([
      'restricted',
      'admin',
      'held',
      'no_start_grant',
      'not_exhausted',
      'live_orders',
      'unsettled_positions',
      'waiting',
      'period_limit',
      'total_cap',
    ]);
    expect(lines.map((line) => line.message)).toEqual([
      '계정 제한 중에는 재지급을 받을 수 없습니다.',
      '관리자 권한이 있는 동안에는 재지급을 받을 수 없습니다.',
      copy.regrantRefusalHeld,
      copy.regrantRefusalNoStartGrant,
      '가용 코인이 990,000 Coin 이하일 때 받을 수 있습니다.',
      copy.regrantRefusalLiveOrders,
      copy.regrantRefusalUnsettled,
      `대기기간이 지나지 않았습니다. <${WAIT_UNTIL}>부터 받을 수 있습니다.`,
      `최근 30일 동안 받을 수 있는 3회를 모두 받았습니다. <${NEXT_PERIOD}>부터 다시 받을 수 있습니다.`,
      '남은 누적 한도 40,000 Coin이 1회 지급액 50,000 Coin보다 적어 받을 수 없습니다.',
    ]);
    // The account restriction's line alone has the way to 조치·신고 내역 under it.
    expect(lines.filter((line) => line.restricted).map((line) => line.reason)).toEqual([
      'restricted',
    ]);
  });

  it('says the account restriction’s end when MY’s restriction read names it', () => {
    const until = '2026-12-01T00:00:00.000Z';
    const restricted: RegrantStatus = { ...eligible, eligible: false, refusals: ['restricted'] };
    expect(regrantRefusalText('restricted', restricted, at, until)).toBe(
      `계정 제한 중에는 재지급을 받을 수 없습니다(<${until}>까지).`,
    );
    expect(regrantRefusalText('restricted', restricted, at, null)).toBe(
      '계정 제한 중에는 재지급을 받을 수 없습니다(무기한).',
    );
    // Not known (not read yet, or read as none while the status still names one): the sentence.
    expect(regrantRefusalText('restricted', restricted, at)).toBe(
      '계정 제한 중에는 재지급을 받을 수 없습니다.',
    );
    expect(regrantRefusals(restricted, at, until)).toEqual([
      {
        reason: 'restricted',
        message: `계정 제한 중에는 재지급을 받을 수 없습니다(<${until}>까지).`,
        restricted: true,
      },
    ]);
    // The end is the restriction's alone: no other reason's sentence changes with it.
    expect(
      regrantRefusals(refusedForAll, at, until)
        .filter((line) => line.reason !== 'restricted')
        .map((line) => line.message),
    ).toEqual(
      regrantRefusals(refusedForAll, at)
        .filter((line) => line.reason !== 'restricted')
        .map((line) => line.message),
    );
  });

  it('says an admin’s refusal as its own line, with no way to 조치·신고 내역 (ADR-0156)', () => {
    const admin: RegrantStatus = { ...eligible, eligible: false, refusals: ['admin'] };
    expect(regrantRefusals(admin, at, '2026-12-01T00:00:00.000Z')).toEqual([
      {
        reason: 'admin',
        message: '관리자 권한이 있는 동안에는 재지급을 받을 수 없습니다.',
        restricted: false,
      },
    ]);
    expect(regrantRefusedText(admin, at)).toBe(
      '지금은 재지급을 받을 수 없습니다. 관리자 권한이 있는 동안에는 재지급을 받을 수 없습니다.',
    );
  });

  it("says '준비 중' alone while not open, whatever else the server named (owner answer 12)", () => {
    expect(regrantRefusals(notReady, at)).toEqual([]);
    expect(regrantRefusals({ ...notReady, refusals: ['not_ready', 'admin'] }, at)).toEqual([]);
    expect(regrantRefusalText('not_ready', notReady, at)).toBe(copy.regrantNotReady);
  });

  it('none for an eligible status', () => {
    expect(regrantRefusals(eligible, at)).toEqual([]);
  });

  it('goes without a number a reason should carry rather than writing null', () => {
    const bare: RegrantStatus = { ...notReady, open: true };
    expect(regrantRefusalText('waiting', bare, at)).toBe(copy.regrantRefusalWaiting);
    expect(regrantRefusalText('period_limit', { ...eligible, nextPeriodAt: null }, at)).toBe(
      '최근 30일 동안 받을 수 있는 3회를 모두 받았습니다.',
    );
    for (const reason of ['not_exhausted', 'period_limit', 'total_cap'] as const) {
      expect(regrantRefusalText(reason, bare, at), reason).toBe(copy.regrantBlocked);
    }
  });

  it('names no excluded feature, in any sentence the card can say', () => {
    const texts = [
      ...REGRANT_REFUSALS.map((reason) => regrantRefusalText(reason, refusedForAll, at)),
      ...regrantFacts(eligible).flatMap((fact) => [fact.label, fact.value]),
      regrantWaitText({ open: true, waitHours: 24 }) ?? '',
      regrantGrantedText({ amountCoin: '50000' }),
      regrantReplayedText({ amountCoin: '50000', createdAt: '2026-11-21T03:00:00.000Z' }, at),
      regrantRefusedText(refusedForAll, at),
      ...Object.entries(copy)
        .filter(([key]) => key.startsWith('regrant'))
        .map(([, text]) => text),
    ];
    for (const text of texts) expect(findExcludedText(text), text).toEqual([]);
  });
});

describe('the instant the card reads the status again', () => {
  const plus = (iso: string) => new Date(Date.parse(iso) + REGRANT_REREAD_SLACK_MS).toISOString();

  it('is the earlier of the wait’s end and the period’s free slot, a second after it', () => {
    expect(REGRANT_REREAD_SLACK_MS).toBe(1_000);
    expect(regrantRereadAt({ open: true, waitUntil: WAIT_UNTIL, nextPeriodAt: null })).toBe(
      '2026-11-22T06:00:01.000Z',
    );
    expect(regrantRereadAt({ open: true, waitUntil: null, nextPeriodAt: NEXT_PERIOD })).toBe(
      plus(NEXT_PERIOD),
    );
    expect(regrantRereadAt(refusedForAll)).toBe(plus(WAIT_UNTIL));
    // Either order: the earlier one.
    expect(regrantRereadAt({ open: true, waitUntil: NEXT_PERIOD, nextPeriodAt: WAIT_UNTIL })).toBe(
      plus(WAIT_UNTIL),
    );
  });

  it('is none with neither set, while not open, or before the status is read', () => {
    expect(regrantRereadAt(eligible)).toBeNull();
    expect(regrantRereadAt(notReady)).toBeNull();
    expect(regrantRereadAt({ open: false, waitUntil: WAIT_UNTIL, nextPeriodAt: null })).toBeNull();
    expect(regrantRereadAt(undefined)).toBeNull();
    expect(regrantRereadAt({ open: true, waitUntil: 'not a time', nextPeriodAt: null })).toBeNull();
  });
});

describe('a press', () => {
  it("says '재지급 X Coin을 받았습니다.' after a fresh grant", () => {
    expect(regrantGrantedText({ amountCoin: '50000' })).toBe('재지급 50,000 Coin을 받았습니다.');
    const regrant = {
      id: '0b8a3c5e-2f4d-4e6a-9b1c-3d5e7f9a1b2c',
      amountCoin: '50000',
      createdAt: '2026-11-21T03:00:00.000Z',
    };
    expect(regrantResultText({ regrant, replayed: false }, at)).toBe(
      '재지급 50,000 Coin을 받았습니다.',
    );
  });

  it('says a replayed answer’s re-grant was received already, and when — never as a new one (N01 §9)', () => {
    // The id kept from a lost answer, sent again at once or days later: the API answers the
    // re-grant it gave then, and nothing more was given by this press.
    const regrant = {
      id: '0b8a3c5e-2f4d-4e6a-9b1c-3d5e7f9a1b2c',
      amountCoin: '50000',
      createdAt: '2026-11-18T03:00:00.000Z',
    };
    const said =
      '재지급 50,000 Coin은 <2026-11-18T03:00:00.000Z>에 이미 받았습니다. ' +
      '이번 신청으로 더 받은 Coin은 없습니다.';
    expect(regrantReplayedText(regrant, at)).toBe(said);
    expect(regrantResultText({ regrant, replayed: true }, at)).toBe(said);
    expect(said).not.toContain(regrantGrantedText(regrant));
  });

  it('takes REGRANT_NOT_ALLOWED’s details as the status, and announces every reason from them', () => {
    const refused = apiError(409, 'REGRANT_NOT_ALLOWED', refusedForAll);
    expect(regrantDetailsOf(refused)).toEqual(refusedForAll);
    // The redraw of the list is not announced: the line under the button (role="alert") says it.
    const reasons = regrantRefusals(refusedForAll, at).map((line) => line.message);
    expect(regrantFailure(refused, at)).toEqual({
      message: [copy.regrantBlocked, ...reasons].join(' '),
      restricted: false,
    });
    // The usual race — an order placed in another tab between the read and the press.
    const liveOrder: RegrantStatus = { ...eligible, eligible: false, refusals: ['live_orders'] };
    expect(regrantFailure(apiError(409, 'REGRANT_NOT_ALLOWED', liveOrder), at)).toEqual({
      message: `${copy.regrantBlocked} ${copy.regrantRefusalLiveOrders}`,
      restricted: false,
    });
    expect(regrantRefusedText(liveOrder, at)).toBe(
      `${copy.regrantBlocked} ${copy.regrantRefusalLiveOrders}`,
    );
    // A setting undecided since the read: '준비 중' alone, as the card then says.
    expect(regrantFailure(apiError(409, 'REGRANT_NOT_ALLOWED', notReady), at)).toEqual({
      message: copy.regrantNotReady,
      restricted: false,
    });
    // Details that do not read (never from this API): the bare refusal.
    expect(regrantDetailsOf(apiError(409, 'REGRANT_NOT_ALLOWED', { open: 'yes' }))).toBeUndefined();
    expect(regrantFailure(apiError(409, 'REGRANT_NOT_ALLOWED'), at)).toEqual({
      message: copy.regrantBlocked,
      restricted: false,
    });
    expect(regrantDetailsOf(apiError(403, 'RESTRICTED', refusedForAll))).toBeUndefined();
  });

  it('says an account restriction with its end, and the way to 조치·신고 내역 (owner answer 8)', () => {
    const until = '2026-12-01T00:00:00.000Z';
    expect(
      regrantFailure(apiError(403, 'RESTRICTED', { kind: 'account', endsAt: until }), at),
    ).toEqual({
      message: `계정 제한 중에는 재지급을 받을 수 없습니다(<${until}>까지).`,
      restricted: true,
    });
    expect(
      regrantFailure(apiError(403, 'RESTRICTED', { kind: 'account', endsAt: null }), at),
    ).toEqual({ message: '계정 제한 중에는 재지급을 받을 수 없습니다(무기한).', restricted: true });
  });

  it('ties REGRANT_NOT_ALLOWED’s line to the status reading its details became', () => {
    const readAt = Date.parse('2026-11-21T03:00:00.000Z');
    const liveOrder: RegrantStatus = { ...eligible, eligible: false, refusals: ['live_orders'] };
    const error = apiError(409, 'REGRANT_NOT_ALLOWED', liveOrder);
    const failure = regrantPressFailure(error, at, readAt);
    expect(failure).toEqual({ refusal: regrantFailure(error, at), readingAt: readAt });
    // Drawn while that is the status's reading (a read again that failed leaves it so)…
    expect(regrantFailureShown(failure, liveOrder, readAt, at)).toEqual(failure.refusal);
    // …and gone at a newer one that says anything else: eligible, or another reason or number.
    expect(regrantFailureShown(failure, eligible, readAt + 1, at)).toBeNull();
    const notExhausted: RegrantStatus = { ...liveOrder, refusals: ['not_exhausted'] };
    expect(regrantFailureShown(failure, notExhausted, readAt + 1, at)).toBeNull();
    const both: RegrantStatus = { ...liveOrder, refusals: ['live_orders', 'not_exhausted'] };
    expect(regrantFailureShown(failure, both, readAt + 1, at)).toBeNull();
    const waiting: RegrantStatus = { ...eligible, eligible: false, refusals: ['waiting'] };
    const waited = regrantPressFailure(
      apiError(409, 'REGRANT_NOT_ALLOWED', { ...waiting, waitUntil: WAIT_UNTIL }),
      at,
      readAt,
    );
    expect(
      regrantFailureShown(waited, { ...waiting, waitUntil: NEXT_PERIOD }, readAt + 1, at),
    ).toBeNull();
    // A newer reading saying the very same refusal keeps it: the refusal's own read of `['me']`
    // moves the balance the card had, which reads the status again at once.
    expect(regrantFailureShown(failure, { ...liveOrder }, readAt + 60_000, at)).toEqual(
      failure.refusal,
    );
    expect(
      regrantFailureShown(waited, { ...waiting, waitUntil: WAIT_UNTIL }, readAt + 1, at),
    ).toEqual(waited.refusal);
    // No status held to tie it to (never while the card is drawn): kept as any other refusal.
    expect(regrantPressFailure(error, at, undefined).readingAt).toBeNull();
    expect(regrantFailureShown(null, liveOrder, readAt, at)).toBeNull();
  });

  it('drops REGRANT_NOT_ALLOWED’s press once a newer reading withdrew its line, for good', () => {
    const readAt = Date.parse('2026-11-21T03:00:00.000Z');
    const liveOrder: RegrantStatus = { ...eligible, eligible: false, refusals: ['live_orders'] };
    const error = apiError(409, 'REGRANT_NOT_ALLOWED', liveOrder);
    // The panel's state reading by reading: the details' own, a newer one saying the same, one
    // that may apply (the line withdrawn), then a later one saying the same sentence again.
    let kept: RegrantPressFailure | null = regrantPressFailure(error, at, readAt);
    const pressed = kept;
    kept = regrantFailureKept(kept, liveOrder, readAt, at);
    expect(kept).toBe(pressed);
    kept = regrantFailureKept(kept, { ...liveOrder }, readAt + 1_000, at);
    expect(kept).toBe(pressed);
    kept = regrantFailureKept(kept, eligible, readAt + 2_000, at);
    expect(kept).toBeNull();
    kept = regrantFailureKept(kept, { ...liveOrder }, readAt + 3_000, at);
    expect(kept).toBeNull();
    expect(regrantFailureShown(kept, liveOrder, readAt + 3_000, at)).toBeNull();
    // Any other refusal is kept whatever the status reads.
    const network = regrantPressFailure(new TypeError('fetch failed'), at, readAt);
    expect(regrantFailureKept(network, eligible, readAt + 60_000, at)).toBe(network);
  });

  it('keeps any other refusal until the next press, whatever the status reads since', () => {
    const readAt = Date.parse('2026-11-21T03:00:00.000Z');
    for (const error of [
      apiError(409, 'REGRANT_NOT_ALLOWED'),
      apiError(403, 'RESTRICTED', { kind: 'account', endsAt: null }),
      apiError(409, 'ONBOARDING_REQUIRED'),
      new TypeError('fetch failed'),
    ]) {
      const failure = regrantPressFailure(error, at, readAt);
      expect(failure.readingAt).toBeNull();
      expect(regrantFailureShown(failure, eligible, readAt + 60_000, at)).toEqual(
        regrantFailure(error, at),
      );
    }
  });

  it('tells another account’s cookie, a step left, a session gone and no answer apart', () => {
    const forAnother = apiError(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]);
    expect(regrantFailure(forAnother, at)?.message).toBe(copy.sessionChanged);
    expect(regrantFailure(apiError(409, 'ONBOARDING_REQUIRED'), at)?.message).toBe(
      copy.errPostOnboarding,
    );
    expect(regrantFailure(apiError(401, 'UNAUTHENTICATED'), at)?.message).toBe(
      copy.errUnauthenticated,
    );
    expect(regrantFailure(new TypeError('fetch failed'), at)?.message).toBe(copy.errNetwork);
    expect(regrantFailure(new ApiError(502, undefined), at)?.message).toBe(copy.errNetwork);
    expect(regrantFailure(apiError(500, 'INTERNAL'), at)?.message).toBe(copy.errUnknown);
  });
});
