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
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
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
  mismatchRefusal,
  pendingCodeRefusal,
  sendRefusal,
  type SendWindow,
} from './phone-verification.rules.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Constraint name drizzle generates for `phone_verifications.phone.unique()`. */
export const PHONE_UNIQUE_CONSTRAINT = 'phone_verifications_phone_unique';

const codes = schema.phoneVerificationCodes;
const verifications = schema.phoneVerifications;
const { codeTtlSeconds, resendIntervalSeconds } = PHONE_VERIFICATION_LIMITS;

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
 * - Sending takes the account's and the number's locks, reads the database clock, refuses by the
 *   fixed limits (rules: 60 s since the account's previous send, ten sends in 24 hours for the
 *   account and for the number), deletes the codes older than the window and records the new
 *   one — all before the provider is asked, so concurrent requests count each other. The text is
 *   sent after that transaction commits (the provider's latency holds no lock). A failed send
 *   answers SMS_SEND_FAILED (502); what happens to its row depends on what the failure says about
 *   the text (ADR-0070 decision 7-3). A send the provider certainly did not take (`refused`) is
 *   deleted again: neither a send the limits count nor a code that can be confirmed. A send whose
 *   outcome is unknown (a timeout, a lost answer: the provider may have texted the code) is kept:
 *   it counts against the limits like any send and its code can be confirmed, so a provider that
 *   answers late can never let a number receive more texts than the limits allow.
 * - The spans answered (`expiresInSeconds`, `resendAfterSeconds`) are counted from the database
 *   clock the row was written with, less the time the provider took, so a browser that starts
 *   counting when the answer arrives never shows a code valid that the server calls expired.
 * - Confirming takes the account's lock and reads the newest code: refused when none waits, when
 *   it is discarded or expired, and on a wrong entry, which is counted (the fifth discards it) in
 *   a transaction that commits before the refusal is answered. A match records the verification
 *   with the number and the real name the code was sent with. One account per number is the
 *   UNIQUE of `phone_verifications.phone`; the read before it only spares the write. Whether the
 *   number is taken is answered after the code matched, so only the number's holder learns it.
 *
 * Neither the number, the real name nor the code reaches a log: every database failure leaves as
 * its SQLSTATE alone (`verificationWriteFailure`), every provider failure as SmsSendError's
 * redacted words, and no refusal's message names them.
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
   * confirmation copies both into the account's record. The caller has checked the body's
   * `expectedAccountId` against `userId` (the controller).
   */
  async requestCode(
    userId: string,
    input: { realName: string; phone: string },
  ): Promise<PhoneVerificationCodeSent> {
    const id = randomUUID();
    const code = drawCode();
    // When the row's clock was read, on this process's monotonic clock: the spans answered are
    // shortened by what passed since (mostly the provider), without comparing two wall clocks.
    let clockReadAt = 0;
    await this.write(async (tx) => {
      await lockAccount(tx, userId);
      await lockPhone(tx, input.phone);
      if (await isPhoneVerified(tx, userId)) {
        throw verificationNotAllowed({ reason: 'already_verified' });
      }
      const clock = await clockTimestamp(tx);
      clockReadAt = performance.now();
      const since = dayWindowStart(clock);
      // Only the window counts; anything older is personal data with no use left.
      await tx.delete(codes).where(lt(codes.sentAt, since));
      const [last] = await tx
        .select({ sentAt: codes.sentAt })
        .from(codes)
        .where(eq(codes.userId, userId))
        .orderBy(desc(codes.sentAt), desc(codes.id))
        .limit(1);
      const refusal = sendRefusal({
        clock,
        lastAccountSend: last?.sentAt ?? null,
        account: await sendWindow(tx, and(eq(codes.userId, userId), gt(codes.sentAt, since))),
        phone: await sendWindow(tx, and(eq(codes.phone, input.phone), gt(codes.sentAt, since))),
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
      });
    });

    try {
      await this.sms.sendVerificationCode({
        to: input.phone,
        code,
        expiresInMinutes: codeTtlSeconds / 60,
      });
    } catch (error) {
      const outcome = sendOutcome(error);
      if (outcome === 'refused') {
        // Certainly not a send: it neither counts against the limits nor can be confirmed.
        // Should this delete fail too, the row only counts until it ages out; nobody holds its
        // code.
        await this.db
          .delete(codes)
          .where(eq(codes.id, id))
          .catch(() => undefined);
      }
      // An unknown outcome keeps its row: the phone may hold this code, and the limits count it.
      throw new AppError('SMS_SEND_FAILED', {
        message: `The verification code ${
          outcome === 'refused' ? 'was not sent' : 'may have been sent (kept and counted)'
        }: ${redactDigits(error instanceof Error ? error.message : String(error))}`,
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
   * counted before the refusal leaves.
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

/** Serialises the sends to one number, whichever accounts ask: its daily count stays exact. */
async function lockPhone(tx: Tx, phone: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('buddha:phone-verification:phone'), hashtext(${phone}))`,
  );
}

/** How many codes `where` selects, and the oldest one's send. */
async function sendWindow(tx: Tx, where: ReturnType<typeof and>): Promise<SendWindow> {
  const [row] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      // Read through the column's own decoder, as a selected `sent_at` would be.
      oldest: sql<Date | null>`min(${codes.sentAt})`.mapWith(codes.sentAt),
    })
    .from(codes)
    .where(where);
  return { count: row?.count ?? 0, oldest: row?.oldest ?? null };
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
