/**
 * 가입 허용 목록 over HTTP (#330, ADR-0174; owner answers 330-1…330-12), against the docker `test`
 * profile with the in-memory SMS sender:
 *
 * - the admins' list: one admin adds numbers (one bad line refuses them all, one on the list
 *   already is skipped) and removes one, each with a reason recorded in the same transaction, the
 *   records naming entry ids and counts and never a number (330-1, 330-8); the last entry is never
 *   removed one by one, and two removals of the last two at once leave one (I2); emptying the list
 *   is a request another admin approves — deleting every entry in the same transaction — or
 *   rejects, or its requester retracts (330-2, 330-4); the summary #149 reads (330-9);
 * - the confirmation: a number off a non-empty list is refused after its code matched and the
 *   number was found free (`not_listed`, 330-5), writing nothing, for an account an email sign-up
 *   made and one a social sign-in made alike (133-7); a listed one passes through the nickname
 *   step to the start Coin; an empty list refuses nobody (330-3); the send is answered the same
 *   whatever the list holds, and the refusals before it (`mismatch`, `phone_in_use`) are as they
 *   were; an account that verified before is not looked at again (330-6).
 */
import { schema } from '@buddha/db';
import { completeOnboarding, createConsents, createPhoneVerification } from '@buddha/db/test';
import {
  SIGNUP_ALLOWLIST_CLEAR_CONFIRMATION,
  errorEnvelopeSchema,
  meSchema,
  phoneVerificationCodeSentSchema,
  signupAllowlistAddResultSchema,
  signupAllowlistClearWriteSchema,
  signupAllowlistSchema,
  type ErrorCode,
} from '@buddha/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const ORIGIN = 'http://localhost:3000';
const BASE = '/api/v1/admin/signup-allowlist';
const LISTED = '01055550001';
const OTHER_LISTED = '01055550002';
const UNLISTED = '01099990009';

describe.skipIf(!hasTestInfra)(
  '가입 허용 목록 /api/v1/admin/signup-allowlist (integration)',
  () => {
    let t: TestApp;
    let admin: TestUser;
    let second: TestUser;

    beforeAll(async () => {
      t = await createTestApp();
    });
    afterAll(async () => {
      await t?.close(); // undefined when beforeAll timed out waiting for the file lock
    });
    beforeEach(async () => {
      await t.reset();
      t.sms.messages.length = 0;
      admin = await makeAdmin();
      second = await makeAdmin();
    });

    async function makeAdmin(): Promise<TestUser> {
      const who = await signUpTestUser(t);
      await t.db
        .update(schema.profiles)
        .set({ role: 'admin' })
        .where(eq(schema.profiles.userId, who.id));
      await completeOnboarding(t.db, { userId: who.id });
      await t.app.get(AdminGuard).invalidate(who.id);
      return who;
    }

    const hash = (phone: string) => t.app.get(PhoneHasher).hash(phone);
    const post = (path: string, who: TestUser, body: Record<string, unknown> = {}) =>
      t.app.inject({
        method: 'POST',
        url: `${BASE}${path}`,
        headers: { origin: ORIGIN, cookie: who.cookie },
        payload: { expectedAccountId: who.id, ...body },
      });
    const get = (who: TestUser = admin) =>
      t.app.inject({ method: 'GET', url: BASE, headers: { cookie: who.cookie } });
    const read = async (who: TestUser = admin) => {
      const res = await get(who);
      expect(res.statusCode, res.body).toBe(200);
      return signupAllowlistSchema.parse(res.json<{ data: unknown }>().data);
    };
    async function add(phones: string[], who = admin, reason = '폐쇄 테스트 참여자') {
      const res = await post('', who, { phones, reason });
      expect(res.statusCode, res.body).toBe(201);
      return signupAllowlistAddResultSchema.parse(res.json<{ data: unknown }>().data);
    }
    const remove = (phone: string, who = admin, reason = '참여 취소') =>
      post('/remove', who, { phone, reason });
    const requestClear = (who = admin, body: Record<string, unknown> = {}) =>
      post('/clear-requests', who, {
        reason: '공개 출시',
        confirmation: SIGNUP_ALLOWLIST_CLEAR_CONFIRMATION,
        ...body,
      });
    const clearWrite = (res: LightMyRequestResponse) => {
      expect(res.statusCode, res.body).toBe(200);
      return signupAllowlistClearWriteSchema.parse(res.json<{ data: unknown }>().data);
    };
    function refusal(res: LightMyRequestResponse, status: number, code: ErrorCode) {
      expect({ status: res.statusCode, body: res.body }).toMatchObject({ status });
      const { error } = errorEnvelopeSchema.parse(res.json());
      expect(error.code).toBe(code);
      return error.details;
    }
    const rows = () => t.db.select().from(schema.signupAllowlist);
    const records = (type: string) =>
      t.db.select().from(schema.adminActions).where(eq(schema.adminActions.type, type));

    // ---- the member's side ------------------------------------------------------------------

    /** An email sign-up past the consent step, which the code request needs first (#58). */
    async function emailMember(): Promise<TestUser> {
      const account = await signUpTestUser(t);
      await createConsents(t.db, { userId: account.id });
      return account;
    }

    /**
     * An account a social sign-in made (better-auth's createOAuthUser, as Kakao's callback does —
     * auth.test.ts), past the consent step. better-auth signs it in through a password linked here,
     * the one way to hold a session for it without the provider; the account stays the social one.
     */
    async function socialMember(): Promise<TestUser> {
      const context = await t.auth.$context;
      const email = `social-${String(Date.now())}-${String(Math.random()).slice(2, 8)}@test.local`;
      const password = 'password-1234';
      const created = await context.internalAdapter.createOAuthUser(
        { email, name: 'social', emailVerified: true },
        { providerId: 'kakao', accountId: `kakao-${email}` },
      );
      await context.internalAdapter.linkAccount({
        userId: created.user.id,
        providerId: 'credential',
        accountId: created.user.id,
        password: await context.password.hash(password),
      });
      const { headers } = await t.auth.api.signInEmail({
        body: { email, password },
        returnHeaders: true,
      });
      const cookie = headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0]!)
        .join('; ');
      await createConsents(t.db, { userId: created.user.id });
      return { id: created.user.id, email, password, cookie };
    }

    const me = (path: string, as: TestUser, body: Record<string, unknown>) =>
      t.app.inject({
        method: 'POST',
        url: `/api/v1/me/${path}`,
        headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: as.cookie },
        payload: JSON.stringify({ expectedAccountId: as.id, ...body }),
      });
    const sendCode = (as: TestUser, phone: string) =>
      me('phone-verification/code', as, { realName: '홍길동', phone });
    const confirm = (as: TestUser, code: string) => me('phone-verification/confirm', as, { code });
    async function codeFor(as: TestUser, phone: string): Promise<string> {
      const sent = await sendCode(as, phone);
      expect(sent.statusCode, sent.body).toBe(200);
      return t.sms.lastCodeTo(phone);
    }
    const verified = (userId: string) =>
      t.db
        .select()
        .from(schema.phoneVerifications)
        .where(eq(schema.phoneVerifications.userId, userId));
    const codesOf = (userId: string) =>
      t.db
        .select()
        .from(schema.phoneVerificationCodes)
        .where(eq(schema.phoneVerificationCodes.userId, userId));

    describe('the confirmation (330-5)', () => {
      for (const [path, member] of [
        ['an email sign-up', emailMember],
        ['a social sign-in', socialMember],
      ] as const) {
        it(`refuses ${path} on a number off the list after the code matched, writing nothing`, async () => {
          await add([LISTED]);
          const account = await member();
          const code = await codeFor(account, UNLISTED);
          const first = await confirm(account, code);
          expect(refusal(first, 409, 'PHONE_VERIFICATION_NOT_ALLOWED')).toEqual({
            reason: 'not_listed',
          });
          // Nothing written: no record, the code neither consumed nor counted — the same code
          // answers the same.
          expect(await verified(account.id)).toEqual([]);
          expect(await codesOf(account.id)).toMatchObject([{ consumedAt: null, attempts: 0 }]);
          expect(
            refusal(await confirm(account, code), 409, 'PHONE_VERIFICATION_NOT_ALLOWED'),
          ).toEqual({ reason: 'not_listed' });
          // The gates still see an account to onboard: the nickname step waits for the 본인확인.
          const nickname = await me('onboarding/nickname', account, { nickname: 'notlisted' });
          expect(refusal(nickname, 409, 'ONBOARDING_REQUIRED')).toMatchObject({
            steps: expect.arrayContaining(['verification']) as unknown,
          });
          // Once the number is on the list, the same code passes.
          await add([UNLISTED]);
          expect((await confirm(account, code)).statusCode).toBe(200);
        });

        it(`lets ${path} on a listed number through the nickname step to the start Coin`, async () => {
          await add([LISTED]);
          const account = await member();
          const res = await confirm(account, await codeFor(account, LISTED));
          expect(res.statusCode, res.body).toBe(200);
          expect(await verified(account.id)).toMatchObject([{ phone: LISTED }]);
          const named = await me('onboarding/nickname', account, {
            nickname: `listed${String(Date.now()).slice(-4)}`,
          });
          expect(named.statusCode, named.body).toBe(200);
          const read = meSchema.parse(named.json<{ data: unknown }>().data);
          expect(read.startGrant).not.toBeNull();
          // The entry stays: signing up neither removes nor marks it (I4).
          expect(await rows()).toHaveLength(1);
        });
      }

      it('refuses nobody while the list is empty (330-3)', async () => {
        const account = await emailMember();
        expect((await confirm(account, await codeFor(account, UNLISTED))).statusCode).toBe(200);
      });

      it('answers a send the same whatever the list holds, and the refusals before it as before', async () => {
        await add([LISTED]);
        const listed = await emailMember();
        const unlisted = await emailMember();
        const shape = (res: LightMyRequestResponse) => {
          expect(res.statusCode, res.body).toBe(200);
          return Object.keys(
            phoneVerificationCodeSentSchema.parse(res.json<{ data: unknown }>().data),
          );
        };
        expect(shape(await sendCode(listed, LISTED))).toEqual(
          shape(await sendCode(unlisted, UNLISTED)),
        );
        // A wrong code is `mismatch`, listed or not: nothing about the list before the code matched.
        const wrong = (code: string) => (code === '000000' ? '000001' : '000000');
        expect(
          refusal(
            await confirm(unlisted, wrong(t.sms.lastCodeTo(UNLISTED))),
            409,
            'VERIFICATION_CODE_REJECTED',
          ),
        ).toMatchObject({ reason: 'mismatch' });
        // A number another account verified is `phone_in_use`, on the list or off it.
        const holder = await emailMember();
        await createPhoneVerification(t.db, { userId: holder.id, phone: OTHER_LISTED });
        await createPhoneVerification(t.db, {
          userId: (await emailMember()).id,
          phone: '01099990008',
        });
        await add([OTHER_LISTED]);
        const onList = await emailMember();
        expect(
          refusal(
            await confirm(onList, await codeFor(onList, OTHER_LISTED)),
            409,
            'PHONE_VERIFICATION_NOT_ALLOWED',
          ),
        ).toEqual({ reason: 'phone_in_use' });
        const offList = await emailMember();
        expect(
          refusal(
            await confirm(offList, await codeFor(offList, '01099990008')),
            409,
            'PHONE_VERIFICATION_NOT_ALLOWED',
          ),
        ).toEqual({ reason: 'phone_in_use' });
      });

      it('leaves an account that verified before as it is when its number is not on the list (330-6)', async () => {
        const before = await emailMember();
        expect((await confirm(before, await codeFor(before, UNLISTED))).statusCode).toBe(200);
        await add([LISTED]);
        expect(await verified(before.id)).toMatchObject([{ phone: UNLISTED }]);
        const res = await t.app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { cookie: before.cookie },
        });
        expect(meSchema.parse(res.json<{ data: unknown }>().data).verification).toMatchObject({
          phone: UNLISTED,
        });
      });
    });

    // ---- the admins' side -------------------------------------------------------------------

    describe('the admins’ list (330-1, 330-8)', () => {
      it('adds numbers with a reason, skipping those on it, and records ids and counts, never a number', async () => {
        const first = await add(['010-5555-0001', '010 5555 0002', '01055550001']);
        expect(first).toMatchObject({ addedCount: 2, skippedCount: 1 });
        expect(first.allowlist.summary.entryCount).toBe(2);
        expect(first.allowlist.entries.map((entry) => Object.keys(entry).sort())).toEqual([
          ['createdAt', 'id'],
          ['createdAt', 'id'],
        ]);
        const again = await add([LISTED, '01055550003'], second, '추가 참여자');
        expect(again).toMatchObject({ addedCount: 1, skippedCount: 1 });
        expect((await rows()).map((row) => row.phoneHash).sort()).toEqual(
          [LISTED, OTHER_LISTED, '01055550003'].map(hash).sort(),
        );
        const recorded = await records('signup_allowlist_add');
        expect(recorded).toHaveLength(2);
        expect(recorded.find((row) => row.adminId === admin.id)).toMatchObject({
          targetType: 'signup_allowlist',
          targetId: null,
          payload: {
            entryIds: expect.arrayContaining(first.allowlist.entries.map((e) => e.id)) as unknown,
            addedCount: 2,
            skippedCount: 1,
            reason: '폐쇄 테스트 참여자',
          },
        });
        // Neither the digits nor the hashes are in any record.
        const text = JSON.stringify(recorded);
        for (const phone of [LISTED, OTHER_LISTED, '5555-0001']) expect(text).not.toContain(phone);
        for (const row of await rows()) expect(text).not.toContain(row.phoneHash);
      });

      it('refuses the whole add for one bad number, naming its index, and a missing reason', async () => {
        const res = await post('', admin, { phones: [LISTED, '02-123-4567'], reason: '참여자' });
        expect(refusal(res, 400, 'VALIDATION_ERROR')).toEqual([
          expect.objectContaining({ path: ['phones', 1] }),
        ]);
        refusal(await post('', admin, { phones: [LISTED], reason: ' ' }), 400, 'VALIDATION_ERROR');
        refusal(await post('', admin, { phones: [], reason: '참여자' }), 400, 'VALIDATION_ERROR');
        expect(await rows()).toEqual([]);
        expect(await records('signup_allowlist_add')).toEqual([]);
      });

      it('removes one number with a reason, never the last one, and a number not on it is not found', async () => {
        await add([LISTED, OTHER_LISTED]);
        refusal(await remove(UNLISTED), 404, 'NOT_FOUND');
        const [entry] = await t.db
          .select()
          .from(schema.signupAllowlist)
          .where(eq(schema.signupAllowlist.phoneHash, hash(LISTED)));
        const res = await remove('010-5555-0001');
        expect(res.statusCode, res.body).toBe(200);
        expect(
          signupAllowlistSchema.parse(res.json<{ data: unknown }>().data).summary,
        ).toMatchObject({ entryCount: 1 });
        expect(await records('signup_allowlist_remove')).toMatchObject([
          { adminId: admin.id, targetId: entry!.id, payload: { reason: '참여 취소' } },
        ]);
        expect(refusal(await remove(OTHER_LISTED), 409, 'SIGNUP_ALLOWLIST_NOT_ALLOWED')).toEqual({
          reason: 'last_entry',
        });
        expect(await rows()).toHaveLength(1);
        expect(await records('signup_allowlist_remove')).toHaveLength(1);
      });

      it('leaves one entry when the last two are removed at once (I2)', async () => {
        await add([LISTED, OTHER_LISTED]);
        const answers = await Promise.all([remove(LISTED), remove(OTHER_LISTED, second)]);
        expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
        expect(await rows()).toHaveLength(1);
      });

      it('counts the open accounts verified off the list, members and admins apart (330-9)', async () => {
        // Both admins verified at their onboarding (completeOnboarding: a random number each), off
        // the list; one member on it, one off it.
        const [adminRecord] = await verified(admin.id);
        const onList = await emailMember();
        await createPhoneVerification(t.db, { userId: onList.id, phone: LISTED });
        const offList = await emailMember();
        await createPhoneVerification(t.db, { userId: offList.id, phone: UNLISTED });
        expect((await read()).summary).toEqual({
          entryCount: 0,
          outsideVerifiedMembers: 2,
          outsideVerifiedAdmins: 2,
        });
        await add([LISTED, adminRecord!.phone]);
        expect((await read()).summary).toEqual({
          entryCount: 2,
          outsideVerifiedMembers: 1,
          outsideVerifiedAdmins: 1,
        });
      });
    });

    describe('the clear (330-2, 330-4)', () => {
      it('empties the list once another admin approves, and records both steps', async () => {
        await add([LISTED, OTHER_LISTED]);
        const asked = clearWrite(await requestClear());
        expect(asked.request).toMatchObject({
          status: 'pending',
          requestedBy: { id: admin.id },
          reason: '공개 출시',
        });
        expect(asked.allowlist.pendingClear?.id).toBe(asked.request.id);
        expect(await rows()).toHaveLength(2);
        // Its requester decides nothing of it.
        expect(
          refusal(
            await post(`/clear-requests/${asked.request.id}/approve`, admin, { reason: '승인' }),
            409,
            'APPROVAL_NOT_ALLOWED',
          ),
        ).toEqual([{ path: ['request'], message: 'requester' }]);
        const done = clearWrite(
          await post(`/clear-requests/${asked.request.id}/approve`, second, { reason: '승인' }),
        );
        expect(done.request).toMatchObject({ status: 'approved', decidedBy: { id: second.id } });
        expect(done.allowlist).toMatchObject({
          entries: [],
          summary: { entryCount: 0 },
          pendingClear: null,
        });
        expect(await rows()).toEqual([]);
        expect(await records('signup_allowlist_clear_request')).toMatchObject([
          {
            adminId: admin.id,
            payload: { approvalId: asked.request.id, entryCount: 2, reason: '공개 출시' },
          },
        ]);
        expect(await records('signup_allowlist_clear_approve')).toMatchObject([
          {
            adminId: second.id,
            payload: { approvalId: asked.request.id, entryCount: 2, reason: '승인' },
          },
        ]);
        // Public launch: anyone verifies again.
        const account = await emailMember();
        expect((await confirm(account, await codeFor(account, UNLISTED))).statusCode).toBe(200);
      });

      it('keeps the list on a rejection or a retraction, one request waiting at a time', async () => {
        await add([LISTED]);
        const asked = clearWrite(await requestClear());
        expect(refusal(await requestClear(second), 409, 'SIGNUP_ALLOWLIST_NOT_ALLOWED')).toEqual({
          reason: 'clear_pending',
        });
        const rejected = clearWrite(
          await post(`/clear-requests/${asked.request.id}/reject`, second, {
            reason: '아직 이르다',
          }),
        );
        expect(rejected.request).toMatchObject({
          status: 'rejected',
          decisionReason: '아직 이르다',
        });
        expect(rejected.allowlist.pendingClear).toBeNull();
        const again = clearWrite(await requestClear());
        // Only its requester retracts it.
        refusal(
          await post(`/clear-requests/${again.request.id}/retract`, second),
          409,
          'APPROVAL_NOT_ALLOWED',
        );
        const retracted = clearWrite(
          await post(`/clear-requests/${again.request.id}/retract`, admin),
        );
        expect(retracted.request.status).toBe('retracted');
        expect(await rows()).toHaveLength(1);
        expect(await records('signup_allowlist_clear_reject')).toMatchObject([
          { adminId: second.id, payload: { approvalId: asked.request.id, reason: '아직 이르다' } },
        ]);
        expect(await records('signup_allowlist_clear_retract')).toMatchObject([
          { adminId: admin.id, payload: { approvalId: again.request.id } },
        ]);
      });

      it('refuses a clear of an empty list, without the confirmation, and with no other admin', async () => {
        expect(refusal(await requestClear(), 409, 'SIGNUP_ALLOWLIST_NOT_ALLOWED')).toEqual({
          reason: 'empty',
        });
        await add([LISTED]);
        refusal(await requestClear(admin, { confirmation: '비우기' }), 400, 'VALIDATION_ERROR');
        await t.db
          .update(schema.profiles)
          .set({ role: 'user' })
          .where(eq(schema.profiles.userId, second.id));
        await t.app.get(AdminGuard).invalidate(second.id);
        expect(refusal(await requestClear(), 409, 'APPROVAL_NOT_ALLOWED')).toEqual([
          { path: ['request'], message: 'no_decider' },
        ]);
        expect(await t.db.select().from(schema.approvalRequests)).toEqual([]);
      });

      it('decides only its own kind of request', async () => {
        await add([LISTED]);
        const [other] = await t.db
          .insert(schema.approvalRequests)
          .values({
            kind: 'treasury_issue',
            requestedBy: admin.id,
            requestReason: '다른 요청',
            requestedAt: new Date(),
          })
          .returning();
        refusal(
          await post(`/clear-requests/${other!.id}/approve`, second, { reason: '승인' }),
          404,
          'NOT_FOUND',
        );
        expect(
          await t.db
            .select()
            .from(schema.approvalRequests)
            .where(
              and(
                eq(schema.approvalRequests.id, other!.id),
                inArray(schema.approvalRequests.status, ['pending']),
              ),
            ),
        ).toHaveLength(1);
        expect(await rows()).toHaveLength(1);
      });
    });

    describe('who may (ADR-0072, ADR-0092)', () => {
      it('refuses a member (403) and nobody signed in (401), every route', async () => {
        const member = await emailMember();
        refusal(await get(member), 403, 'FORBIDDEN');
        refusal(await post('', member, { phones: [LISTED], reason: 'x' }), 403, 'FORBIDDEN');
        const anonymous = await t.app.inject({ method: 'GET', url: BASE });
        refusal(anonymous, 401, 'UNAUTHENTICATED');
        expect(await rows()).toEqual([]);
      });

      it('refuses a write naming another admin than the cookie’s', async () => {
        const res = await t.app.inject({
          method: 'POST',
          url: BASE,
          headers: { origin: ORIGIN, cookie: admin.cookie },
          payload: { expectedAccountId: second.id, phones: [LISTED], reason: '참여자' },
        });
        refusal(res, 403, 'FORBIDDEN');
        expect(await rows()).toEqual([]);
      });
    });
  },
);
