import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  PHONE_VERIFICATION_LIMITS,
  type PhoneVerificationLimitedDetails,
  type VerificationCodeRejectedDetails,
} from '@buddha/shared';

/**
 * The rules of the SMS code (#183, ADR-0069 decision 1 #57-3, ADR-0070) as pure functions of
 * what the database holds and the database clock, so the unit tests can walk every edge without
 * Postgres. PhoneVerificationService reads the rows under its locks and applies these.
 */

const { codeLength, codeTtlSeconds, resendIntervalSeconds, maxAttempts, dailySends } =
  PHONE_VERIFICATION_LIMITS;
const DAY_MS = PHONE_VERIFICATION_LIMITS.dailyWindowSeconds * 1_000;

/** Six digits from the CSPRNG, leading zeros kept: every one of the 10^6 codes equally likely. */
export function drawCode(draw: (max: number) => number = (max) => randomInt(max)): string {
  return String(draw(10 ** codeLength)).padStart(codeLength, '0');
}

/**
 * The key codes are hashed under: an HMAC of a fixed label under the server's secret
 * (BETTER_AUTH_SECRET), so it is the secret's own and used for nothing else.
 */
export function deriveCodeKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('buddha:phone-verification-code').digest();
}

/**
 * What `phone_verification_codes.code_hash` holds: HMAC-SHA256 of the code bound to its row's
 * id, lower-case hex. Without the key a stolen row does not give the code away to a million
 * guesses, and the same code in two rows has two hashes.
 */
export function hashCode(key: Buffer, rowId: string, code: string): string {
  return createHmac('sha256', key).update(`${rowId}:${code}`).digest('hex');
}

/**
 * Whether `code` is the one hashed into `storedHash`, compared in constant time
 * (`timingSafeEqual` over the two digests), so the time a wrong guess takes says nothing about
 * how close it was. A stored value that is not a digest of the right length matches nothing.
 */
export function codeMatches(key: Buffer, rowId: string, code: string, storedHash: string): boolean {
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(hashCode(key, rowId, code), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** When a code sent at `sentAt` stops being valid. */
export function expiryOf(sentAt: Date): Date {
  return new Date(sentAt.getTime() + codeTtlSeconds * 1_000);
}

/** The start of the 24-hour window the daily limits count in, ending at `clock`. */
export function dayWindowStart(clock: Date): Date {
  return new Date(clock.getTime() - DAY_MS);
}

/** Whole seconds from `clock` to `at`, at least one: what a client waits before asking again. */
function secondsUntil(at: number, clock: Date): number {
  return Math.max(1, Math.ceil((at - clock.getTime()) / 1_000));
}

/** The sends one limit counts: how many in the window, and the oldest of them. */
export interface SendWindow {
  count: number;
  oldest: Date | null;
}

export interface SendHistory {
  /** The database clock of this request, read after its locks. */
  clock: Date;
  /** The account's newest send, whatever the number; null when it has none. */
  lastAccountSend: Date | null;
  /** The account's sends since `dayWindowStart(clock)`. */
  account: SendWindow;
  /** The number's sends since `dayWindowStart(clock)`, whichever accounts asked. */
  phone: SendWindow;
}

/**
 * Whether a send may go now, or which limit refuses it (#57-3): sixty seconds since the account's
 * previous send, and ten sends in 24 hours for the account and for the number. When several
 * refuse, the one that lasts longest is answered, so `retryAfterSeconds` is when the same request
 * would pass all of them (as far as this account can know: other accounts may text the number
 * meanwhile).
 */
export function sendRefusal(history: SendHistory): PhoneVerificationLimitedDetails | undefined {
  const { clock } = history;
  const refusals: PhoneVerificationLimitedDetails[] = [];
  if (history.lastAccountSend !== null) {
    const next = history.lastAccountSend.getTime() + resendIntervalSeconds * 1_000;
    if (next > clock.getTime()) {
      refusals.push({ reason: 'resend_interval', retryAfterSeconds: secondsUntil(next, clock) });
    }
  }
  for (const [reason, window] of [
    ['account_daily', history.account],
    ['phone_daily', history.phone],
  ] as const) {
    if (window.count >= dailySends && window.oldest !== null) {
      const next = window.oldest.getTime() + DAY_MS;
      refusals.push({ reason, retryAfterSeconds: secondsUntil(next, clock) });
    }
  }
  return refusals.reduce<PhoneVerificationLimitedDetails | undefined>(
    (longest, refusal) =>
      longest === undefined || refusal.retryAfterSeconds > longest.retryAfterSeconds
        ? refusal
        : longest,
    undefined,
  );
}

/** The account's newest code, as a confirmation reads it. */
export interface PendingCode {
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
}

/**
 * Why the newest code cannot be confirmed whatever is typed, or undefined when it can be: none
 * waits (never sent, or already used), it took its fifth wrong entry and is discarded, or its
 * three minutes are over. Checked before the code is compared, so neither a discarded nor an
 * expired code spends an entry or answers whether a guess was right.
 */
export function pendingCodeRefusal(
  code: PendingCode | undefined,
  clock: Date,
): VerificationCodeRejectedDetails | undefined {
  if (code === undefined || code.consumedAt !== null) return { reason: 'no_code' };
  if (code.attempts >= maxAttempts) return { reason: 'attempts_exceeded' };
  if (clock.getTime() >= code.expiresAt.getTime()) return { reason: 'expired' };
  return undefined;
}

/**
 * The answer to a wrong entry, given the entries the code has taken with it: the entries left,
 * or `attempts_exceeded` on the fifth — the code is discarded and a new one must be requested.
 */
export function mismatchRefusal(attempts: number): VerificationCodeRejectedDetails {
  return attempts >= maxAttempts
    ? { reason: 'attempts_exceeded' }
    : { reason: 'mismatch', remainingAttempts: maxAttempts - attempts };
}
