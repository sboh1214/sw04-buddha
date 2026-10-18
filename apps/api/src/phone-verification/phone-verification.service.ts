import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isPhoneVerified, schema, type Db } from '@buddha/db';
import {
  PHONE_VERIFICATION_LIMITS,
  type PhoneVerification,
  type PhoneVerificationCodeSent,
  type PhoneVerificationLimitedDetails,
  type PhoneVerificationNotAllowedDetails,
  type VerificationCodeRejectedDetails,
} from '@buddha/shared';
import { and, desc, eq, gt, ne, sql, type SQL } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { findPgError, isPgError, PG_UNIQUE_VIOLATION } from '../common/errors/pg-error.js';
import { type Env } from '../config/env.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { redactDigits, SMS_SENDER, type SmsSender, sendOutcome } from '../sms/sms-sender.js';
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
} from './phone-verification.rules.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Constraint name drizzle generates for `phone_verifications.phone.unique()`. */
export const PHONE_UNIQUE_CONSTRAINT = 'phone_verifications_phone_unique';

const codes = schema.phoneVerificationCodes;
const verifications = schema.phoneVerifications;
const {
  codeTtlSeconds,
  resendIntervalSeconds,
  accountDailySends,
  accountPhoneDailySends,
  phoneDailyAccounts,
  ipDailySends,
  serviceDailySends,
} = PHONE_VERIFICATION_LIMITS;

export function verificationNotAllowed(details: PhoneVerificationNotAllowedDetails): AppError {
  const messages = {
    already_verified: 'The account has completed the verification already',
    phone_in_use: "The number is another account's verified number",
  } as const satisfies Record<PhoneVerificationNotAllowedDetails['reason'], string>;
  return new AppError('PHONE_VERIFICATION_NOT_ALLOWED', {
    message: messages[details.reason],
    details,
  });
}

export function verificationLimited(details: PhoneVerificationLimitedDetails): AppError {
  return new AppError('PHONE_VERIFICATION_LIMITED', {
    message: `No code was sent: ${details.reason} (retry after ${String(details.retryAfterSeconds)} s)`,
    details,
  });
}

/**
 * The one failure of a confirmation's write that is an answer rather than a fault: another
 * account's confirmation of the same number committed between the read that found the number
 * free and this insert, and the UNIQUE of `phone_verifications.phone` refused it — `phone_in_use`,
 * as the read would have said. Anything else is undefined (a fault, `verificationWriteFailure`).
 */
export function confirmWriteRefusal(error: unknown): AppError | undefined {
  return isPgError(error, PG_UNIQUE_VIOLATION, PHONE_UNIQUE_CONSTRAINT)
    ? verificationNotAllowed({ reason: 'phone_in_use' })
    : undefined;
}

export function codeRejected(details: VerificationCodeRejectedDetails): AppError {
  return new AppError('VERIFICATION_CODE_REJECTED', {
    message: `The code verifies nothing: ${details.reason}`,
    details,
  });
}

/**
 * 본인확인 (#183, ADR-0069 decision 1 #57-1·#57-3, ADR-0070): an SMS code to the number the
 * account names, its confirmation, and the record it leaves (`phone_verifications`). The one place
 * a record is written is a confirmation that matched the newest code sent for the account, so
 * nothing outside the code — a request that skips the screen included — can verify an account.
 *
 * - Sending takes the account's lock and the service's send lock, reads the database clock,
 *   refuses by the fixed limits (rules: 60 s since the account's previous send; in 24 hours ten
 *   sends for the account and for the account at the number, three accounts at the number, twenty
 *   from the client address, five hundred for the service) and records the new send — all before
 *   the provider is asked, so concurrent requests count each other. The text is sent after that
 *   transaction commits (the provider's latency holds no lock). What a failed send leaves depends
 *   on what the failure says about the text (ADR-0070). A send the provider certainly did not take
 *   (`refused`) is deleted again — neither a send the limits count nor a code that can be
 *   confirmed — and answered SMS_SEND_FAILED. A send whose outcome is unknown (a timeout, a lost
 *   answer: the provider may have texted the code) is kept: it counts against the limits like any
 *   send and its code can be confirmed, and it is answered SMS_SEND_UNCONFIRMED, so the screen can
 *   say the text may have come. A provider that answers late can never let a phone receive more
 *   texts than the limits allow.
 * - The rows are never purged here: each is the account's 본인확인 기록 (owner decision
 *   2026-10-18), which #184's retention job deletes after the account's withdrawal. The limits
 *   read the window through their indexes, so the rows outside it cost nothing.
 * - The spans answered (`expiresInSeconds`, `resendAfterSeconds`) are counted from the database
 *   clock the row was written with, less the time the provider took, so a browser that starts
 *   counting when the answer arrives never shows a code valid that the server calls expired.
 * - Confirming takes the account's lock and reads the newest code: refused when none waits, when
 *   it is discarded or expired, and on a wrong entry. A wrong entry that is one of the account's
 *   older codes — the text before a resend, however old, among the nine codes before the newest
 *   (`OLDER_CODES_COMPARED`); never another account's — is answered `superseded` and not
 *   counted; any other is counted (the fifth discards the code) in a transaction that commits
 *   before the refusal is answered. A match records the verification with the number and the real
 *   name the code was sent with. One account per number is the UNIQUE of
 *   `phone_verifications.phone`; the read before it only spares the write. Whether the number is
 *   taken is answered after the code matched, so only the number's holder learns it.
 *
 * Neither the number, the real name, the address nor the code reaches a log: every database
 * failure leaves as its SQLSTATE alone (`verificationWriteFailure`), every provider failure as
 * SmsSendError's redacted words, and no refusal's message names them.
 */
@Injectable()
export class PhoneVerificationService {
  private readonly codeKey: Buffer;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    config: ConfigService<Env, true>,
  ) {
    const secret = config.get('BETTER_AUTH_SECRET', { infer: true });
    // The env schema requires it outside NODE_ENV=test and createAuth refuses to start without it.
    if (!secret) throw new Error('BETTER_AUTH_SECRET is required to hash verification codes');
    this.codeKey = deriveCodeKey(secret);
  }

  /** Whether the account has completed the verification: `isPhoneVerified` (@buddha/db). */
  isVerified(userId: string): Promise<boolean> {
    return isPhoneVerified(this.db, userId);
  }

  /**
   * Texts a new code to `phone` for `userId`, with `realName` kept beside it until a
   * confirmation copies both into the account's record. `clientIp` is the address the request
   * names (`clientAddress`, rate-limit.tracker.ts), or null when it names no client; the send
   * records it and the per-address limit counts it. The caller has checked the body's
   * `expectedAccountId` against `userId` (the controller).
   */
  async requestCode(
    userId: string,
    input: { realName: string; phone: string },
    clientIp: string | null,
  ): Promise<PhoneVerificationCodeSent> {
    const id = randomUUID();
    const code = drawCode();
    // When the row's clock was read, on this process's monotonic clock: the spans answered are
    // shortened by what passed since (mostly the provider), without comparing two wall clocks.
    let clockReadAt = 0;
    await this.write(async (tx) => {
      await lockAccount(tx, userId);
      await lockSends(tx);
      if (await isPhoneVerified(tx, userId)) {
        throw verificationNotAllowed({ reason: 'already_verified' });
      }
      const clock = await clockTimestamp(tx);
      clockReadAt = performance.now();
      const window = gt(codes.sentAt, dayWindowStart(clock));
      const [last] = await tx
        .select({ sentAt: codes.sentAt })
        .from(codes)
        .where(eq(codes.userId, userId))
        .orderBy(desc(codes.sentAt), desc(codes.id))
        .limit(1);
      const refusal = sendRefusal({
        clock,
        lastAccountSend: last?.sentAt ?? null,
        account: await recentSends(tx, and(eq(codes.userId, userId), window), accountDailySends),
        accountPhone: await recentSends(
          tx,
          and(eq(codes.userId, userId), eq(codes.phone, input.phone), window),
          accountPhoneDailySends,
        ),
        phoneAccounts: await recentAccounts(tx, input.phone, userId, window),
        ip:
          clientIp === null
            ? null
            : await recentSends(tx, and(eq(codes.clientIp, clientIp), window), ipDailySends),
        service: await recentSends(tx, window, serviceDailySends),
      });
      if (refusal) throw verificationLimited(refusal);
      await tx.insert(codes).values({
        id,
        userId,
        phone: input.phone,
        realName: input.realName,
        codeHash: hashCode(this.codeKey, id, code),
        sentAt: clock,
        expiresAt: expiryOf(clock),
        clientIp,
      });
    });

    try {
      await this.sms.sendVerificationCode({
        to: input.phone,
        code,
        expiresInMinutes: codeTtlSeconds / 60,
      });
    } catch (error) {
      const reason = redactDigits(error instanceof Error ? error.message : String(error));
      if (sendOutcome(error) === 'refused') {
        // Certainly not a send: it neither counts against the limits nor can be confirmed.
        // Should this delete fail too, the row stays and counts until it leaves the window;
        // nobody holds its code.
        await this.db
          .delete(codes)
          .where(eq(codes.id, id))
          .catch(() => undefined);
        throw new AppError('SMS_SEND_FAILED', {
          message: `The verification code was not sent: ${reason}`,
        });
      }
      // An unknown outcome keeps its row: the phone may hold this code, and the limits count it.
      throw new AppError('SMS_SEND_UNCONFIRMED', {
        message: `The verification code may have been sent (kept and counted): ${reason}`,
      });
    }
    const spent = (performance.now() - clockReadAt) / 1_000;
    return {
      // Down for the validity, up for the wait: the screen never promises more time than the
      // code has, nor a resend sooner than the server allows.
      expiresInSeconds: Math.max(0, Math.floor(codeTtlSeconds - spent)),
      resendAfterSeconds: Math.max(0, Math.ceil(resendIntervalSeconds - spent)),
    };
  }

  /**
   * Confirms the account's newest code with `code`: records the verification and answers it, or
   * refuses (VERIFICATION_CODE_REJECTED, PHONE_VERIFICATION_NOT_ALLOWED). A wrong entry is
   * counted before the refusal leaves, unless it is one of the account's older codes.
   */
  async confirm(userId: string, code: string): Promise<PhoneVerification> {
    const outcome = await this.write(
      async (tx): Promise<{ verified: PhoneVerification } | { refused: AppError }> => {
        await lockAccount(tx, userId);
        if (await isPhoneVerified(tx, userId)) {
          return { refused: verificationNotAllowed({ reason: 'already_verified' }) };
        }
        const clock = await clockTimestamp(tx);
        const [pending] = await tx
          .select()
          .from(codes)
          .where(eq(codes.userId, userId))
          .orderBy(desc(codes.sentAt), desc(codes.id))
          .limit(1);
        const refusal = pendingCodeRefusal(pending, clock);
        if (refusal || pending === undefined) {
          return { refused: codeRejected(refusal ?? { reason: 'no_code' }) };
        }
        if (!codeMatches(this.codeKey, pending.id, code, pending.codeHash)) {
          // The text before a resend, typed after it: refused without spending an entry of the
          // newest code (owner decision 2026-10-18), however long ago it came. The account's own
          // codes before the newest — never another account's — newest first, as many as
          // OLDER_CODES_COMPARED (every code of the last 24 hours, and older ones beyond it).
          const older = await tx
            .select({ id: codes.id, codeHash: codes.codeHash })
            .from(codes)
            .where(and(eq(codes.userId, userId), ne(codes.id, pending.id)))
            .orderBy(desc(codes.sentAt), desc(codes.id))
            .limit(OLDER_CODES_COMPARED);
          if (matchesOlderCode(this.codeKey, code, older)) {
            return { refused: codeRejected({ reason: 'superseded' }) };
          }
          const attempts = pending.attempts + 1;
          await tx.update(codes).set({ attempts }).where(eq(codes.id, pending.id));
          // Returned, not thrown: the counted entry must commit with the refusal.
          return { refused: codeRejected(mismatchRefusal(attempts)) };
        }
        const [taken] = await tx
          .select({ userId: verifications.userId })
          .from(verifications)
          .where(eq(verifications.phone, pending.phone))
          .limit(1);
        if (taken) return { refused: verificationNotAllowed({ reason: 'phone_in_use' }) };
        await tx.update(codes).set({ consumedAt: clock }).where(eq(codes.id, pending.id));
        const [row] = await tx
          .insert(verifications)
          .values({
            userId,
            phone: pending.phone,
            realName: pending.realName,
            verifiedAt: clock,
            updatedAt: clock,
          })
          .returning();
        if (!row) {
          throw new AppError('INTERNAL', { message: 'Verification insert returned no row' });
        }
        return { verified: toPhoneVerification(row) };
      },
      // Another account confirmed the same number between the read above and this insert.
      confirmWriteRefusal,
    );
    if ('refused' in outcome) throw outcome.refused;
    return outcome.verified;
  }

  /**
   * MY 설정's real-name change (#57-3): the record's name alone; the number stays. Before the
   * account has verified there is no record to change (VERIFICATION_REQUIRED): the name is given
   * with the number on the verification step.
   */
  async updateRealName(userId: string, realName: string): Promise<PhoneVerification> {
    const [row] = await this.write((tx) =>
      tx
        .update(verifications)
        .set({ realName, updatedAt: sql`now()` })
        .where(eq(verifications.userId, userId))
        .returning(),
    );
    if (!row) {
      throw new AppError('VERIFICATION_REQUIRED', {
        message: 'The account has not completed the verification',
      });
    }
    return toPhoneVerification(row);
  }

  /**
   * A transaction whose failures leave without the values it wrote: an AppError as thrown,
   * `known(error)` when it names one, and anything else as `verificationWriteFailure`.
   */
  private async write<T>(
    work: (tx: Tx) => Promise<T>,
    known: (error: unknown) => AppError | undefined = () => undefined,
  ): Promise<T> {
    try {
      return await this.db.transaction(work);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw known(error) ?? verificationWriteFailure(error);
    }
  }
}

function toPhoneVerification(row: typeof verifications.$inferSelect): PhoneVerification {
  return { realName: row.realName, phone: row.phone, verifiedAt: row.verifiedAt.toISOString() };
}

/**
 * Serialises an account's sends and confirmations: two requests of one account cannot both pass
 * the resend interval, and the newest code cannot change while it is confirmed. The two-key form
 * keeps these keys apart from every single-key advisory lock (markets, admin roles).
 */
async function lockAccount(tx: Tx, userId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('buddha:phone-verification:account'), hashtext(${userId}))`,
  );
}

/**
 * Serialises every send of the service, whichever account, number or address asks: the counts of
 * a number's accounts, of an address and of the whole service stay exact, as the account lock
 * keeps the account's. Held only for the counting and the insert — never while the provider is
 * asked — and the service sends at most five hundred codes a day, so nothing waits on it long.
 * Taken after the account's lock, as every send takes both: no two sends wait on each other in
 * opposite orders, and a confirmation takes the account's alone.
 */
async function lockSends(tx: Tx): Promise<void> {
  // The two-key form, as lockAccount: apart from every single-key advisory lock.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('buddha:phone-verification:sends'), 0)`,
  );
}

/**
 * The sends `where` selects, newest first, at most `limit` of them: whether a daily limit is
 * reached, and the send at the limit, are all `sendRefusal` reads. Each `where` names the window
 * and the columns of one of the indexes (account, number, address, or the send time alone), so
 * the rows outside the window — kept as 본인확인 기록 — are never read.
 */
async function recentSends(tx: Tx, where: SQL | undefined, limit: number): Promise<Date[]> {
  const rows = await tx
    .select({ sentAt: codes.sentAt })
    .from(codes)
    .where(where)
    .orderBy(desc(codes.sentAt))
    .limit(limit);
  return rows.map((row) => row.sentAt);
}

/**
 * The newest send of each account other than `userId` to `phone` within `window`, newest first,
 * at most as many as a number may receive codes for: whether the number's accounts are reached
 * for an account that has not sent to it, and when the one at the limit leaves the window.
 */
async function recentAccounts(tx: Tx, phone: string, userId: string, window: SQL): Promise<Date[]> {
  // Read through the column's own decoder, as a selected `sent_at` would be.
  const newest = sql<Date>`max(${codes.sentAt})`.mapWith(codes.sentAt);
  const rows = await tx
    .select({ newest })
    .from(codes)
    .where(and(eq(codes.phone, phone), ne(codes.userId, userId), window))
    .groupBy(codes.userId)
    .orderBy(desc(newest))
    .limit(phoneDailyAccounts);
  return rows.map((row) => row.newest);
}

/**
 * A failed verification write with the personal data taken out. ApiExceptionFilter logs a 5xx
 * with its whole cause chain, and drizzle's `DrizzleQueryError` carries the bound parameters (a
 * number, a real name, a code's hash) in its message and `params`, while a node-postgres error can
 * quote the row in `detail`. Only the SQLSTATE is kept, and the original is dropped rather than
 * attached as `cause` — as ADR-0043 did for the contact it replaced.
 */
export function verificationWriteFailure(error: unknown): AppError {
  const pg = findPgError(error);
  return new AppError('INTERNAL', {
    message: `The verification write failed (${pg ? `SQLSTATE ${pg.code}` : 'no SQLSTATE'})`,
  });
}
