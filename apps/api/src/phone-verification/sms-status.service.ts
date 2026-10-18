import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { PHONE_VERIFICATION_LIMITS, SMS_STATUS_DAYS, type AdminSmsStatus } from '@buddha/shared';
import { count, gt, gte, sql } from 'drizzle-orm';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { dayWindowStart } from './phone-verification.rules.js';

const codes = schema.phoneVerificationCodes;
const refusedSends = schema.phoneVerificationRefusedSends;

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Korea Standard Time is UTC+9 all year (no daylight saving since 1988). */
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

/**
 * The Korean calendar date of `ms` (epoch), `YYYY-MM-DD`. Exported for its unit test
 * (sms-status.service.test.ts), which pins the offset with fixed instants whatever the hour.
 */
export function kstDate(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The start (epoch ms) of the Korean calendar day `ms` falls in. Exported as `kstDate` is. */
export function kstDayStart(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
}

/**
 * The admin's SMS send status (owner decision 2026-10-18, second round, ADR-0070): how many
 * 본인확인 texts went out, how many the provider never answered for, and how many it refused —
 * over the 24 hours of the service's daily limit and over the last seven Korean calendar days.
 * Counts only, read in one snapshot at one database clock: the sends from
 * `phone_verification_codes` (every recorded send, the ones the limits count, `send_outcome`
 * saying which the provider took) and the refusals from `phone_verification_refused_sends` (their
 * time alone). Nothing it answers names an account, a number, a name or an address. Read-only, so
 * no `admin_actions` row.
 */
@Injectable()
export class SmsStatusService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async status(): Promise<AdminSmsStatus> {
    // One snapshot for the four counts: a refused send leaves the sends and joins the refusals in
    // one transaction, so it is counted in exactly one of them.
    const read = await this.db.transaction(
      async (tx) => {
        const clock = await clockTimestamp(tx);
        // The window the service's daily limit counts in (`service_daily`), to the millisecond.
        const window = dayWindowStart(clock);
        const today = kstDayStart(clock.getTime());
        const firstDay = new Date(today - (SMS_STATUS_DAYS - 1) * DAY_MS);
        // The Korean date of a row, grouped in the database (Asia/Seoul, as admin screens read).
        const sentDate = sql<string>`to_char(${codes.sentAt} AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;
        const refusedDate = sql<string>`to_char(${refusedSends.attemptedAt} AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;
        const unknown =
          sql<number>`count(*) FILTER (WHERE ${codes.sendOutcome} = 'unknown')`.mapWith(Number);
        const [last24] = await tx
          .select({ sent: count(), unknown })
          .from(codes)
          .where(gt(codes.sentAt, window));
        const [refused24] = await tx
          .select({ refused: count() })
          .from(refusedSends)
          .where(gt(refusedSends.attemptedAt, window));
        const sendDays = await tx
          .select({ date: sentDate, sent: count(), unknown })
          .from(codes)
          .where(gte(codes.sentAt, firstDay))
          .groupBy(sentDate);
        const refusedDays = await tx
          .select({ date: refusedDate, refused: count() })
          .from(refusedSends)
          .where(gte(refusedSends.attemptedAt, firstDay))
          .groupBy(refusedDate);
        return { clock, today, last24, refused24, sendDays, refusedDays };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const { clock, today, last24, refused24, sendDays, refusedDays } = read;

    const sendsOn = new Map(sendDays.map((row) => [row.date, row]));
    const refusedOn = new Map(refusedDays.map((row) => [row.date, row.refused]));
    return {
      asOf: clock.toISOString(),
      last24Hours: {
        sent: last24?.sent ?? 0,
        unknown: last24?.unknown ?? 0,
        refused: refused24?.refused ?? 0,
        serviceLimit: PHONE_VERIFICATION_LIMITS.serviceDailySends,
      },
      // Newest first: today (so far), then the six days before it, a day with nothing as zeros.
      days: Array.from({ length: SMS_STATUS_DAYS }, (_, back) => {
        const date = kstDate(today - back * DAY_MS);
        const sends = sendsOn.get(date);
        return {
          date,
          sent: sends?.sent ?? 0,
          unknown: sends?.unknown ?? 0,
          refused: refusedOn.get(date) ?? 0,
        };
      }),
    };
  }
}
