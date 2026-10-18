/**
 * The code's rules (ADR-0069 decision 1 #57-3, ADR-0070) without Postgres: what the drawn codes
 * look like, the keyed hash and its constant-time comparison, expiry, the entries a code takes,
 * the resend interval and the daily limits of the account and the number. Runs everywhere.
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
  mismatchRefusal,
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

describe('sendRefusal', () => {
  const none = { count: 0, oldest: null };
  const history = (overrides: Partial<SendHistory> = {}): SendHistory => ({
    clock: T0,
    lastAccountSend: null,
    account: none,
    phone: none,
    ...overrides,
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

  it('refuses the eleventh send of the account in 24 hours until the oldest leaves the window', () => {
    const oldest = at(-DAY + 90 * SECOND);
    expect(sendRefusal(history({ account: { count: 9, oldest } }))).toBeUndefined();
    expect(sendRefusal(history({ account: { count: 10, oldest } }))).toEqual({
      reason: 'account_daily',
      retryAfterSeconds: 90,
    });
  });

  it('refuses the eleventh send to the number in 24 hours, whichever accounts asked', () => {
    const oldest = at(-DAY + 3_600 * SECOND);
    expect(sendRefusal(history({ phone: { count: 9, oldest } }))).toBeUndefined();
    expect(sendRefusal(history({ phone: { count: 12, oldest } }))).toEqual({
      reason: 'phone_daily',
      retryAfterSeconds: 3_600,
    });
  });

  it('answers the limit that lasts longest when several refuse', () => {
    expect(
      sendRefusal(
        history({
          lastAccountSend: at(-10 * SECOND),
          account: { count: 10, oldest: at(-DAY + 20 * SECOND) },
          phone: { count: 10, oldest: at(-DAY + 600 * SECOND) },
        }),
      ),
    ).toEqual({ reason: 'phone_daily', retryAfterSeconds: 600 });
    expect(
      sendRefusal(
        history({
          lastAccountSend: at(-10 * SECOND),
          account: { count: 10, oldest: at(-DAY + 20 * SECOND) },
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
