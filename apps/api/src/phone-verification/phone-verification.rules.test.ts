/**
 * The code's rules (ADR-0069 decision 1 #57-3, ADR-0070) without Postgres: what the drawn codes
 * look like, the keyed hash and its constant-time comparison, expiry, the entries a code takes,
 * an older code recognised, the resend interval and the daily limits of the account, the account
 * at a number, the accounts at a number, the client address and the service, and the whole
 * minutes the limits shared with other accounts answer. Runs everywhere.
 */
import * as crypto from 'node:crypto';
import { schema } from '@buddha/db';
import { PHONE_VERIFICATION_LIMITS } from '@buddha/shared';
import { DrizzleQueryError } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { stdSerializers } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import {
  codeMatches,
  dayWindowStart,
  deriveCodeKey,
  drawCode,
  expiryOf,
  hashCode,
  matchesOlderCode,
  mismatchRefusal,
  OLDER_CODES_COMPARED,
  pendingCodeRefusal,
  sendRefusal,
  sharedWaitSeconds,
  sharedWindowStart,
  type SendHistory,
} from './phone-verification.rules.js';
import {
  confirmWriteRefusal,
  PHONE_UNIQUE_CONSTRAINT,
  verificationWriteFailure,
} from './phone-verification.service.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return {
    ...actual,
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
    randomInt: vi.fn(actual.randomInt),
  };
});

afterEach(() => {
  vi.mocked(crypto.timingSafeEqual).mockClear();
  vi.mocked(crypto.randomInt).mockClear();
});

const T0 = new Date('2026-10-18T03:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const SECOND = 1_000;
const DAY = 24 * 60 * 60 * SECOND;
const key = deriveCodeKey('unit-secret-0123456789abcdef0123456789');
const ROW = '6f1f0d0e-7a52-4b6e-9a41-0d4b0c1e2f3a';

describe('drawCode', () => {
  it('is six digits, leading zeros kept, over the whole range', () => {
    expect(drawCode(() => 0)).toBe('000000');
    expect(drawCode(() => 42)).toBe('000042');
    expect(drawCode((max) => max - 1)).toBe('999999');
    const draw = vi.fn((max: number) => max - 1);
    drawCode(draw);
    expect(draw).toHaveBeenCalledWith(1_000_000);
  });

  it('draws from the CSPRNG by default, over the whole range', () => {
    const draws = Array.from({ length: 50 }, () => drawCode());
    for (const code of draws) expect(code).toMatch(/^\d{6}$/);
    // node:crypto's randomInt, not Math.random or a constant: every draw asked it for 10^6.
    expect(crypto.randomInt).toHaveBeenCalledTimes(50);
    expect(vi.mocked(crypto.randomInt).mock.calls.every(([max]) => max === 1_000_000)).toBe(true);
    expect(new Set(draws).size).toBeGreaterThan(1);
  });
});

describe('the keyed hash', () => {
  it('stores no digits: hex of an HMAC bound to the row and the secret', () => {
    const hash = hashCode(key, ROW, '012345');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('012345');
    // Another row, another secret: another hash for the same code.
    expect(hashCode(key, '7f1f0d0e-7a52-4b6e-9a41-0d4b0c1e2f3a', '012345')).not.toBe(hash);
    expect(hashCode(deriveCodeKey('another-secret'), ROW, '012345')).not.toBe(hash);
    expect(deriveCodeKey('unit-secret-0123456789abcdef0123456789')).toEqual(key);
  });

  it('matches the code it hashed and nothing else, in constant time', () => {
    const hash = hashCode(key, ROW, '012345');
    expect(codeMatches(key, ROW, '012345', hash)).toBe(true);
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1);
    for (const wrong of ['012344', '12345', '0123456', '']) {
      expect(codeMatches(key, ROW, wrong, hash), wrong).toBe(false);
    }
    // Every comparison of two digests went through timingSafeEqual.
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(5);
    // Bound to its row: the right code under another row's id does not match.
    expect(codeMatches(key, '7f1f0d0e-7a52-4b6e-9a41-0d4b0c1e2f3a', '012345', hash)).toBe(false);
  });

  it('matches nothing against a stored value that is not a digest, without throwing', () => {
    expect(codeMatches(key, ROW, '012345', '')).toBe(false);
    expect(codeMatches(key, ROW, '012345', 'abc')).toBe(false);
    expect(codeMatches(key, ROW, '012345', '012345')).toBe(false);
  });
});

describe('expiry and the windows', () => {
  it('ends a code three minutes after its send and counts the 24 hours before now', () => {
    expect(expiryOf(T0)).toEqual(at(PHONE_VERIFICATION_LIMITS.codeTtlSeconds * SECOND));
    expect(expiryOf(T0)).toEqual(at(180 * SECOND));
    expect(dayWindowStart(T0)).toEqual(at(-DAY));
    expect(dayWindowStart(at(17_400))).toEqual(at(-DAY + 17_400));
  });

  it('counts the shared limits over the 24 hours before the minute began (third round)', () => {
    // T0 is on a minute: the two windows agree there, and part only within the minute.
    expect(sharedWindowStart(T0)).toEqual(at(-DAY));
    expect(sharedWindowStart(at(1))).toEqual(at(-DAY));
    expect(sharedWindowStart(at(17_400))).toEqual(at(-DAY));
    expect(sharedWindowStart(at(59_999))).toEqual(at(-DAY));
    expect(sharedWindowStart(at(60_000))).toEqual(at(-DAY + 60_000));
  });
});

describe('pendingCodeRefusal', () => {
  const pending = { attempts: 0, expiresAt: at(180 * SECOND), consumedAt: null };

  it('lets a waiting, unexpired code with entries left be compared', () => {
    expect(pendingCodeRefusal(pending, T0)).toBeUndefined();
    expect(pendingCodeRefusal({ ...pending, attempts: 4 }, at(179_999))).toBeUndefined();
  });

  it('refuses when no code waits: none sent, or the newest was used', () => {
    expect(pendingCodeRefusal(undefined, T0)).toEqual({ reason: 'no_code' });
    expect(pendingCodeRefusal({ ...pending, consumedAt: T0 }, T0)).toEqual({ reason: 'no_code' });
  });

  it('refuses a code from the instant its three minutes are over', () => {
    expect(pendingCodeRefusal(pending, at(180 * SECOND))).toEqual({ reason: 'expired' });
    expect(pendingCodeRefusal(pending, at(DAY))).toEqual({ reason: 'expired' });
  });

  it('refuses a code that took its fifth wrong entry, before its expiry is looked at', () => {
    expect(pendingCodeRefusal({ ...pending, attempts: 5 }, T0)).toEqual({
      reason: 'attempts_exceeded',
    });
    expect(pendingCodeRefusal({ ...pending, attempts: 5 }, at(DAY))).toEqual({
      reason: 'attempts_exceeded',
    });
  });
});

describe('mismatchRefusal', () => {
  it('says how many entries are left, and discards the code on the fifth', () => {
    expect([1, 2, 3, 4, 5].map(mismatchRefusal)).toEqual([
      { reason: 'mismatch', remainingAttempts: 4 },
      { reason: 'mismatch', remainingAttempts: 3 },
      { reason: 'mismatch', remainingAttempts: 2 },
      { reason: 'mismatch', remainingAttempts: 1 },
      { reason: 'attempts_exceeded' },
    ]);
  });
});

describe('matchesOlderCode', () => {
  const OLDER = '7f1f0d0e-7a52-4b6e-9a41-0d4b0c1e2f3a';
  const OLDEST = '8f1f0d0e-7a52-4b6e-9a41-0d4b0c1e2f3a';
  const older = [
    { id: OLDER, codeHash: hashCode(key, OLDER, '111111') },
    { id: OLDEST, codeHash: hashCode(key, OLDEST, '222222') },
  ];

  it('recognises any older code of the account, under its own row', () => {
    expect(matchesOlderCode(key, '111111', older)).toBe(true);
    expect(matchesOlderCode(key, '222222', older)).toBe(true);
    expect(matchesOlderCode(key, '333333', older)).toBe(false);
    expect(matchesOlderCode(key, '111111', [])).toBe(false);
    // Bound to the row it was sent as: the same digits hashed for another row are not it.
    expect(matchesOlderCode(key, '111111', [{ id: OLDEST, codeHash: older[0]!.codeHash }])).toBe(
      false,
    );
  });

  it('compares every older code in constant time, without stopping at a match', () => {
    vi.mocked(crypto.timingSafeEqual).mockClear();
    expect(matchesOlderCode(key, '111111', older)).toBe(true);
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(2);
  });

  it('is given a day’s sends less the newest: every code of the last 24 hours, with no time bound', () => {
    // The account sends at most ten codes in any 24 hours, so the nine before the newest hold
    // every older code of that window — and the text before a resend, however long ago it came.
    expect(OLDER_CODES_COMPARED).toBe(PHONE_VERIFICATION_LIMITS.accountDailySends - 1);
  });
});

describe('sendRefusal', () => {
  const history = (overrides: Partial<SendHistory> = {}): SendHistory => ({
    clock: T0,
    lastAccountSend: null,
    account: [],
    accountPhone: [],
    phoneAccounts: [],
    ip: [],
    service: [],
    ...overrides,
  });
  /** `count` sends, newest first: the newest `newestAgo` before T0, one minute apart. */
  const sends = (count: number, newestAgo: number) =>
    Array.from({ length: count }, (_, index) => at(-newestAgo - index * 60 * SECOND));
  /** The send at a limit `limit` leaves the window `waitSeconds` from now: newest first. */
  const atLimit = (limit: number, waitSeconds: number) =>
    Array.from({ length: limit }, (_, index) =>
      index === limit - 1 ? at(-DAY + waitSeconds * SECOND) : at(-index * 60 * SECOND),
    );

  it('holds the fixed values the owner gave (2026-10-17 and 2026-10-18)', () => {
    expect(PHONE_VERIFICATION_LIMITS).toMatchObject({
      accountDailySends: 10,
      accountPhoneDailySends: 10,
      phoneDailyAccounts: 3,
      ipDailySends: 50,
      serviceDailySends: 500,
      dailyWindowSeconds: 86_400,
    });
  });

  it('lets the first send go', () => {
    expect(sendRefusal(history())).toBeUndefined();
  });

  it('refuses a send within sixty seconds of the account’s previous one', () => {
    expect(sendRefusal(history({ lastAccountSend: at(-59_001) }))).toEqual({
      reason: 'resend_interval',
      retryAfterSeconds: 1,
    });
    expect(sendRefusal(history({ lastAccountSend: at(-1) }))).toEqual({
      reason: 'resend_interval',
      retryAfterSeconds: 60,
    });
    expect(sendRefusal(history({ lastAccountSend: at(-60 * SECOND) }))).toBeUndefined();
  });

  it('refuses the eleventh send of the account in 24 hours until the tenth newest leaves', () => {
    expect(sendRefusal(history({ account: sends(9, 2 * 60 * SECOND) }))).toBeUndefined();
    expect(sendRefusal(history({ account: atLimit(10, 90) }))).toEqual({
      reason: 'account_daily',
      retryAfterSeconds: 90,
    });
  });

  it('refuses the eleventh send of the account to one number (the pair, owner decision 2026-10-18)', () => {
    // Every send of the pair is the account's too, so with the shipped values the account's own
    // ten answer first, on a tie — the pair's limit stands on its own only in this pure form.
    expect(sendRefusal(history({ accountPhone: sends(9, 2 * 60 * SECOND) }))).toBeUndefined();
    expect(sendRefusal(history({ accountPhone: atLimit(10, 600) }))).toEqual({
      reason: 'account_phone_daily',
      retryAfterSeconds: 600,
    });
    const both = atLimit(10, 600);
    expect(sendRefusal(history({ account: both, accountPhone: both }))).toEqual({
      reason: 'account_daily',
      retryAfterSeconds: 600,
    });
  });

  it('refuses a fourth account at a number, but none of the three that have sent to it', () => {
    // Two other accounts: a third may come.
    expect(sendRefusal(history({ phoneAccounts: sends(2, 2 * 60 * SECOND) }))).toBeUndefined();
    // Three other accounts: refused until the third newest of them leaves the window, in whole
    // minutes (T0 is on a minute, and so is this send's time).
    const three = [at(-5 * SECOND), at(-3_600 * SECOND), at(-DAY + 1_800 * SECOND)];
    expect(sendRefusal(history({ phoneAccounts: three }))).toEqual({
      reason: 'phone_accounts',
      retryAfterSeconds: 1_800,
    });
    // Off the minute, it is rounded up to the next one.
    const offMinute = [at(-5 * SECOND), at(-3_600 * SECOND), at(-DAY + 1_800 * SECOND + 1)];
    expect(sendRefusal(history({ phoneAccounts: offMinute }))).toEqual({
      reason: 'phone_accounts',
      retryAfterSeconds: 1_860,
    });
    // An account that has itself sent to the number in the window is one of the three.
    expect(
      sendRefusal(history({ phoneAccounts: three, accountPhone: [at(-120 * SECOND)] })),
    ).toBeUndefined();
  });

  it('refuses the fifty-first send from one client address, and counts none for no address', () => {
    expect(sendRefusal(history({ ip: sends(49, 2 * 60 * SECOND) }))).toBeUndefined();
    expect(sendRefusal(history({ ip: atLimit(50, 300) }))).toEqual({
      reason: 'ip_daily',
      retryAfterSeconds: 300,
    });
    expect(sendRefusal(history({ ip: atLimit(50, 241) }))).toEqual({
      reason: 'ip_daily',
      retryAfterSeconds: 300,
    });
    // A request that names no client (loopback, the web's rewrite) is not counted by address.
    expect(sendRefusal(history({ ip: null }))).toBeUndefined();
  });

  it('refuses the service’s five hundred and first send in 24 hours', () => {
    expect(sendRefusal(history({ service: sends(499, 2 * 60 * SECOND) }))).toBeUndefined();
    // Forty-two seconds away: answered as the minute it falls in.
    expect(sendRefusal(history({ service: atLimit(500, 42) }))).toEqual({
      reason: 'service_daily',
      retryAfterSeconds: 60,
    });
  });

  it('answers the account’s own limits to the second and the shared ones in whole minutes (second round)', () => {
    // The same 42 seconds: exact for the account's own ten, a minute for the service's.
    expect(sendRefusal(history({ account: atLimit(10, 42) }))).toEqual({
      reason: 'account_daily',
      retryAfterSeconds: 42,
    });
    expect(sendRefusal(history({ accountPhone: atLimit(10, 42) }))).toEqual({
      reason: 'account_phone_daily',
      retryAfterSeconds: 42,
    });
    expect(sendRefusal(history({ lastAccountSend: at(-18 * SECOND) }))).toEqual({
      reason: 'resend_interval',
      retryAfterSeconds: 42,
    });
    for (const shared of [
      { phoneAccounts: atLimit(3, 42) },
      { ip: atLimit(50, 42) },
      { service: atLimit(500, 42) },
    ]) {
      expect(sendRefusal(history(shared))?.retryAfterSeconds).toBe(60);
    }
  });

  it('answers a shared limit the same whole minutes whatever second it is asked at', () => {
    // Another account's send leaves the window at 12:30:17.4 (clock time). Asked at any second
    // of 12:01, the answer is 30 minutes, at 12:02 29: it moves on the clock's minutes only, so
    // asking again and again does not find the 17.4 seconds.
    const minute = (m: number, s = 0) => new Date(Date.UTC(2026, 9, 18, 3, m, 0) + s * SECOND);
    const leaves = minute(30, 17.4).getTime();
    for (const s of [0, 0.001, 17, 17.4, 17.5, 42, 59.999]) {
      expect(sharedWaitSeconds(leaves, minute(1, s)), String(s)).toBe(30 * 60);
      expect(sharedWaitSeconds(leaves, minute(2, s)), String(s)).toBe(29 * 60);
    }
    // Never shorter than the exact wait, and at most two minutes longer.
    for (let ms = 0; ms < 120_000; ms += 997) {
      const clock = new Date(T0.getTime() + ms);
      const wait = sharedWaitSeconds(leaves, clock);
      const exact = (leaves - clock.getTime()) / SECOND;
      expect(wait % 60).toBe(0);
      expect(wait).toBeGreaterThanOrEqual(exact);
      expect(wait).toBeLessThan(exact + 120);
    }
    // At least a minute, on the minute itself too.
    expect(sharedWaitSeconds(minute(5, 0.5).getTime(), minute(5, 0))).toBe(60);
    expect(sharedWaitSeconds(minute(5).getTime(), minute(4, 59.9))).toBe(60);
  });

  it('holds a shared limit shut until the minute it answered, not until the send leaves (third round)', () => {
    // The third other account's send turns 24 hours old at T0 + 17.4 s (clock time). The refusal
    // answers the minute that holds it, 12:01 — and the limit stays shut until then: asked a
    // millisecond after the send is 24 hours old, or at any instant of that minute, the same
    // request is refused with the same answer, so asking again and again through the minute does
    // not find the 17.4 seconds. It passes from the minute answered on (owner decision 2026-10-18,
    // third round; ADR-0070 7-25 had it open at the instant itself).
    const third = at(-DAY + 17_400);
    const leaves = third.getTime() + DAY;
    const opens = T0.getTime() + 60 * SECOND;
    /** The other accounts' sends the service reads at `clock`: those inside the shared window. */
    const others = (clock: Date) =>
      [at(-5 * SECOND), at(-3_600 * SECOND), third].filter(
        (sent) => sent.getTime() > sharedWindowStart(clock).getTime(),
      );
    const ask = (clock: Date) => sendRefusal(history({ clock, phoneAccounts: others(clock) }));
    for (const ms of [leaves - 1, leaves, leaves + 1, opens - 1_000, opens - 1]) {
      const clock = new Date(ms);
      const refusal = ask(clock);
      expect(refusal, clock.toISOString()).toEqual({
        reason: 'phone_accounts',
        retryAfterSeconds: 60,
      });
      // The answer, counted from the start of the asking minute, is the minute the limit opens.
      expect(Math.floor(ms / 60_000) * 60_000 + refusal!.retryAfterSeconds * SECOND).toBe(opens);
    }
    // Asked earlier in the minute, the same: the answer moves on the clock's minutes only.
    expect(ask(at(1))).toEqual({ reason: 'phone_accounts', retryAfterSeconds: 60 });
    expect(ask(at(-1))).toEqual({ reason: 'phone_accounts', retryAfterSeconds: 120 });
    expect(ask(new Date(opens))).toBeUndefined();
    expect(ask(new Date(opens + 1))).toBeUndefined();
    // Even given the send, the rules do not count it past its minute.
    expect(
      sendRefusal(
        history({
          clock: new Date(opens),
          phoneAccounts: [at(-5 * SECOND), at(-3_600 * SECOND), third],
        }),
      ),
    ).toBeUndefined();
  });

  it('keeps every shared limit shut exactly until the minute answered, and the account’s own to the instant', () => {
    // Over a sweep of send times and asking instants: a shared limit refuses while the clock is
    // before the first whole minute at or after the send's 24 hours, answers that minute counted
    // from the start of the asking minute (so a client waiting it from its answer never comes back
    // before the limit opens, and less than a minute after), and the account's own limits refuse
    // only until the instant itself, to the second.
    const MINUTE = 60 * SECOND;
    const shared = [
      { key: 'phoneAccounts', limit: 3, reason: 'phone_accounts' },
      { key: 'ip', limit: 50, reason: 'ip_daily' },
      { key: 'service', limit: 500, reason: 'service_daily' },
    ] as const;
    const own = [
      { key: 'account', limit: 10, reason: 'account_daily' },
      { key: 'accountPhone', limit: 10, reason: 'account_phone_daily' },
    ] as const;
    for (const offset of [0, 1, 17_400, 59_999, 60_000, 61_234]) {
      const sent = at(-DAY + offset);
      const turns = sent.getTime() + DAY;
      const opens = Math.ceil(turns / MINUTE) * MINUTE;
      for (let ms = turns - 2 * MINUTE; ms <= opens + MINUTE; ms += 7_919) {
        const clock = new Date(ms);
        const label = `${String(offset)} ${clock.toISOString()}`;
        for (const { key, limit, reason } of shared) {
          const sends = Array.from({ length: limit }, (_, index) =>
            index === limit - 1 ? sent : at(-index * SECOND),
          );
          const refusal = sendRefusal(history({ clock, [key]: sends }));
          if (ms >= opens) {
            expect(refusal, label).toBeUndefined();
            continue;
          }
          expect(refusal?.reason, label).toBe(reason);
          const wait = refusal!.retryAfterSeconds * SECOND;
          expect(Math.floor(ms / MINUTE) * MINUTE + wait, label).toBe(opens);
          expect(ms + wait, label).toBeGreaterThanOrEqual(opens);
          expect(ms + wait, label).toBeLessThan(opens + MINUTE);
        }
        for (const { key, limit, reason } of own) {
          const sends = Array.from({ length: limit }, (_, index) =>
            index === limit - 1 ? sent : at(-index * 61 * SECOND),
          );
          const refusal = sendRefusal(history({ clock, [key]: sends }));
          if (ms >= turns) {
            expect(refusal, label).toBeUndefined();
            continue;
          }
          expect(refusal, label).toEqual({
            reason,
            retryAfterSeconds: Math.max(1, Math.ceil((turns - ms) / SECOND)),
          });
        }
      }
    }
  });

  it('counts an account as one of the number’s three only by its own send of the last 24 hours', () => {
    const three = [at(-5 * SECOND), at(-3_600 * SECOND), at(-DAY + 1_800 * SECOND)];
    // Its own send to the number within 24 hours: one of the three, not refused.
    expect(
      sendRefusal(history({ phoneAccounts: three, accountPhone: [at(-DAY + 1)] })),
    ).toBeUndefined();
    // Its own send older than that is no longer: it is a fourth.
    expect(sendRefusal(history({ phoneAccounts: three, accountPhone: [at(-DAY)] }))).toEqual({
      reason: 'phone_accounts',
      retryAfterSeconds: 1_800,
    });
  });

  it('answers the limit that lasts longest when several refuse', () => {
    expect(
      sendRefusal(
        history({
          lastAccountSend: at(-10 * SECOND),
          account: atLimit(10, 20),
          ip: atLimit(50, 600),
          service: atLimit(500, 300),
        }),
      ),
    ).toEqual({ reason: 'ip_daily', retryAfterSeconds: 600 });
    // Compared as answered: the service's 42 seconds are its minute, longer than the account's 50
    // seconds — and on a tie of the answers the account's own limit, first in the order, is told.
    expect(sendRefusal(history({ account: atLimit(10, 50), service: atLimit(500, 42) }))).toEqual({
      reason: 'service_daily',
      retryAfterSeconds: 60,
    });
    expect(sendRefusal(history({ account: atLimit(10, 60), service: atLimit(500, 42) }))).toEqual({
      reason: 'account_daily',
      retryAfterSeconds: 60,
    });
    expect(
      sendRefusal(
        history({
          lastAccountSend: at(-10 * SECOND),
          account: atLimit(10, 20),
        }),
      ),
    ).toEqual({ reason: 'resend_interval', retryAfterSeconds: 50 });
  });
});

describe('confirmWriteRefusal', () => {
  /** A failed insert as drizzle throws it, the driver error in `cause`. */
  const failed = (code: string, constraint?: string) =>
    new DrizzleQueryError(
      'insert into "phone_verifications" ("user_id", "phone") values ($1, $2)',
      ['user-1', '01012345678'],
      Object.assign(new Error('duplicate key value'), { code, constraint }),
    );

  it('answers phone_in_use for the UNIQUE of the number, which a concurrent confirmation hit', () => {
    const refusal = confirmWriteRefusal(failed('23505', PHONE_UNIQUE_CONSTRAINT));
    expect(refusal).toBeInstanceOf(AppError);
    expect({ code: refusal?.code, details: refusal?.details }).toEqual({
      code: 'PHONE_VERIFICATION_NOT_ALLOWED',
      details: { reason: 'phone_in_use' },
    });
  });

  it('leaves every other failure a fault', () => {
    expect(confirmWriteRefusal(failed('23505', 'phone_verifications_pkey'))).toBeUndefined();
    expect(confirmWriteRefusal(failed('23514', PHONE_UNIQUE_CONSTRAINT))).toBeUndefined();
    expect(confirmWriteRefusal(new Error('Connection terminated'))).toBeUndefined();
  });

  it('names the constraint drizzle generates for phone_verifications.phone', () => {
    const phone = getTableConfig(schema.phoneVerifications).columns.find(
      (column) => column.name === 'phone',
    );
    expect(phone?.isUnique).toBe(true);
    expect(phone?.uniqueName).toBe(PHONE_UNIQUE_CONSTRAINT);
  });
});

describe('verificationWriteFailure', () => {
  it('keeps the SQLSTATE and drops every value, message, detail and cause', () => {
    const name = '홍길동';
    const phone = '01012345678';
    // node-postgres quotes the row in `detail` for NOT NULL and CHECK violations.
    const driver = Object.assign(new Error('violates check constraint'), {
      code: '23514',
      detail: `Failing row contains (user-1, ${phone}, ${name}).`,
    });
    const failure = verificationWriteFailure(
      new DrizzleQueryError(
        'insert into "phone_verifications" ("user_id", "phone", "real_name") values ($1, $2, $3)',
        ['user-1', phone, name],
        driver,
      ),
    );
    expect(failure).toBeInstanceOf(AppError);
    expect(failure.code).toBe('INTERNAL');
    expect(failure.message).toBe('The verification write failed (SQLSTATE 23514)');
    expect(failure.cause).toBeUndefined();
    // The shape the filter's `request.log.error({ err })` writes, cause chain included.
    const logged = JSON.stringify(stdSerializers.err(failure));
    expect(logged).not.toContain(name);
    expect(logged).not.toContain(phone);
    expect(verificationWriteFailure(new Error('Connection terminated')).message).toBe(
      'The verification write failed (no SQLSTATE)',
    );
  });
});
