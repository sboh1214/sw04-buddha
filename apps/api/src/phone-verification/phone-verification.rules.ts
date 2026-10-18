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

const {
  codeLength,
  codeTtlSeconds,
  resendIntervalSeconds,
  maxAttempts,
  accountDailySends,
  accountPhoneDailySends,
  phoneDailyAccounts,
  ipDailySends,
  serviceDailySends,
} = PHONE_VERIFICATION_LIMITS;
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

/**
 * What the daily limits read, each as the sends (or, for the number's accounts, each account's
 * newest send) of the 24 hours before `clock`, NEWEST FIRST. A list may stop at its limit: only
 * whether it reaches the limit, and the send at the limit, matter.
 */
export interface SendHistory {
  /** The database clock of this request, read after its locks. */
  clock: Date;
  /** The account's newest send, whatever the number or its age; null when it has none. */
  lastAccountSend: Date | null;
  /** The account's sends, whatever the numbers. */
  account: readonly Date[];
  /** The account's sends to the number of this request. */
  accountPhone: readonly Date[];
  /** The newest send of each OTHER account to the number of this request. */
  phoneAccounts: readonly Date[];
  /**
   * The sends from the client address of this request, or null when the request names no client
   * (loopback, a proxy whose forwarding is not trusted: the per-address rate limit's rule), which
   * no per-address limit can count.
   */
  ip: readonly Date[] | null;
  /** The service's sends. */
  service: readonly Date[];
}

/**
 * The refusal of a window that holds `limit` sends or more, or undefined. Newest first, so the
 * send at the limit is `sends[limit - 1]`: once it leaves the window, fewer than `limit` remain
 * and the same request passes (unless more are sent meanwhile).
 */
function windowRefusal(
  reason: PhoneVerificationLimitedDetails['reason'],
  sends: readonly Date[],
  limit: number,
  clock: Date,
): PhoneVerificationLimitedDetails | undefined {
  const atLimit = sends[limit - 1];
  if (atLimit === undefined) return undefined;
  return { reason, retryAfterSeconds: secondsUntil(atLimit.getTime() + DAY_MS, clock) };
}

/**
 * Whether a send may go now, or which limit refuses it (#57-3, owner decisions 2026-10-18): sixty
 * seconds since the account's previous send, and in 24 hours ten sends for the account, ten for
 * the account at this number, three accounts at this number (an account that has sent to it in
 * the window is one of them and passes), twenty from the client address (when the request names
 * one) and five hundred for the service. When several refuse, the one that lasts longest is
 * answered — the first of them in that order on a tie — so `retryAfterSeconds` is when the same
 * request would pass all of them, as far as this request can know (others may send meanwhile).
 */
export function sendRefusal(history: SendHistory): PhoneVerificationLimitedDetails | undefined {
  const { clock } = history;
  const refusals: (PhoneVerificationLimitedDetails | undefined)[] = [];
  if (history.lastAccountSend !== null) {
    const next = history.lastAccountSend.getTime() + resendIntervalSeconds * 1_000;
    if (next > clock.getTime()) {
      refusals.push({ reason: 'resend_interval', retryAfterSeconds: secondsUntil(next, clock) });
    }
  }
  refusals.push(
    windowRefusal('account_daily', history.account, accountDailySends, clock),
    windowRefusal('account_phone_daily', history.accountPhone, accountPhoneDailySends, clock),
    history.accountPhone.length === 0
      ? windowRefusal('phone_accounts', history.phoneAccounts, phoneDailyAccounts, clock)
      : undefined,
    history.ip === null ? undefined : windowRefusal('ip_daily', history.ip, ipDailySends, clock),
    windowRefusal('service_daily', history.service, serviceDailySends, clock),
  );
  return refusals.reduce<PhoneVerificationLimitedDetails | undefined>(
    (longest, refusal) =>
      refusal !== undefined &&
      (longest === undefined || refusal.retryAfterSeconds > longest.retryAfterSeconds)
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
 * How many of the account's codes before the newest a wrong entry is compared with, newest first
 * (`matchesOlderCode`): a day's sends less the newest. Every code of the last 24 hours is among
 * them — the account sends at most ten in any 24 hours — and so is the text just before a resend
 * however long ago it came, while the comparison stays bounded however long the record grows.
 */
export const OLDER_CODES_COMPARED = accountDailySends - 1;

/** One of the account's older codes, as a confirmation reads it. */
export interface OlderCode {
  id: string;
  codeHash: string;
}

/**
 * Whether `code`, which did not match the account's newest code, is one of its `older` codes —
 * sent before the newest, which replaced it. Such an entry is answered `superseded` and spends no
 * entry of the newest code (owner decision 2026-10-18, ADR-0070): the member typed the text that
 * came first, not a guess. Every older code is compared, each in constant time, without stopping
 * at the first match.
 */
export function matchesOlderCode(key: Buffer, code: string, older: readonly OlderCode[]): boolean {
  return older.reduce(
    (matched, row) => codeMatches(key, row.id, code, row.codeHash) || matched,
    false,
  );
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
