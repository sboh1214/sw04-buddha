/**
 * SMS 발송 현황 over HTTP (#183, owner decision 2026-10-18, second round, ADR-0070), against the
 * docker `test` profile with the in-memory SMS sender: an admin reads the counts of the 본인확인
 * texts — sent against the service's daily 500, never answered for, refused — over the 24 hours
 * of the service's limit and per Korean calendar day for seven days, the days split at midnight in
 * Seoul; a member and a visitor read nothing (admin-access.test.ts checks the guards of every
 * /admin route as well). The day's arithmetic alone is sms-status.service.test.ts's.
 */
import { randomUUID } from 'node:crypto';
import { schema } from '@buddha/db';
import { createUser } from '@buddha/db/test';
import { adminSmsStatusSchema, errorEnvelopeSchema, type AdminSmsStatus } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const ORIGIN = 'http://localhost:3000';
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const URL = '/api/v1/admin/sms/status';

/** The Korean calendar date of `ms`, by Intl rather than by the service's own arithmetic. */
const kstDate = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(ms));

/** Midnight in Seoul starting the Korean day of `ms` (epoch), by Intl as `kstDate` is. */
const kstMidnight = (ms: number) => Date.parse(`${kstDate(ms)}T00:00:00+09:00`);

const MINUTE_MS = 60_000;

describe.skipIf(!hasTestInfra)('SMS 발송 현황 /api/v1/admin/sms/status (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    t.sms.messages.length = 0;
    admin = await signUpTestUser(t);
    member = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    await t.app.get(AdminGuard).invalidate(admin.id);
  });

  const read = (cookie?: string) =>
    t.app.inject({ method: 'GET', url: URL, headers: cookie ? { cookie } : {} });
  const statusOf = async (): Promise<AdminSmsStatus> => {
    const res = await read(admin.cookie);
    expect(res.statusCode, res.body).toBe(200);
    return adminSmsStatusSchema.parse(res.json<{ data: unknown }>().data);
  };
  const requestCode = (as: TestUser, phone: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/me/phone-verification/code',
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: as.cookie },
      payload: JSON.stringify({ realName: '홍길동', phone, expectedAccountId: as.id }),
    });

  /** A recorded send of `userId` at `ms` (epoch), with what the provider said of it. */
  async function send(userId: string, ms: number, sendOutcome: 'accepted' | 'unknown') {
    await t.db.insert(schema.phoneVerificationCodes).values({
      id: randomUUID(),
      userId,
      phone: '01012345678',
      realName: '홍길동',
      codeHash: 'f'.repeat(64),
      sentAt: new Date(ms),
      expiresAt: new Date(ms + 180_000),
      clientIp: '203.0.113.7',
      sendOutcome,
    });
  }

  it('answers only an admin: 401 without a session, 403 for a member', async () => {
    expect((await read()).statusCode).toBe(401);
    const refused = await read(member.cookie);
    expect(refused.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(refused.json()).error.code).toBe('FORBIDDEN');
    expect((await read(admin.cookie)).statusCode).toBe(200);
  });

  it('answers zeros and the seven Korean days, newest first, when nothing was sent', async () => {
    const before = Date.now();
    const status = await statusOf();
    expect(status.last24Hours).toEqual({ sent: 0, unknown: 0, refused: 0, serviceLimit: 500 });
    const asOf = Date.parse(status.asOf);
    expect(Math.abs(asOf - before)).toBeLessThan(60_000);
    expect(status.days).toEqual(
      Array.from({ length: 7 }, (_, back) => ({
        date: kstDate(asOf - back * DAY_MS),
        sent: 0,
        unknown: 0,
        refused: 0,
      })),
    );
  });

  it('counts the sends of the service’s 24 hours and of each Korean day, and no personal data', async () => {
    const { user: a } = await createUser(t.db);
    const now = Date.now();
    // In the last 24 hours: two taken, one never answered for, two refused.
    await send(a.id, now - 1 * HOUR_MS, 'accepted');
    await send(a.id, now - 2 * HOUR_MS, 'unknown');
    await send(a.id, now - 23 * HOUR_MS, 'accepted');
    // Before them: inside the seven days but not the 24 hours, and outside both.
    await send(a.id, now - 25 * HOUR_MS, 'unknown');
    await send(a.id, now - 9 * DAY_MS, 'accepted');
    const refusedAt = [now - 3 * HOUR_MS, now - 4 * HOUR_MS, now - 30 * HOUR_MS, now - 8 * DAY_MS];
    await t.db
      .insert(schema.phoneVerificationRefusedSends)
      .values(refusedAt.map((ms) => ({ attemptedAt: new Date(ms) })));

    const status = await statusOf();
    expect(status.last24Hours).toEqual({ sent: 3, unknown: 1, refused: 2, serviceLimit: 500 });

    // Each row on its Korean date; the seven days run from today back.
    const asOf = Date.parse(status.asOf);
    const expected = new Map(
      Array.from({ length: 7 }, (_, back) => [
        kstDate(asOf - back * DAY_MS),
        { sent: 0, unknown: 0, refused: 0 },
      ]),
    );
    for (const [ms, unknown] of [
      [now - 1 * HOUR_MS, false],
      [now - 2 * HOUR_MS, true],
      [now - 23 * HOUR_MS, false],
      [now - 25 * HOUR_MS, true],
      [now - 9 * DAY_MS, false],
    ] as const) {
      const day = expected.get(kstDate(ms));
      if (day === undefined) continue;
      day.sent += 1;
      if (unknown) day.unknown += 1;
    }
    for (const ms of refusedAt) {
      const day = expected.get(kstDate(ms));
      if (day !== undefined) day.refused += 1;
    }
    expect(status.days).toEqual([...expected].map(([date, counts]) => ({ date, ...counts })));
    // The nine-day-old send and the eight-day-old refusal are past the seven days.
    expect(status.days.reduce((sum, day) => sum + day.sent, 0)).toBe(4);
    expect(status.days.reduce((sum, day) => sum + day.refused, 0)).toBe(3);

    // Counts only: no account, number, name or address.
    const body = (await read(admin.cookie)).body;
    for (const secret of [a.id, '01012345678', '홍길동', '203.0.113.7']) {
      expect(body).not.toContain(secret);
    }
  });

  it('splits the days at midnight in Seoul, whatever hour it runs at', async () => {
    // The rows above sit hours from now, so whether one falls between 15:00 and 24:00 UTC — where
    // its Korean date and its UTC date differ — depends on when the suite runs. These sit minutes
    // from midnight in Seoul instead, which is 15:00 UTC: ten minutes either side of it share a
    // UTC date and fall on two Korean days, on every run.
    const { user: a } = await createUser(t.db);
    const today = kstMidnight(Date.now());
    const yesterday = today - DAY_MS;
    const lastOfDayBefore = yesterday - 10 * MINUTE_MS; // 23:50, two days ago
    const firstOfYesterday = yesterday + 10 * MINUTE_MS; // 00:10, yesterday
    expect(new Date(lastOfDayBefore).toISOString().slice(0, 10)).toBe(
      new Date(firstOfYesterday).toISOString().slice(0, 10),
    );
    // The seven days start at midnight six days before today's: ten minutes after it is in them,
    // ten minutes before it is not.
    const firstDay = today - 6 * DAY_MS;
    const inFirstDay = firstDay + 10 * MINUTE_MS;
    const beforeFirstDay = firstDay - 10 * MINUTE_MS;
    const instants = [lastOfDayBefore, firstOfYesterday, inFirstDay, beforeFirstDay];
    for (const ms of instants) await send(a.id, ms, 'accepted');
    await t.db
      .insert(schema.phoneVerificationRefusedSends)
      .values(instants.map((ms) => ({ attemptedAt: new Date(ms) })));

    const status = await statusOf();
    // Midnight in Seoul passed between the inserts and the read: the days moved under the rows.
    if (kstDate(Date.now()) !== kstDate(today)) return;
    const one = { sent: 1, unknown: 0, refused: 1 };
    const none = { sent: 0, unknown: 0, refused: 0 };
    expect(status.days).toEqual(
      Array.from({ length: 7 }, (_, back) => ({
        date: kstDate(today - back * DAY_MS + HOUR_MS),
        ...(back === 1 || back === 2 || back === 6 ? one : none),
      })),
    );
  });

  it('counts what the provider said of real sends: taken, never answered, refused', async () => {
    const second = await signUpTestUser(t);
    const third = await signUpTestUser(t);
    expect((await requestCode(member, '01011112222')).statusCode).toBe(200);
    t.sms.failNext(1, 'unknown');
    expect((await requestCode(second, '01033334444')).statusCode).toBe(502);
    t.sms.failNext(1, 'refused');
    expect((await requestCode(third, '01055556666')).statusCode).toBe(502);

    const status = await statusOf();
    // The refused one is not a send (no limit counts it), but it is counted as refused.
    expect(status.last24Hours).toEqual({ sent: 2, unknown: 1, refused: 1, serviceLimit: 500 });
    // Today's, whichever day it is now: summed, so a run across midnight holds too.
    const total = (key: 'sent' | 'unknown' | 'refused') =>
      status.days.reduce((sum, day) => sum + day[key], 0);
    expect([total('sent'), total('unknown'), total('refused')]).toEqual([2, 1, 1]);
  });
});
