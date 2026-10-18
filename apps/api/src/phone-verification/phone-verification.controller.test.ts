/**
 * 본인확인 over HTTP (#183, ADR-0069 decision 1 #57-1·#57-3, ADR-0070), against the docker `test`
 * profile, with the in-memory SMS sender: the code is texted and confirmed, the record is the
 * only way to "verified", and every fixed limit holds — three minutes, five entries, sixty
 * seconds, and in 24 hours ten per account and per account at a number, three accounts per
 * number, fifty per client address and five hundred for the service — with one account per
 * number; the limits shared with other accounts answer their waits in whole minutes. The sends
 * stay as the accounts' 본인확인 기록 (owner decisions 2026-10-18), with what the provider said
 * of each, and a send the provider refused leaves its time alone.
 *
 * The app trusts one proxy (Caddy's address in production) and lists one uncounted peer (the web
 * server's), so a request can name a client the way production's do: `inject` presents loopback
 * unless a test gives `remoteAddress`.
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
/** Whether `seconds` is the whole minutes from `minutes` to `minutes + 1`: a shared limit's wait. */
function wholeMinutesFrom(seconds: number, minutes: number): boolean {
  return seconds % 60 === 0 && seconds >= minutes * 60 && seconds <= (minutes + 1) * 60;
}
/** Caddy and the web server in deploy/compose.yaml: the trusted proxy and the uncounted peer. */
const PROXY = '172.28.0.10';
const WEB = '172.28.0.20';
/** A visitor's address (documentation ranges, RFC 5737). */
const VISITOR = '203.0.113.7';

describe.skipIf(!hasTestInfra)('본인확인 /api/v1/me/phone-verification (integration)', () => {
  let t: TestApp;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp({ trustProxy: `${PROXY}/32`, uncountedPeers: `${WEB}/32` });
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
  /** A code request as it reaches the API from `remoteAddress` (a visitor, Caddy, the web). */
  const requestFrom = (
    remoteAddress: string,
    as: TestUser,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/me/phone-verification/code',
      remoteAddress,
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: as.cookie,
        ...headers,
      },
      payload: JSON.stringify({
        realName: '홍길동',
        phone: PHONE,
        expectedAccountId: as.id,
        ...body,
      }),
    });
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
  const refusedRows = () =>
    t.db
      .select()
      .from(schema.phoneVerificationRefusedSends)
      .orderBy(schema.phoneVerificationRefusedSends.attemptedAt);

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

  /**
   * `count` past sends for `userId` to `phone`, the newest `newestAgoMs` before now and the rest
   * `stepMs` apart, from `clientIp` (none by default).
   */
  async function pastSends(
    userId: string,
    phone: string,
    count: number,
    newestAgoMs: number,
    { clientIp = null, stepMs = 60_000 }: { clientIp?: string | null; stepMs?: number } = {},
  ) {
    const now = Date.now();
    await t.db.insert(schema.phoneVerificationCodes).values(
      Array.from({ length: count }, (_, index) => {
        const sentAt = new Date(now - newestAgoMs - index * stepMs);
        return {
          id: randomUUID(),
          userId,
          phone,
          realName: '홍길동',
          codeHash: 'f'.repeat(64),
          sentAt,
          expiresAt: new Date(sentAt.getTime() + 180_000),
          clientIp,
        };
      }),
    );
  }
  /** The limit a refused code request names. */
  const limitOf = (res: LightMyRequestResponse) =>
    phoneVerificationLimitedDetailsSchema.parse(refusal(res, 429, 'PHONE_VERIFICATION_LIMITED'));

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

    // Stored as an HMAC, with the number and the name as normalised, valid three minutes. A
    // loopback peer names no client: no address recorded. The provider took it: `accepted`.
    const [row] = await codeRows(user.id);
    expect(row).toMatchObject({
      phone: PHONE,
      realName: '홍길동',
      attempts: 0,
      consumedAt: null,
      clientIp: null,
      sendOutcome: 'accepted',
    });
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
    // The send stays as the account's 본인확인 기록, marked used.
    const [used] = await codeRows(user.id);
    expect(used).toMatchObject({ id: row!.id, phone: PHONE, realName: '홍길동' });
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
      // The first text, typed after the second: refused as replaced, and no entry spent.
      expect(refusal(await confirm(user, first), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
        reason: 'superseded',
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

  it('refuses an older code after a resend without spending an entry (owner decision 2026-10-18)', async () => {
    const { user: bystander } = await createUser(t.db);
    await pastSends(bystander.id, '01099990000', 1, 1_000);
    await request(user);
    const older = t.sms.lastCodeTo(PHONE);
    await age(user.id, 61_000);
    await request(user);
    const newest = t.sms.lastCodeTo(PHONE);
    if (older === newest) return; // one draw in a million: nothing to tell apart
    for (let i = 0; i < PHONE_VERIFICATION_LIMITS.maxAttempts + 1; i += 1) {
      expect(refusal(await confirm(user, older), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
        reason: 'superseded',
      });
    }
    // Not one entry spent on the newest code, nor on the older one or another account's.
    expect((await codeRows(user.id)).map((row) => row.attempts)).toEqual([0, 0]);
    expect((await codeRows(bystander.id))[0]).toMatchObject({ attempts: 0, consumedAt: null });
    // A real wrong entry is still counted from five.
    const other = [older, newest].includes('000000')
      ? [older, newest].includes('000001')
        ? '000002'
        : '000001'
      : '000000';
    expect(refusal(await confirm(user, other), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'mismatch',
      remainingAttempts: 4,
    });

    // Another account's code — real, recent and still waiting — is not one of this account's:
    // a wrong entry, counted, and the other account's code untouched (answer 7 is per account).
    const sender = await signUpTestUser(t);
    expect((await request(sender, { phone: '01077770000' })).statusCode).toBe(200);
    const theirs = t.sms.lastCodeTo('01077770000');
    if (![older, newest, other].includes(theirs)) {
      expect(refusal(await confirm(user, theirs), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
        reason: 'mismatch',
        remainingAttempts: 3,
      });
      expect((await codeRows(user.id)).map((row) => row.attempts)).toEqual([0, 2]);
      expect(await codeRows(sender.id)).toMatchObject([{ attempts: 0, consumedAt: null }]);
    }
    expect((await confirm(user, newest)).statusCode).toBe(200);
  });

  it('refuses the text before a resend however old, among the nine codes before the newest', async () => {
    await request(user);
    const older = t.sms.lastCodeTo(PHONE);
    // Yesterday's text, unused; today's resend replaces it (answer 7 sets no time bound).
    await age(user.id, DAY_MS + 60_000);
    await request(user);
    const newest = t.sms.lastCodeTo(PHONE);
    if (older === newest) return;
    expect(refusal(await confirm(user, older), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'superseded',
    });
    expect((await codeRows(user.id)).map((row) => row.attempts)).toEqual([0, 0]);

    // Eight more sends between them (codes nobody holds): the first is the ninth before the
    // newest, still compared.
    await pastSends(user.id, PHONE, 8, 2 * 60 * 60_000);
    expect(refusal(await confirm(user, older), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'superseded',
    });
    // One more: the tenth before the newest is past the codes compared, and a wrong entry.
    await pastSends(user.id, PHONE, 1, 3 * 60 * 60_000);
    expect(refusal(await confirm(user, older), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'mismatch',
      remainingAttempts: 4,
    });
    expect((await confirm(user, newest)).statusCode).toBe(200);
  });

  it('answers an expired newest code as expired, whatever older code is typed', async () => {
    await request(user);
    const older = t.sms.lastCodeTo(PHONE);
    await age(user.id, 61_000);
    await request(user);
    await age(user.id, 180_000);
    expect(refusal(await confirm(user, older), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'expired',
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

    // Once the oldest is more than 24 hours old it counts for nothing — and it stays, as the
    // account's 본인확인 기록 (owner decision 2026-10-18: no purge; #184 deletes after withdrawal).
    await t.db
      .update(schema.phoneVerificationCodes)
      .set({
        sentAt: new Date(Date.now() - DAY_MS - 1_000),
        expiresAt: new Date(Date.now() - DAY_MS + 179_000),
      })
      .where(eq(schema.phoneVerificationCodes.phone, '01055550000'));
    expect((await request(user)).statusCode).toBe(200);
    const rows = await codeRows(user.id);
    expect(rows).toHaveLength(11);
    expect(rows[0]).toMatchObject({ phone: '01055550000', realName: '홍길동' });
  });

  it('keeps every send, however old, as the account’s record (no purge)', async () => {
    const { user: other } = await createUser(t.db);
    await pastSends(other.id, '01099990000', 3, 30 * DAY_MS, { clientIp: VISITOR });
    await pastSends(user.id, '01088880000', 2, 2 * DAY_MS);
    expect((await request(user)).statusCode).toBe(200);
    expect(await codeRows(other.id)).toHaveLength(3);
    expect(await codeRows(user.id)).toHaveLength(3);
  });

  it('counts the account’s sends to one number as the account’s: its ten are reached first', async () => {
    // Ten sends to this number: the pair's ten and the account's ten at once. The account's limit
    // answers (ADR-0070), and no other number is open to the account either.
    await pastSends(user.id, PHONE, 10, 2 * 60_000);
    expect(limitOf(await request(user)).reason).toBe('account_daily');
    expect(limitOf(await request(user, { phone: '01077778888' })).reason).toBe('account_daily');
    expect(t.sms.messages).toEqual([]);
  });

  it('texts codes at one number for at most three accounts in 24 hours (owner decision 2026-10-18)', async () => {
    // Three other accounts have had codes at the number, the oldest of them 23 h 30 min ago.
    const accounts = [];
    for (const agoMs of [2 * 60_000, 3_600_000, DAY_MS - 30 * 60_000]) {
      const { user: other } = await createUser(t.db);
      await pastSends(other.id, PHONE, 1, agoMs);
      accounts.push(other);
    }
    // A fourth is refused with its own reason, until the third newest of them leaves the window —
    // in whole minutes, since it is another account's send (owner decision, second round).
    const limited = limitOf(await request(user));
    expect(limited.reason).toBe('phone_accounts');
    expect(wholeMinutesFrom(limited.retryAfterSeconds, 30), String(limited.retryAfterSeconds)).toBe(
      true,
    );
    expect(t.sms.messages).toEqual([]);
    expect(await codeRows(user.id)).toEqual([]);
    // Another number is open to it.
    expect((await request(user, { phone: '01077778888' })).statusCode).toBe(200);
    // One of the three — an account that has sent to the number in the window — is not refused.
    const third = await signUpTestUser(t);
    await pastSends(third.id, PHONE, 1, 5 * 60_000);
    await t.db
      .delete(schema.phoneVerificationCodes)
      .where(eq(schema.phoneVerificationCodes.userId, accounts[0]!.id));
    expect((await request(third)).statusCode).toBe(200);
    // …and once an account's sends to the number are all older than 24 hours, it no longer counts.
    const fourth = await signUpTestUser(t);
    expect(limitOf(await request(fourth)).reason).toBe('phone_accounts');
    await t.db
      .update(schema.phoneVerificationCodes)
      .set({
        sentAt: new Date(Date.now() - DAY_MS - 60_000),
        expiresAt: new Date(Date.now() - DAY_MS + 120_000),
      })
      .where(eq(schema.phoneVerificationCodes.userId, accounts[2]!.id));
    expect((await request(fourth)).statusCode).toBe(200);
  });

  it('no longer lets one other account’s ten sends block a number’s holder (owner decision 2026-10-18)', async () => {
    // One account, sixty seconds apart, ten codes to a number that is not its own: its own pair's
    // ten. The number's holder, a second account at it, still receives a code.
    const { user: sender } = await createUser(t.db);
    await pastSends(sender.id, PHONE, 10, 2 * 60_000);
    expect((await request(user)).statusCode).toBe(200);
    expect(t.sms.messages).toHaveLength(1);
  });

  it('texts at most fifty codes a day from one client address, as the rate limit names it (owner decisions 2026-10-18)', async () => {
    // Forty-nine sends from the visitor's address, by another account, the oldest 23 h 50 min ago.
    const { user: other } = await createUser(t.db);
    await pastSends(other.id, '01055550000', 48, 2 * 60_000, { clientIp: VISITOR });
    await pastSends(other.id, '01055550001', 1, DAY_MS - 10 * 60_000, { clientIp: VISITOR });
    // The fiftieth goes (the owner raised twenty to fifty, second round), and records the address.
    expect((await requestFrom(VISITOR, user)).statusCode).toBe(200);
    expect((await codeRows(user.id))[0]).toMatchObject({ clientIp: VISITOR });
    t.sms.messages.length = 0;

    // A fifty-first, from the visitor directly and through Caddy (the trusted proxy names it):
    // refused until the oldest leaves, in whole minutes (other people's sends behind the address).
    const second = await signUpTestUser(t);
    const limited = limitOf(await requestFrom(VISITOR, second));
    expect(limited.reason).toBe('ip_daily');
    expect(wholeMinutesFrom(limited.retryAfterSeconds, 10), String(limited.retryAfterSeconds)).toBe(
      true,
    );
    expect(
      limitOf(await requestFrom(PROXY, second, {}, { 'x-forwarded-for': VISITOR })).reason,
    ).toBe('ip_daily');
    // An IPv4 visitor on a dual-stack socket is the same address.
    expect(limitOf(await requestFrom(`::ffff:${VISITOR}`, second)).reason).toBe('ip_daily');
    expect(t.sms.messages).toEqual([]);

    // Another visitor is not: its send records its own address.
    expect(
      (await requestFrom(PROXY, second, {}, { 'x-forwarded-for': '198.51.100.9' })).statusCode,
    ).toBe(200);
    expect((await codeRows(second.id))[0]).toMatchObject({ clientIp: '198.51.100.9' });
  });

  it('counts no address for a request that names no client: loopback and the web server', async () => {
    // Fifty sends with no address: nothing a per-address limit can count.
    const { user: other } = await createUser(t.db);
    await pastSends(other.id, '01055550000', 50, 2 * 60_000);
    // The web server's rewrite (an uncounted peer) and loopback name nobody: no address limit,
    // and no address recorded.
    expect((await requestFrom(WEB, user)).statusCode).toBe(200);
    const second = await signUpTestUser(t);
    expect((await request(second, { phone: '01077778888' })).statusCode).toBe(200);
    expect((await codeRows(user.id))[0]).toMatchObject({ clientIp: null });
    expect((await codeRows(second.id))[0]).toMatchObject({ clientIp: null });
  });

  it('texts at most five hundred codes a day for the whole service (owner decision 2026-10-18)', async () => {
    // Five hundred sends of many accounts, ten minutes' worth apart from the oldest, which is
    // 23 h 55 min old.
    const senders = await Promise.all(
      Array.from({ length: 50 }, async () => (await createUser(t.db)).user),
    );
    for (const [index, sender] of senders.entries()) {
      await pastSends(sender.id, `0105555${String(index).padStart(4, '0')}`, 10, 2 * 60_000, {
        stepMs: 1_000,
      });
    }
    const [oldest] = senders;
    await t.db
      .update(schema.phoneVerificationCodes)
      .set({
        sentAt: new Date(Date.now() - DAY_MS + 5 * 60_000),
        expiresAt: new Date(Date.now() - DAY_MS + 8 * 60_000),
      })
      .where(eq(schema.phoneVerificationCodes.userId, oldest!.id));
    const limited = limitOf(await request(user));
    expect(limited.reason).toBe('service_daily');
    // Until the newest of the oldest account's ten leaves: the 500th newest send of the service,
    // in whole minutes.
    expect(wholeMinutesFrom(limited.retryAfterSeconds, 5), String(limited.retryAfterSeconds)).toBe(
      true,
    );
    expect(t.sms.messages).toEqual([]);
    // One send leaves the window: one more may go.
    await t.db
      .delete(schema.phoneVerificationCodes)
      .where(eq(schema.phoneVerificationCodes.id, (await codeRows(oldest!.id))[0]!.id));
    expect((await request(user)).statusCode).toBe(200);
    const other = await signUpTestUser(t);
    expect(limitOf(await request(other, { phone: '01077778888' })).reason).toBe('service_daily');
  });

  it('counts a send the provider refused for nothing, and that code cannot be confirmed (AC 1)', async () => {
    // Other accounts' sends to the same number: forgetting the refused send must not forget them.
    const { user: bystander } = await createUser(t.db);
    await pastSends(bystander.id, PHONE, 3, 2 * 60_000);
    // Refusals of nine and of seven days ago: the older is past the eight days kept.
    const now = Date.now();
    await t.db
      .insert(schema.phoneVerificationRefusedSends)
      .values([
        { attemptedAt: new Date(now - 9 * DAY_MS) },
        { attemptedAt: new Date(now - 7 * DAY_MS) },
      ]);
    t.sms.failNext(1, 'refused');
    const failed = await request(user);
    expect(refusal(failed, 502, 'SMS_SEND_FAILED')).toBeUndefined();
    // A 5xx carries no message of its own (ADR-0020), and certainly not the number.
    expect(failed.body).not.toContain(PHONE);
    expect(await codeRows(user.id)).toEqual([]);
    expect(await codeRows(bystander.id)).toHaveLength(3);
    // Its time alone is counted for the admin's send status (second round), and the refusal of
    // nine days ago went with it.
    const refused = await refusedRows();
    expect(refused.map((row) => row.attemptedAt.getTime())).toEqual([
      now - 7 * DAY_MS,
      expect.any(Number) as number,
    ]);
    expect(Math.abs(refused[1]!.attemptedAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(t.sms.messages).toEqual([]);
    expect(refusal(await confirm(user, '123456'), 409, 'VERIFICATION_CODE_REJECTED')).toEqual({
      reason: 'no_code',
    });
    // No interval to wait out: nothing was sent.
    expect((await request(user)).statusCode).toBe(200);
    expect((await confirm(user, t.sms.lastCodeTo(PHONE))).statusCode).toBe(200);
  });

  it('deletes the old refusals only when a refusal is recorded: a spell without one keeps them', async () => {
    // A refusal of nine days ago, past the eight days kept — from before the provider's keys
    // worked, say.
    const now = Date.now();
    await t.db
      .insert(schema.phoneVerificationRefusedSends)
      .values({ attemptedAt: new Date(now - 9 * DAY_MS) });
    // A send the provider takes and one whose answer was lost: neither deletes it.
    expect((await request(user)).statusCode).toBe(200);
    const other = await signUpTestUser(t);
    t.sms.failNext(1, 'unknown');
    refusal(await request(other, { phone: '01077778888' }), 502, 'SMS_SEND_UNCONFIRMED');
    expect((await refusedRows()).map((row) => row.attemptedAt.getTime())).toEqual([
      now - 9 * DAY_MS,
    ]);
    // The next refusal does, and is the one left.
    const third = await signUpTestUser(t);
    t.sms.failNext(1, 'refused');
    refusal(await request(third, { phone: '01099990000' }), 502, 'SMS_SEND_FAILED');
    const refused = await refusedRows();
    expect(refused).toHaveLength(1);
    expect(Math.abs(refused[0]!.attemptedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('leaves the code sent before a refused resend confirmable: only the refused send is gone', async () => {
    expect((await request(user)).statusCode).toBe(200);
    const first = t.sms.lastCodeTo(PHONE);
    const [firstRow] = await codeRows(user.id);
    await age(user.id, 61_000);
    // The resend, a minute later, refused by the provider: SMS_SEND_FAILED, and this send left no
    // code — but the first, still within its three minutes, is the newest code again.
    t.sms.failNext(1, 'refused');
    refusal(await request(user), 502, 'SMS_SEND_FAILED');
    expect(await codeRows(user.id)).toMatchObject([{ id: firstRow!.id, attempts: 0 }]);
    expect(t.sms.messages).toHaveLength(1);
    expect((await confirm(user, first)).statusCode).toBe(200);
  });

  it('keeps a send whose outcome is unknown and says so: counted, and its code confirmable (owner decision 2026-10-18)', async () => {
    // The provider took the text and its answer was lost (a timeout): the phone holds the code.
    // Its own code, so the screen can say the text may have come (a 5xx carries no details).
    t.sms.failNext(1, 'unknown');
    const failed = await request(user);
    expect(refusal(failed, 502, 'SMS_SEND_UNCONFIRMED')).toBeUndefined();
    expect(failed.body).not.toContain(PHONE);
    // Kept as a send whose outcome nobody knows (the admin's send status counts it so), and not
    // as a refusal.
    expect(await codeRows(user.id)).toMatchObject([
      { phone: PHONE, attempts: 0, consumedAt: null, sendOutcome: 'unknown' },
    ]);
    expect(await refusedRows()).toEqual([]);

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

  it('counts unknown-outcome sends towards the ten a day of the account', async () => {
    // Nine past sends of the account to this number; the tenth fails with an unknown outcome.
    await pastSends(user.id, PHONE, 9, 2 * 60_000);
    t.sms.failNext(1, 'unknown');
    refusal(await request(user), 502, 'SMS_SEND_UNCONFIRMED');
    expect(await codeRows(user.id)).toHaveLength(10);
    expect(limitOf(await request(user, { phone: '01077778888' })).reason).toBe('account_daily');
    // Another account at the same number is a pair of its own (owner decision 2026-10-18).
    const other = await signUpTestUser(t);
    expect((await request(other)).statusCode).toBe(200);
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

  // ---- concurrency: the account's lock and the service's send lock -------------------------

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

  it('texts a number for only its third account when two accounts ask at once (send lock)', async () => {
    for (let i = 0; i < 2; i += 1) {
      const { user: past } = await createUser(t.db);
      await pastSends(past.id, PHONE, 1, 2 * 60_000 + i * 60_000);
    }
    const other = await signUpTestUser(t);
    const answers = await Promise.all([request(user), request(other)]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 429]);
    expect(limitOf(answers.find((res) => res.statusCode === 429)!).reason).toBe('phone_accounts');
    expect(
      await t.db
        .select()
        .from(schema.phoneVerificationCodes)
        .where(eq(schema.phoneVerificationCodes.phone, PHONE)),
    ).toHaveLength(3);
    expect(t.sms.messages).toHaveLength(1);
  });

  it('texts the service’s five hundredth code once when two accounts ask at once (send lock)', async () => {
    const senders = await Promise.all(
      Array.from({ length: 50 }, async () => (await createUser(t.db)).user),
    );
    for (const [index, sender] of senders.entries()) {
      const count = index === 0 ? 9 : 10;
      await pastSends(sender.id, `0105555${String(index).padStart(4, '0')}`, count, 2 * 60_000, {
        stepMs: 1_000,
      });
    }
    const other = await signUpTestUser(t);
    const answers = await Promise.all([request(user), request(other, { phone: '01077778888' })]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 429]);
    expect(limitOf(answers.find((res) => res.statusCode === 429)!).reason).toBe('service_daily');
    expect(await codeRows()).toHaveLength(500);
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
