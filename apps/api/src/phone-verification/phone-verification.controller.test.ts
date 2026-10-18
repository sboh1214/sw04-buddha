/**
 * 본인확인 over HTTP (#183, ADR-0069 decision 1 #57-1·#57-3, ADR-0070), against the docker `test`
 * profile, with the in-memory SMS sender: the code is texted and confirmed, the record is the
 * only way to "verified", and every fixed limit holds — three minutes, five entries, sixty
 * seconds, ten a day per account and per number, one account per number.
 */
import { randomUUID } from 'node:crypto';
import { isPhoneVerified, schema } from '@buddha/db';
import { createPhoneVerification, createUser } from '@buddha/db/test';
import {
  PHONE_VERIFICATION_LIMITS,
  RATE_LIMIT_BUCKETS,
  errorEnvelopeSchema,
  meSchema,
  phoneVerificationCodeSentSchema,
  phoneVerificationLimitedDetailsSchema,
  phoneVerificationSchema,
  verificationCodeRejectedDetailsSchema,
  type ErrorCode,
  type ValidationIssue,
} from '@buddha/shared';
import { eq, sql } from 'drizzle-orm';
import { type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { PhoneVerificationService } from './phone-verification.service.js';

const ORIGIN = 'http://localhost:3000';
const PHONE = '01012345678';
const DAY_MS = 24 * 60 * 60 * 1_000;

describe.skipIf(!hasTestInfra)('본인확인 /api/v1/me/phone-verification (integration)', () => {
  let t: TestApp;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    t.sms.messages.length = 0;
    user = await signUpTestUser(t);
  });

  const call = (
    method: 'POST' | 'PUT',
    url: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ) =>
    t.app.inject({
      method,
      url: `/api/v1/me/${url}`,
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
      payload: JSON.stringify(payload),
    });
  const request = (
    as: TestUser,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) =>
    call(
      'POST',
      'phone-verification/code',
      { realName: '홍길동', phone: PHONE, expectedAccountId: as.id, ...body },
      { cookie: as.cookie, ...headers },
    );
  const confirm = (as: TestUser, code: string, body: Record<string, unknown> = {}) =>
    call(
      'POST',
      'phone-verification/confirm',
      { code, expectedAccountId: as.id, ...body },
      { cookie: as.cookie },
    );
  const renameTo = (as: TestUser, realName: string, body: Record<string, unknown> = {}) =>
    call(
      'PUT',
      'real-name',
      { realName, expectedAccountId: as.id, ...body },
      { cookie: as.cookie },
    );

  const getMe = async (as: TestUser) => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: as.cookie },
    });
    expect(res.statusCode).toBe(200);
    return meSchema.parse(res.json<{ data: unknown }>().data);
  };
  const codeRows = (userId?: string) =>
    t.db
      .select()
      .from(schema.phoneVerificationCodes)
      .where(userId === undefined ? undefined : eq(schema.phoneVerificationCodes.userId, userId))
      .orderBy(schema.phoneVerificationCodes.sentAt);
  const verificationRows = () => t.db.select().from(schema.phoneVerifications);

  /** The refusal's code and details, after checking its status. */
  function refusal(res: LightMyRequestResponse, status: number, code: ErrorCode) {
    expect({ status: res.statusCode, body: res.body }).toMatchObject({ status });
    const { error } = errorEnvelopeSchema.parse(res.json());
    expect(error.code).toBe(code);
    return error.details;
  }

  /** A code that is not `code`. */
  const wrong = (code: string) => (code === '000000' ? '000001' : '000000');

  /** Moves every code of `userId` back by `ms`, as if sent that long before. */
  async function age(userId: string, ms: number) {
    await t.db
      .update(schema.phoneVerificationCodes)
      .set({
        sentAt: sql`${schema.phoneVerificationCodes.sentAt} - make_interval(secs => ${ms / 1_000})`,
        expiresAt: sql`${schema.phoneVerificationCodes.expiresAt} - make_interval(secs => ${ms / 1_000})`,
      })
      .where(eq(schema.phoneVerificationCodes.userId, userId));
  }

  /** `count` past sends for `userId` to `phone`, the newest `newestAgoMs` before now. */
  async function pastSends(userId: string, phone: string, count: number, newestAgoMs: number) {
    const now = Date.now();
    await t.db.insert(schema.phoneVerificationCodes).values(
      Array.from({ length: count }, (_, index) => {
        const sentAt = new Date(now - newestAgoMs - index * 60_000);
        return {
          id: randomUUID(),
          userId,
          phone,
          realName: '홍길동',
          codeHash: 'f'.repeat(64),
          sentAt,
          expiresAt: new Date(sentAt.getTime() + 180_000),
        };
      }),
    );
  }

  // ---- the happy path -------------------------------------------------------------------

  it('texts a code, confirms it and records the number and the real name (AC 1·2)', async () => {
    // Another account's code, waiting: nothing below may touch it.
    const { user: bystander } = await createUser(t.db);
    await pastSends(bystander.id, '01099990000', 1, 1_000);

    const sent = await request(user, { realName: ' 홍길동 ', phone: '010-1234-5678' });
    expect(sent.statusCode).toBe(200);
    // Counted from the row's clock: at most the fixed spans, less only the request's own time.
    const spans = phoneVerificationCodeSentSchema.parse(sent.json<{ data: unknown }>().data);
    expect(spans.expiresInSeconds).toBeGreaterThanOrEqual(178);
    expect(spans.expiresInSeconds).toBeLessThanOrEqual(180);
    expect(spans.resendAfterSeconds).toBe(60);
    expect(t.sms.messages).toEqual([
      { to: PHONE, code: expect.stringMatching(/^\d{6}$/) as string, expiresInMinutes: 3 },
    ]);
    const code = t.sms.lastCodeTo(PHONE);

    // Stored as an HMAC, with the number and the name as normalised, valid three minutes.
    const [row] = await codeRows(user.id);
    expect(row).toMatchObject({ phone: PHONE, realName: '홍길동', attempts: 0, consumedAt: null });
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.codeHash).not.toContain(code);
    expect(row!.expiresAt.getTime() - row!.sentAt.getTime()).toBe(180_000);
    // Sending verifies nothing.
    expect((await getMe(user)).verification).toBeNull();
    expect(await isPhoneVerified(t.db, user.id)).toBe(false);

    const confirmed = await confirm(user, ` ${code} `);
    expect(confirmed.statusCode).toBe(200);
    const verification = phoneVerificationSchema.parse(confirmed.json<{ data: unknown }>().data);
    expect(verification).toMatchObject({ realName: '홍길동', phone: PHONE });
    expect((await getMe(user)).verification).toEqual(verification);
    expect(await verificationRows()).toMatchObject([
      { userId: user.id, phone: PHONE, realName: '홍길동' },
    ]);
    const [used] = await codeRows(user.id);
    expect(used!.consumedAt?.toISOString()).toBe(verification.verifiedAt);
    expect((await codeRows(bystander.id))[0]).toMatchObject({ attempts: 0, consumedAt: null });
    // #58 and #70 read the same answer, from the service or inside their own transaction.
    expect(await t.app.get(PhoneVerificationService).isVerified(user.id)).toBe(true);
    expect(await isPhoneVerified(t.db, user.id)).toBe(true);
  });

  it('answers the spans less the time the provider took, so no screen outlives the code', async () => {
    t.sms.delayNext(1_100);
    const sent = await request(user);
    expect(sent.statusCode).toBe(200);
    const spans = phoneVerificationCodeSentSchema.parse(sent.json<{ data: unknown }>().data);
    expect(spans.expiresInSeconds).toBeLessThanOrEqual(178);
    expect(spans.expiresInSeconds).toBeGreaterThanOrEqual(170);
    expect(spans.resendAfterSeconds).toBeLessThanOrEqual(59);
    expect(spans.resendAfterSeconds).toBeGreaterThanOrEqual(50);
    // The row itself still runs the fixed three minutes from its send.
    const [row] = await codeRows(user.id);
    expect(row!.expiresAt.getTime() - row!.sentAt.getTime()).toBe(180_000);
  });

  it('refuses a used code and any further code once verified (AC 2)', async () => {
    await request(user);
    const code = t.sms.lastCodeTo(PHONE);
    expect((await confirm(user, code)).statusCode).toBe(200);

    expect(refusal(await confirm(user, code), 409, 'PHONE_VERIFICATION_NOT_ALLOWED')).toEqual({
      reason: 'already_verified',
    });
    expect(refusal(await request(user), 409, 'PHONE_VERIFICATION_NOT_ALLOWED')).toEqual({
      reason: 'already_verified',
    });
    expect(t.sms.messages).toHaveLength(1);
  });

  // ---- wrong, expired, missing codes ----------------------------------------------------------

  it('counts wrong entries, discards the code on the fifth and refuses it after (AC 2·3)', async () => {
    const { user: bystander } = await createUser(t.db);
    await pastSends(bystander.id, '01099990000', 1, 1_000);
    await request(user);
    const code = t.sms.lastCodeTo(PHONE);
    for (const remainingAttempts of [4, 3, 2, 1]) {
      expect(refusal(await confirm(user, wrong(code)), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
        reason: 'mismatch',
        remainingAttempts,
      });
    }
    expect(refusal(await confirm(user, wrong(code)), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'attempts_exceeded',
    });
    // Discarded: even the right code is refused now, and no entry is counted any more.
    expect(refusal(await confirm(user, code), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'attempts_exceeded',
    });
    expect((await codeRows(user.id))[0]!.attempts).toBe(PHONE_VERIFICATION_LIMITS.maxAttempts);
    expect(await verificationRows()).toEqual([]);
    // The entries were this account's code's alone.
    expect((await codeRows(bystander.id))[0]).toMatchObject({ attempts: 0, consumedAt: null });

    // A new code, a minute later, is a new start.
    await age(user.id, 61_000);
    expect((await request(user)).statusCode).toBe(200);
    expect((await confirm(user, t.sms.lastCodeTo(PHONE))).statusCode).toBe(200);
  });

  it('refuses a code after its three minutes, spending no entry (AC 2·3)', async () => {
    await request(user);
    const code = t.sms.lastCodeTo(PHONE);
    await age(user.id, 180_000);
    expect(refusal(await confirm(user, code), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'expired',
    });
    expect(refusal(await confirm(user, wrong(code)), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'expired',
    });
    expect((await codeRows(user.id))[0]!.attempts).toBe(0);
    expect(await verificationRows()).toEqual([]);
  });

  it('refuses a confirmation with no code sent, and confirms only the newest code', async () => {
    expect(refusal(await confirm(user, '123456'), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'no_code',
    });
    await request(user, { phone: '01011112222' });
    const first = t.sms.lastCodeTo('01011112222');
    await age(user.id, 61_000);
    await request(user, { phone: '01033334444', realName: '김철수' });
    const second = t.sms.lastCodeTo('01033334444');
    if (first !== second) {
      expect(refusal(await confirm(user, first), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
        reason: 'mismatch',
        remainingAttempts: 4,
      });
    }
    const confirmed = await confirm(user, second);
    expect(confirmed.statusCode).toBe(200);
    // The number and the name the newest code was sent with.
    expect(confirmed.json<{ data: unknown }>().data).toMatchObject({
      phone: '01033334444',
      realName: '김철수',
    });
  });

  // ---- the send limits -------------------------------------------------------------------------

  it('sends again only sixty seconds after the account’s previous send (AC 3)', async () => {
    expect((await request(user)).statusCode).toBe(200);
    // Another number does not reset the interval: it is the account's.
    const details = refusal(
      await request(user, { phone: '01099998888' }),
      429,
      'PHONE_VERIFICATION_LIMITED',
    );
    const limited = phoneVerificationLimitedDetailsSchema.parse(details);
    expect(limited.reason).toBe('resend_interval');
    expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(58);
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(t.sms.messages).toHaveLength(1);
    expect(await codeRows(user.id)).toHaveLength(1);

    await age(user.id, 60_000);
    expect((await request(user)).statusCode).toBe(200);
    expect(t.sms.messages).toHaveLength(2);
  });

  it('sends an account at most ten codes in 24 hours, until the oldest leaves the window (AC 3)', async () => {
    // Ten sends to ten numbers, the newest two minutes ago and the oldest 23 h 41 min ago.
    const oldestAgo = DAY_MS - 19 * 60_000;
    await pastSends(user.id, '01055550000', 1, oldestAgo);
    for (let i = 1; i < 10; i += 1) {
      await pastSends(user.id, `0105555000${String(i)}`, 1, 2 * 60_000 + i * 60_000);
    }
    const limited = phoneVerificationLimitedDetailsSchema.parse(
      refusal(await request(user), 429, 'PHONE_VERIFICATION_LIMITED'),
    );
    expect(limited.reason).toBe('account_daily');
    expect(limited.retryAfterSeconds).toBeGreaterThan(18 * 60);
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(19 * 60);
    expect(t.sms.messages).toEqual([]);

    // Once the oldest is more than 24 hours old it counts for nothing, and the send purges it.
    await t.db
      .update(schema.phoneVerificationCodes)
      .set({
        sentAt: new Date(Date.now() - DAY_MS - 1_000),
        expiresAt: new Date(Date.now() - DAY_MS + 179_000),
      })
      .where(eq(schema.phoneVerificationCodes.phone, '01055550000'));
    expect((await request(user)).statusCode).toBe(200);
    expect(await codeRows(user.id)).toHaveLength(10);
  });

  it('sends a number at most ten codes in 24 hours, whichever accounts ask (AC 3)', async () => {
    for (let i = 0; i < 10; i += 1) {
      const { user: other } = await createUser(t.db);
      await pastSends(other.id, PHONE, 1, 2 * 60_000 + i * 60_000);
    }
    expect(
      phoneVerificationLimitedDetailsSchema.parse(
        refusal(await request(user), 429, 'PHONE_VERIFICATION_LIMITED'),
      ).reason,
    ).toBe('phone_daily');
    // Another number is still open to this account.
    expect((await request(user, { phone: '01077778888' })).statusCode).toBe(200);
  });

  it('lets one other account fill a number’s ten a day, refusing its holder for 24 hours (ADR-0070 결과 5, an owner question)', async () => {
    // One account, sixty seconds apart, ten codes to a number that is not its own. Pinned as it
    // stands: whether the number's limit should count every account is the owner's to decide.
    const { user: sender } = await createUser(t.db);
    await pastSends(sender.id, PHONE, 10, 2 * 60_000);
    const limited = phoneVerificationLimitedDetailsSchema.parse(
      refusal(await request(user), 429, 'PHONE_VERIFICATION_LIMITED'),
    );
    expect(limited.reason).toBe('phone_daily');
    // Until the oldest of the ten leaves the window, about 23 h 49 min from now.
    expect(limited.retryAfterSeconds).toBeGreaterThan(23 * 3_600);
    expect(t.sms.messages).toEqual([]);
    // The operator's remedy (ADR-0070 결과 5): the other account's rows for the number go.
    await t.db
      .delete(schema.phoneVerificationCodes)
      .where(eq(schema.phoneVerificationCodes.userId, sender.id));
    expect((await request(user)).statusCode).toBe(200);
  });

  it('counts a send the provider refused for nothing, and that code cannot be confirmed (AC 1)', async () => {
    // Other accounts' sends to the same number: forgetting the refused send must not forget them.
    const { user: bystander } = await createUser(t.db);
    await pastSends(bystander.id, PHONE, 3, 2 * 60_000);
    t.sms.failNext(1, 'refused');
    const failed = await request(user);
    expect(refusal(failed, 502, 'SMS_SEND_FAILED')).toBeUndefined();
    // A 5xx carries no message of its own (ADR-0020), and certainly not the number.
    expect(failed.body).not.toContain(PHONE);
    expect(await codeRows(user.id)).toEqual([]);
    expect(await codeRows(bystander.id)).toHaveLength(3);
    expect(t.sms.messages).toEqual([]);
    expect(refusal(await confirm(user, '123456'), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'no_code',
    });
    // No interval to wait out: nothing was sent.
    expect((await request(user)).statusCode).toBe(200);
    expect((await confirm(user, t.sms.lastCodeTo(PHONE))).statusCode).toBe(200);
  });

  it('keeps a send whose outcome is unknown: counted against the limits, and its code confirmable (decision 7-3)', async () => {
    // The provider took the text and its answer was lost (a timeout): the phone holds the code.
    t.sms.failNext(1, 'unknown');
    const failed = await request(user);
    expect(refusal(failed, 502, 'SMS_SEND_FAILED')).toBeUndefined();
    expect(failed.body).not.toContain(PHONE);
    expect(await codeRows(user.id)).toMatchObject([
      { phone: PHONE, attempts: 0, consumedAt: null },
    ]);

    // Counted like any send: the resend interval holds, so a slow provider cannot be asked again
    // and again for texts the limits never see.
    expect(
      phoneVerificationLimitedDetailsSchema.parse(
        refusal(await request(user), 429, 'PHONE_VERIFICATION_LIMITED'),
      ).reason,
    ).toBe('resend_interval');
    expect(t.sms.messages).toHaveLength(1);

    // The code that reached the phone verifies the account.
    const confirmed = await confirm(user, t.sms.lastCodeTo(PHONE));
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<{ data: unknown }>().data).toMatchObject({ phone: PHONE });
  });

  it('counts unknown-outcome sends towards the ten a day of the account and the number', async () => {
    // Nine past sends of the account to this number; the tenth fails with an unknown outcome.
    await pastSends(user.id, PHONE, 9, 2 * 60_000);
    t.sms.failNext(1, 'unknown');
    refusal(await request(user), 502, 'SMS_SEND_FAILED');
    expect(await codeRows(user.id)).toHaveLength(10);

    expect(
      phoneVerificationLimitedDetailsSchema.parse(
        refusal(await request(user, { phone: '01077778888' }), 429, 'PHONE_VERIFICATION_LIMITED'),
      ).reason,
    ).toBe('account_daily');
    const other = await signUpTestUser(t);
    expect(
      phoneVerificationLimitedDetailsSchema.parse(
        refusal(await request(other), 429, 'PHONE_VERIFICATION_LIMITED'),
      ).reason,
    ).toBe('phone_daily');
  });

  it('bounds the code requests of one account per minute as well (rate limit, defence in depth)', async () => {
    // Per account: behind the web's rewrite every visitor shares one address, so a per-address
    // bucket would hold the whole site to five a minute.
    expect(RATE_LIMIT_BUCKETS.phoneVerification).toEqual({ scope: 'user', limit: 5 });
    const statuses: (ErrorCode | number)[] = [];
    for (let i = 0; i < RATE_LIMIT_BUCKETS.phoneVerification.limit + 1; i += 1) {
      const res = await request(user);
      statuses.push(
        res.statusCode === 200 ? 200 : errorEnvelopeSchema.parse(res.json()).error.code,
      );
    }
    expect(statuses).toEqual([
      200,
      'PHONE_VERIFICATION_LIMITED',
      'PHONE_VERIFICATION_LIMITED',
      'PHONE_VERIFICATION_LIMITED',
      'PHONE_VERIFICATION_LIMITED',
      'RATE_LIMITED',
    ]);
    // Another account, from the same address, has its own bucket.
    const other = await signUpTestUser(t);
    expect((await request(other, { phone: '01077778888' })).statusCode).toBe(200);
  });

  // ---- one account per number ----------------------------------------------------------------

  it('refuses a number another account verified, telling only the holder of the number (AC 4)', async () => {
    const holder = await signUpTestUser(t);
    await createPhoneVerification(t.db, { userId: holder.id, phone: PHONE });
    // The code is sent: whether the number is taken is not told to whoever merely names it.
    expect((await request(user)).statusCode).toBe(200);
    const code = t.sms.lastCodeTo(PHONE);
    expect(refusal(await confirm(user, wrong(code)), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'mismatch',
      remainingAttempts: 4,
    });
    expect(refusal(await confirm(user, code), 409, 'PHONE_VERIFICATION_NOT_ALLOWED')).toEqual({
      reason: 'phone_in_use',
    });
    expect(await verificationRows()).toMatchObject([{ userId: holder.id, phone: PHONE }]);
    expect((await getMe(user)).verification).toBeNull();
  });

  it('lets one of two accounts confirming one number at once have it (AC 4)', async () => {
    const other = await signUpTestUser(t);
    await request(user);
    const mine = t.sms.lastCodeTo(PHONE);
    await request(other);
    const theirs = t.sms.lastCodeTo(PHONE);
    const answers = await Promise.all([confirm(user, mine), confirm(other, theirs)]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const loser = answers.find((res) => res.statusCode === 409)!;
    expect(errorEnvelopeSchema.parse(loser.json()).error).toMatchObject({
      code: 'PHONE_VERIFICATION_NOT_ALLOWED',
      details: { reason: 'phone_in_use' },
    });
    expect(await verificationRows()).toHaveLength(1);
    // The loser's code was not used up by the winner's confirmation.
    const loserId = answers[0].statusCode === 409 ? user.id : other.id;
    expect((await codeRows(loserId))[0]).toMatchObject({ consumedAt: null });
  });

  // ---- concurrency: the account's and the number's locks ----------------------------------

  it('counts every one of concurrent wrong entries: the fifth discards the code (account lock)', async () => {
    await request(user);
    const code = t.sms.lastCodeTo(PHONE);
    const answers = await Promise.all(Array.from({ length: 8 }, () => confirm(user, wrong(code))));
    const details = answers.map((res) =>
      verificationCodeRejectedDetailsSchema.parse(refusal(res, 409, 'VERIFICATION_CODE_REJECTED')),
    );
    // Four entries left 4, 3, 2 and 1; the fifth and every one after it are attempts_exceeded.
    const left = details.flatMap((d) => (d.reason === 'mismatch' ? [d.remainingAttempts] : []));
    expect(left.sort()).toEqual([1, 2, 3, 4]);
    expect(details.filter((d) => d.reason === 'attempts_exceeded')).toHaveLength(4);
    expect((await codeRows(user.id))[0]!.attempts).toBe(PHONE_VERIFICATION_LIMITS.maxAttempts);
    expect(refusal(await confirm(user, code), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'attempts_exceeded',
    });
  });

  it('sends one code of concurrent requests of one account, to whichever number (account lock)', async () => {
    const phones = [PHONE, '01077778888', '01066667777'];
    const answers = await Promise.all(phones.map((phone) => request(user, { phone })));
    expect(answers.filter((res) => res.statusCode === 200)).toHaveLength(1);
    for (const res of answers.filter((candidate) => candidate.statusCode !== 200)) {
      expect(
        phoneVerificationLimitedDetailsSchema.parse(refusal(res, 429, 'PHONE_VERIFICATION_LIMITED'))
          .reason,
      ).toBe('resend_interval');
    }
    expect(await codeRows(user.id)).toHaveLength(1);
    expect(t.sms.messages).toHaveLength(1);
  });

  it('sends a number only its tenth code when two accounts ask at once (number lock)', async () => {
    for (let i = 0; i < 9; i += 1) {
      const { user: past } = await createUser(t.db);
      await pastSends(past.id, PHONE, 1, 2 * 60_000 + i * 60_000);
    }
    const other = await signUpTestUser(t);
    const answers = await Promise.all([request(user), request(other)]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 429]);
    const limited = answers.find((res) => res.statusCode === 429)!;
    expect(
      phoneVerificationLimitedDetailsSchema.parse(
        refusal(limited, 429, 'PHONE_VERIFICATION_LIMITED'),
      ).reason,
    ).toBe('phone_daily');
    expect(
      await t.db
        .select()
        .from(schema.phoneVerificationCodes)
        .where(eq(schema.phoneVerificationCodes.phone, PHONE)),
    ).toHaveLength(10);
    expect(t.sms.messages).toHaveLength(1);
  });

  // ---- the real name ------------------------------------------------------------------------

  it('changes the real name of a verified account and nothing else (AC 9)', async () => {
    // Another verified account, whose record no rename below may touch.
    const { user: other } = await createUser(t.db);
    await createPhoneVerification(t.db, {
      userId: other.id,
      phone: '01099990000',
      realName: '박영희',
    });
    const [othersBefore] = await t.db
      .select()
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, other.id));
    // No record of its own: refused, whoever else has one.
    expect(refusal(await renameTo(user, '김철수'), 409, 'VERIFICATION_REQUIRED')).toBeUndefined();
    await request(user);
    await confirm(user, t.sms.lastCodeTo(PHONE));
    const before = (await getMe(user)).verification!;

    const res = await renameTo(user, ' 김 철수 ');
    expect(res.statusCode).toBe(200);
    expect(phoneVerificationSchema.parse(res.json<{ data: unknown }>().data)).toEqual({
      ...before,
      realName: '김 철수',
    });
    expect((await getMe(user)).verification).toEqual({ ...before, realName: '김 철수' });

    const invalid = await renameTo(user, '김1');
    const issues = refusal(invalid, 400, 'VALIDATION_ERROR') as ValidationIssue[];
    expect([...new Set(issues.map((issue) => issue.path.join('.')))]).toEqual(['realName']);
    // The number has no route: a body naming one changes nothing.
    await renameTo(user, '김철수', { phone: '01099998888' });
    expect((await getMe(user)).verification?.phone).toBe(PHONE);

    // The other account's record is as it was, and an account that never verified is still
    // refused while two records exist.
    expect(
      (await verificationRows()).map(({ userId, realName }) => ({ userId, realName })),
    ).toEqual(
      expect.arrayContaining([
        { userId: user.id, realName: '김철수' },
        { userId: other.id, realName: '박영희' },
      ]) as unknown,
    );
    expect(await verificationRows()).toHaveLength(2);
    const [othersAfter] = await t.db
      .select()
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, other.id));
    expect(othersAfter).toEqual(othersBefore);
    const unverified = await signUpTestUser(t);
    expect(
      refusal(await renameTo(unverified, '이영수'), 409, 'VERIFICATION_REQUIRED'),
    ).toBeUndefined();
  });

  // ---- the request itself -------------------------------------------------------------------

  it('refuses an invalid name, number or code with 400 naming the field, sending nothing', async () => {
    // Five: the account's rate-limit bucket counts refused requests too, and a sixth would be 429.
    const cases: [Record<string, unknown>, string][] = [
      [{ realName: '홍길동1' }, 'realName'],
      [{ phone: '02-123-4567' }, 'phone'],
      [{ phone: '+821012345678' }, 'phone'],
      [{ phone: 1012345678 }, 'phone'],
      [{ expectedAccountId: '' }, 'expectedAccountId'],
    ];
    for (const [body, field] of cases) {
      const issues = refusal(await request(user, body), 400, 'VALIDATION_ERROR');
      const paths = (issues as ValidationIssue[]).map((issue) => issue.path.join('.'));
      expect({ body, paths: [...new Set(paths)] }).toEqual({ body, paths: [field] });
    }
    for (const code of ['12345', '1234567', 'abcdef', 123456]) {
      refusal(await confirm(user, code as string), 400, 'VALIDATION_ERROR');
    }
    expect(t.sms.messages).toEqual([]);
    expect(await codeRows()).toEqual([]);
  });

  it('answers 401 without a session and 403 for a foreign Origin, sending and writing nothing', async () => {
    const anonymous = await call('POST', 'phone-verification/code', {
      realName: '홍길동',
      phone: PHONE,
      expectedAccountId: user.id,
    });
    refusal(anonymous, 401, 'UNAUTHENTICATED');
    for (const origin of ['https://evil.example', 'null']) {
      refusal(await request(user, {}, { origin }), 403, 'FORBIDDEN');
    }
    expect(t.sms.messages).toEqual([]);
    expect(await codeRows()).toEqual([]);
  });

  it('refuses every write naming another account than the cookie (403 naming expectedAccountId)', async () => {
    // A tab still showing `user` after another tab signed in as `other`.
    const other = await signUpTestUser(t);
    await request(other);
    const code = t.sms.lastCodeTo(PHONE);
    t.sms.messages.length = 0;
    const named = { expectedAccountId: user.id };
    for (const res of [
      await call(
        'POST',
        'phone-verification/code',
        { realName: '홍길동', phone: '01099998888', ...named },
        { cookie: other.cookie },
      ),
      await call(
        'POST',
        'phone-verification/confirm',
        { code, ...named },
        { cookie: other.cookie },
      ),
      await call('PUT', 'real-name', { realName: '김철수', ...named }, { cookie: other.cookie }),
    ]) {
      expect(refusal(res, 403, 'FORBIDDEN')).toEqual([
        { path: ['expectedAccountId'], message: 'session belongs to another account' },
      ]);
    }
    expect(t.sms.messages).toEqual([]);
    expect(await verificationRows()).toEqual([]);
    expect((await codeRows(other.id))[0]).toMatchObject({ attempts: 0, consumedAt: null });
  });
});
