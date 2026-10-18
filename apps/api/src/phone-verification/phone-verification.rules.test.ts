/**
 * The code's rules (ADR-0069 decision 1 #57-3, ADR-0070) without Postgres: what the drawn codes
 * look like, the keyed hash and its constant-time comparison, expiry, the entries a code takes,
 * an older code recognised, the resend interval and the daily limits of the account, the account
 * at a number, the accounts at a number, the client address and the service. Runs everywhere.
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

describe('expiry and the window', () => {
  it('ends a code three minutes after its send and counts the 24 hours before now', () => {
    expect(expiryOf(T0)).toEqual(at(PHONE_VERIFICATION_LIMITS.codeTtlSeconds * SECOND));
    expect(expiryOf(T0)).toEqual(at(180 * SECOND));
    expect(dayWindowStart(T0)).toEqual(at(-DAY));
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
      ipDailySends: 20,
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
    // Three other accounts: refused until the third newest of them leaves the window.
    const three = [at(-5 * SECOND), at(-3_600 * SECOND), at(-DAY + 1_800 * SECOND)];
    expect(sendRefusal(history({ phoneAccounts: three }))).toEqual({
      reason: 'phone_accounts',
      retryAfterSeconds: 1_800,
    });
    // An account that has itself sent to the number in the window is one of the three.
    expect(
      sendRefusal(history({ phoneAccounts: three, accountPhone: [at(-120 * SECOND)] })),
    ).toBeUndefined();
  });

  it('refuses the twenty-first send from one client address, and counts none for no address', () => {
    expect(sendRefusal(history({ ip: sends(19, 2 * 60 * SECOND) }))).toBeUndefined();
    expect(sendRefusal(history({ ip: atLimit(20, 300) }))).toEqual({
      reason: 'ip_daily',
      retryAfterSeconds: 300,
    });
    // A request that names no client (loopback, the web's rewrite) is not counted by address.
    expect(sendRefusal(history({ ip: null }))).toBeUndefined();
  });

  it('refuses the service’s five hundred and first send in 24 hours', () => {
    expect(sendRefusal(history({ service: sends(499, 2 * 60 * SECOND) }))).toBeUndefined();
    expect(sendRefusal(history({ service: atLimit(500, 42) }))).toEqual({
      reason: 'service_daily',
      retryAfterSeconds: 42,
    });
  });

  it('answers the limit that lasts longest when several refuse', () => {
    expect(
      sendRefusal(
        history({
          lastAccountSend: at(-10 * SECOND),
          account: atLimit(10, 20),
          ip: atLimit(20, 600),
          service: atLimit(500, 300),
        }),
      ),
    ).toEqual({ reason: 'ip_daily', retryAfterSeconds: 600 });
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
