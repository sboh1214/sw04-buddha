/**
 * 가입 직후 온보딩 over HTTP (#58, ADR-0069 decision 1 #57-4~#57-10 and decision 4 #58), against
 * the docker `test` profile: the consent step and its record, the order the server holds (consent →
 * 본인확인 → nickname, then the interests), the nickname rules in the onboarding and in MY 설정
 * (ignoring case, the prefix and the reserved words, the 30-day interval and hold), the start Coin
 * granted once by the nickname step only, and the interest categories with their skip.
 *
 * The app trusts one proxy (Caddy's address in production) and lists one uncounted peer (the web
 * server's), so a consent can name a client the way production's do: `inject` presents loopback
 * unless a test gives `remoteAddress`.
 */
import { randomUUID } from 'node:crypto';
import { cancelStartGrant, schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createConsents,
  createPhoneVerification,
  createStartGrant,
  createUser,
} from '@buddha/db/test';
import {
  CONSENT_ITEMS,
  CONSENT_USER_AGENT_MAX_LENGTH,
  START_COIN_SETTING,
  currentConsentVersion,
  errorEnvelopeSchema,
  meSchema,
  nicknameNotAllowedDetailsSchema,
  onboardingRequiredDetailsSchema,
  userChannel,
  type ErrorCode,
  type Me,
  type ValidationIssue,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { type LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PhoneHasher } from '../identity/phone-hash.js';
import { ReleaseSettingsService } from '../release-settings/release-settings.service.js';
import { expectLedgerChain } from '../test/ledger.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForLockWaiter } from '../test/wait.js';

const ORIGIN = 'http://localhost:3000';
/** Caddy and the web server in deploy/compose.yaml: the trusted proxy and the uncounted peer. */
const PROXY = '172.28.0.10';
const WEB = '172.28.0.20';
/** A visitor's address (documentation ranges, RFC 5737). */
const VISITOR = '203.0.113.7';
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';
const DAY_MS = 24 * 60 * 60 * 1_000;

/** The consent step as the screen sends it: every item at its current version. */
function consentBody(expectedAccountId: string, marketing = false, overrides = {}) {
  return {
    consents: {
      ...Object.fromEntries(
        CONSENT_ITEMS.map((item) => [
          item,
          { version: currentConsentVersion(item), agreed: item === 'marketing' ? marketing : true },
        ]),
      ),
      ...overrides,
    },
    expectedAccountId,
  };
}

describe.skipIf(!hasTestInfra)('온보딩 /api/v1/me (integration, #58)', () => {
  let t: TestApp;
  let user: TestUser;
  let operator: string;

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
    // The admin whose changes of the release setting are recorded (release_settings.updated_by).
    operator = (await createUser(t.db, { role: 'admin' })).user.id;
  });

  const call = (
    method: 'POST' | 'PUT' | 'PATCH',
    url: string,
    as: TestUser,
    payload: unknown,
    headers: Record<string, string> = {},
    remoteAddress?: string,
  ) =>
    t.app.inject({
      method,
      url: `/api/v1/me/${url}`,
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: as.cookie,
        ...headers,
      },
      payload: JSON.stringify(payload),
    });
  const consent = (as: TestUser, body: unknown = consentBody(as.id), headers = {}, from?: string) =>
    call('POST', 'consents', as, body, headers, from);
  const setNickname = (as: TestUser, nickname: string, body: Record<string, unknown> = {}) =>
    call('POST', 'onboarding/nickname', as, { nickname, expectedAccountId: as.id, ...body });
  const changeNickname = (as: TestUser, nickname: string) =>
    t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: as.cookie },
      payload: JSON.stringify({ nickname, expectedAccountId: as.id }),
    });
  const setInterests = (as: TestUser, categoryIds: unknown, body: Record<string, unknown> = {}) =>
    call('PUT', 'interest-categories', as, { categoryIds, expectedAccountId: as.id, ...body });

  const getMe = async (as: TestUser): Promise<Me> => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: as.cookie },
    });
    expect(res.statusCode).toBe(200);
    return meSchema.parse(res.json<{ data: unknown }>().data);
  };
  const meOf = (res: LightMyRequestResponse): Me => {
    expect(res.statusCode, res.body).toBe(200);
    return meSchema.parse(res.json<{ data: unknown }>().data);
  };
  /** The refusal's code and details, after checking its status. */
  function refusal(res: LightMyRequestResponse, status: number, code: ErrorCode) {
    expect(res.statusCode, res.body).toBe(status);
    const { error } = errorEnvelopeSchema.parse(res.json());
    expect(error.code).toBe(code);
    return error.details;
  }
  const stepsOf = (res: LightMyRequestResponse) =>
    onboardingRequiredDetailsSchema.parse(refusal(res, 409, 'ONBOARDING_REQUIRED')).steps;
  const nicknameRefusal = (res: LightMyRequestResponse) =>
    nicknameNotAllowedDetailsSchema.parse(refusal(res, 409, 'NICKNAME_NOT_ALLOWED'));

  const consentRows = (userId: string) =>
    t.db
      .select()
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, userId))
      .orderBy(asc(schema.consentRecords.id));
  const nicknameOf = async (userId: string) => {
    const [row] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return row!.nickname;
  };
  const holds = () =>
    t.db
      .select({ nickname: schema.nicknameHolds.nickname, userId: schema.nicknameHolds.userId })
      .from(schema.nicknameHolds)
      .orderBy(asc(schema.nicknameHolds.id));
  const ledgerOf = (userId: string) =>
    t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId))
      .orderBy(asc(schema.ledgerEntries.id));

  /** The release setting `grant.start_coin`, changed as an admin does it, with a reason. */
  async function setAmount(value: number) {
    await t.app
      .get(ReleaseSettingsService)
      .change(operator, START_COIN_SETTING.key, { status: 'test', value, reason: '시험' });
  }

  /** An account past the consent and the 본인확인, at the nickname step. */
  async function atNicknameStep(as: TestUser = user, phone?: string) {
    await createConsents(t.db, { userId: as.id });
    await createPhoneVerification(t.db, { userId: as.id, ...(phone ? { phone } : {}) });
  }

  /**
   * The realtime messages published to the account's channel while `run` runs and `settleMs`
   * after (a subscription on the test Redis, as the realtime gateway would hold one), parsed.
   */
  async function published(userId: string, run: () => Promise<void>, settleMs = 300) {
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => received.push(message));
    try {
      await subscriber.subscribe(userChannel(userId));
      await run();
      await sleep(settleMs);
    } finally {
      await subscriber.quit();
    }
    return received.map((message) => JSON.parse(message) as unknown);
  }

  /** Sets a nickname straight in the table, as an account could have before #58's rules. */
  async function setStoredNickname(userId: string, nickname: string) {
    await t.db.update(schema.profiles).set({ nickname }).where(eq(schema.profiles.userId, userId));
  }

  // ---- the consent step ---------------------------------------------------------------------

  describe('the consent step (#57-4·#57-5)', () => {
    it('records each item at its version, with the time, the visitor’s address and browser', async () => {
      const me = meOf(
        await consent(
          user,
          consentBody(user.id, true),
          {
            'user-agent': BROWSER,
            'x-forwarded-for': VISITOR,
          },
          PROXY,
        ),
      );
      const rows = await consentRows(user.id);
      expect(rows.map((row) => [row.item, row.version, row.agreed])).toEqual(
        CONSENT_ITEMS.map((item) => [item, currentConsentVersion(item), true]),
      );
      for (const row of rows) {
        expect(row).toMatchObject({ clientIp: VISITOR, userAgent: BROWSER });
        expect(Date.now() - row.createdAt.getTime()).toBeLessThan(60_000);
      }
      // The answer: the consent step done, the 본인확인 next; the newest answers without the
      // address or the browser.
      expect(me.onboarding).toMatchObject({
        consent: true,
        verification: false,
        nickname: false,
        completed: false,
        nextStep: 'verification',
      });
      expect(me.onboarding.consents).toEqual(
        rows.map((row) => ({
          item: row.item,
          version: row.version,
          agreed: true,
          recordedAt: row.createdAt.toISOString(),
        })),
      );
      expect(JSON.stringify(me)).not.toContain(VISITOR);
      expect(JSON.stringify(me)).not.toContain('iPhone');
    });

    it('records no address behind loopback or the web server, and cuts a long User-Agent', async () => {
      meOf(await consent(user, consentBody(user.id), { 'user-agent': 'x'.repeat(2_000) }));
      expect((await consentRows(user.id)).map((row) => [row.clientIp, row.userAgent])).toEqual(
        CONSENT_ITEMS.map(() => [null, 'x'.repeat(CONSENT_USER_AGENT_MAX_LENGTH)]),
      );
      const other = await signUpTestUser(t);
      meOf(await consent(other, consentBody(other.id), {}, WEB));
      expect((await consentRows(other.id)).map((row) => row.clientIp)).toEqual(
        CONSENT_ITEMS.map(() => null),
      );
    });

    it('writes an answer again only when it changed, keeping the old one (the history)', async () => {
      meOf(await consent(user, consentBody(user.id, false)));
      meOf(await consent(user, consentBody(user.id, false)));
      expect(await consentRows(user.id)).toHaveLength(CONSENT_ITEMS.length);
      const me = meOf(await consent(user, consentBody(user.id, true)));
      const rows = await consentRows(user.id);
      expect(rows.map((row) => [row.item, row.agreed])).toEqual([
        ...CONSENT_ITEMS.map((item) => [item, item !== 'marketing']),
        ['marketing', true],
      ]);
      expect(me.onboarding.consents.find((c) => c.item === 'marketing')?.agreed).toBe(true);
    });

    it('refuses a required item unchecked, a version not current or an item left out, recording nothing', async () => {
      for (const item of ['terms', 'privacy', 'age'] as const) {
        const res = await consent(
          user,
          consentBody(user.id, true, {
            [item]: { version: currentConsentVersion(item), agreed: false },
          }),
        );
        const details = refusal(res, 400, 'VALIDATION_ERROR') as ValidationIssue[];
        expect(details.map((issue) => issue.path)).toEqual([['consents', item, 'agreed']]);
      }
      const stale = await consent(
        user,
        consentBody(user.id, true, { terms: { version: 'draft-1999-01-01', agreed: true } }),
      );
      expect(
        (refusal(stale, 400, 'VALIDATION_ERROR') as ValidationIssue[]).map((issue) => issue.path),
      ).toEqual([['consents', 'terms', 'version']]);
      expect(await consentRows(user.id)).toEqual([]);
      expect((await getMe(user)).onboarding.nextStep).toBe('consent');
      // The first consent step asks every item: one left out — the optional one too — is named.
      // Another account: the `consent` bucket allows five a minute.
      const other = await signUpTestUser(t);
      const { consents } = consentBody(other.id);
      const { marketing: _left, ...partial } = consents as Record<string, unknown>;
      expect(
        (
          refusal(
            await consent(other, { consents: partial, expectedAccountId: other.id }),
            400,
            'VALIDATION_ERROR',
          ) as ValidationIssue[]
        ).map((issue) => issue.path),
      ).toEqual([['consents', 'marketing']]);
      refusal(
        await consent(other, { consents: {}, expectedAccountId: other.id }),
        400,
        'VALIDATION_ERROR',
      );
      expect(await consentRows(other.id)).toEqual([]);
    });

    it('asks a re-consent only the items a revision left behind, keeping the marketing answer', async () => {
      // 오너 결정 2026-10-19 (2차) 1. An onboarded account that agreed to the marketing too, whose
      // terms agreement a revision that changed members' rights left behind (a version the list no
      // longer holds reads the same).
      await completeOnboarding(t.db, { userId: user.id, interests: true });
      await t.db.delete(schema.consentRecords).where(eq(schema.consentRecords.userId, user.id));
      await createConsents(t.db, {
        userId: user.id,
        marketing: true,
        versions: { terms: 'draft-1999-01-01' },
      });
      const before = await consentRows(user.id);
      expect((await getMe(user)).onboarding.nextStep).toBe('consent');
      // Without the terms: refused, naming them only.
      const withoutTerms = await consent(user, {
        consents: { privacy: { version: currentConsentVersion('privacy'), agreed: true } },
        expectedAccountId: user.id,
      });
      expect(
        (refusal(withoutTerms, 400, 'VALIDATION_ERROR') as ValidationIssue[]).map(
          (issue) => issue.path,
        ),
      ).toEqual([['consents', 'terms']]);
      // The terms alone: done, one new row, and the marketing opt-in stands as it was.
      const me = meOf(
        await consent(user, {
          consents: { terms: { version: currentConsentVersion('terms'), agreed: true } },
          expectedAccountId: user.id,
        }),
      );
      expect(me.onboarding).toMatchObject({ consent: true, completed: true, nextStep: null });
      expect(me.onboarding.consents.find((c) => c.item === 'marketing')?.agreed).toBe(true);
      const after = await consentRows(user.id);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length).map((row) => [row.item, row.version, row.agreed])).toEqual([
        ['terms', currentConsentVersion('terms'), true],
      ]);
    });

    it('takes the marketing answer alone at any time once the consent stands (MY 설정)', async () => {
      // 오너 결정 2026-10-19 (2차) 4: MY 설정 turns it on and off, every change a record with the
      // address and the browser.
      const marketing = (agreed: boolean) => ({
        consents: { marketing: { version: currentConsentVersion('marketing'), agreed } },
        expectedAccountId: user.id,
      });
      // Before the consent step the step's own items are named: nothing recorded.
      expect(
        (
          refusal(
            await consent(user, marketing(true)),
            400,
            'VALIDATION_ERROR',
          ) as ValidationIssue[]
        ).map((issue) => issue.path),
      ).toEqual([
        ['consents', 'terms'],
        ['consents', 'privacy'],
        ['consents', 'age'],
      ]);
      expect(await consentRows(user.id)).toEqual([]);
      meOf(await consent(user, consentBody(user.id, false)));
      const on = meOf(
        await consent(
          user,
          marketing(true),
          { 'user-agent': BROWSER, 'x-forwarded-for': VISITOR },
          PROXY,
        ),
      );
      expect(on.onboarding.consents.find((c) => c.item === 'marketing')?.agreed).toBe(true);
      meOf(await consent(user, marketing(true)));
      const off = meOf(await consent(user, marketing(false)));
      expect(off.onboarding.consents.find((c) => c.item === 'marketing')?.agreed).toBe(false);
      expect(off.onboarding.consent).toBe(true);
      const rows = await consentRows(user.id);
      expect(rows.map((row) => [row.item, row.agreed])).toEqual([
        ...CONSENT_ITEMS.map((item) => [item, item !== 'marketing']),
        ['marketing', true],
        ['marketing', false],
      ]);
      expect(rows[CONSENT_ITEMS.length]).toMatchObject({ clientIp: VISITOR, userAgent: BROWSER });
    });

    it('refuses a body naming another account, a foreign Origin and no session, recording nothing', async () => {
      const other = await signUpTestUser(t);
      const res = await consent(user, consentBody(other.id));
      expect(refusal(res, 403, 'FORBIDDEN')).toEqual([
        { path: ['expectedAccountId'], message: 'session belongs to another account' },
      ]);
      refusal(
        await consent(user, consentBody(user.id), { origin: 'https://evil.example' }),
        403,
        'FORBIDDEN',
      );
      const anonymous = await t.app.inject({
        method: 'POST',
        url: '/api/v1/me/consents',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: JSON.stringify(consentBody(user.id)),
      });
      refusal(anonymous, 401, 'UNAUTHENTICATED');
      expect(await t.db.select().from(schema.consentRecords)).toEqual([]);
    });
  });

  // ---- the order ------------------------------------------------------------------------------

  describe('the order the server holds (decision 4 #58)', () => {
    it('takes no number for the 본인확인 before the consent: nothing recorded, nobody texted', async () => {
      const request = () =>
        call('POST', 'phone-verification/code', user, {
          realName: '홍길동',
          phone: '01012345678',
          expectedAccountId: user.id,
        });
      expect(stepsOf(await request())).toEqual(['consent']);
      expect(await t.db.select().from(schema.phoneVerificationCodes)).toEqual([]);
      expect(t.sms.messages).toEqual([]);
      meOf(await consent(user));
      expect((await request()).statusCode).toBe(200);
      expect(t.sms.messages).toHaveLength(1);
    });

    it('refuses the nickname step before the consent and the 본인확인, naming what is missing', async () => {
      const nickname = await nicknameOf(user.id);
      expect(stepsOf(await setNickname(user, nickname))).toEqual(['consent', 'verification']);
      await createConsents(t.db, { userId: user.id });
      expect(stepsOf(await setNickname(user, nickname))).toEqual(['verification']);
      // The other way round too: a 본인확인 without the consent.
      const other = await signUpTestUser(t);
      await createPhoneVerification(t.db, { userId: other.id });
      expect(stepsOf(await setNickname(other, await nicknameOf(other.id)))).toEqual(['consent']);
      expect(await t.db.select().from(schema.startGrants)).toEqual([]);
      expect((await getMe(user)).onboarding.nickname).toBe(false);
    });

    it('refuses the interests before the three steps, whatever the body', async () => {
      const category = await createCategory(t.db);
      expect(stepsOf(await setInterests(user, [category.id]))).toEqual([
        'consent',
        'verification',
        'nickname',
      ]);
      await atNicknameStep();
      expect(stepsOf(await setInterests(user, 'not a list'))).toEqual(['nickname']);
      expect(await t.db.select().from(schema.profileInterestCategories)).toEqual([]);
    });

    it('sends an account whose consent no longer stands back to the consent step (#57-5)', async () => {
      // A record of a version a later revision that changed members' rights replaced reads as one
      // the list does not hold: the consent step is undone, the rest stays.
      await completeOnboarding(t.db, { userId: user.id, interests: true });
      expect((await getMe(user)).onboarding).toMatchObject({ completed: true, nextStep: null });
      await t.db.delete(schema.consentRecords).where(eq(schema.consentRecords.userId, user.id));
      await createConsents(t.db, { userId: user.id, versions: { terms: 'draft-1999-01-01' } });
      const lapsed = (await getMe(user)).onboarding;
      expect(lapsed).toMatchObject({
        consent: false,
        verification: true,
        nickname: true,
        completed: false,
        nextStep: 'consent',
      });
      const category = await createCategory(t.db);
      expect(stepsOf(await setInterests(user, [category.id]))).toEqual(['consent']);
      meOf(await consent(user));
      expect((await getMe(user)).onboarding).toMatchObject({ completed: true, nextStep: null });
      meOf(await setInterests(user, [category.id]));
    });
  });

  // ---- the nickname step and the start Coin -------------------------------------------------

  describe('the nickname step and the start Coin (#57-6, #57-10, D18)', () => {
    it('confirms the offered auto nickname as it is, not a change, and leaves the grant waiting', async () => {
      await atNicknameStep();
      const auto = await nicknameOf(user.id);
      expect(auto).toMatch(/^user_/);
      const me = meOf(await setNickname(user, auto));
      expect(me.profile.nickname).toBe(auto);
      expect(me.profile.nicknameChangeAvailableAt).toBeNull();
      expect(me.onboarding).toMatchObject({
        consent: true,
        verification: true,
        nickname: true,
        completed: true,
        interests: false,
        // The interests are shown once, after the notice, and not resumed at: nothing is next
        // (오너 결정 2026-10-19 (2차) 5).
        nextStep: null,
      });
      // The amount is undecided (decision 4 #70): the grant waits, nothing paid.
      expect(me.startGrant).toEqual({ status: 'pending', amountCoin: null, grantedAt: null });
      expect(await ledgerOf(user.id)).toEqual([]);
      expect(await holds()).toEqual([]);
    });

    it('pays the start Coin with the amount set, once, however often or at once the step is sent', async () => {
      await atNicknameStep();
      await setAmount(30_000);
      const auto = await nicknameOf(user.id);
      let answers: LightMyRequestResponse[] = [];
      const messages = await published(user.id, async () => {
        answers = await Promise.all([1, 2, 3].map(() => setNickname(user, auto)));
        expect(meOf(await setNickname(user, auto)).startGrant?.status).toBe('granted');
      });
      for (const answer of answers) {
        expect(meOf(answer).startGrant).toMatchObject({ status: 'granted', amountCoin: '30000' });
      }
      const ledger = await ledgerOf(user.id);
      expect(ledger.map((entry) => [entry.type, entry.amountCoin])).toEqual([
        ['START_GRANT', 30_000n],
      ]);
      expectLedgerChain(ledger, 30_000n);
      expect((await getMe(user)).balance.availableCoin).toBe('30000');
      // The wallet of every open tab hears of it without a reload (PLAN 8): one balance event, sent
      // after the commit by the step that paid; the steps that found it paid send nothing.
      expect(messages).toEqual([
        {
          type: 'user:balance',
          availableCoin: '30000',
          lockedCoin: '0',
          ledgerEntryId: ledger[0]!.id.toString(),
          ts: ledger[0]!.createdAt.toISOString(),
        },
      ]);
    });

    it('sends no balance event while the grant waits for its amount', async () => {
      await atNicknameStep();
      const messages = await published(user.id, async () => {
        const me = meOf(await setNickname(user, await nicknameOf(user.id)));
        expect(me.startGrant?.status).toBe('pending');
      });
      expect(messages).toEqual([]);
    });

    it('takes a nickname the member chose under the rules, and holds the auto one it gave up', async () => {
      await atNicknameStep();
      await setAmount(1_000);
      const auto = await nicknameOf(user.id);
      const me = meOf(await setNickname(user, '거래왕'));
      expect(me.profile.nickname).toBe('거래왕');
      // The onboarding's choice is not a change (#57-6).
      expect(me.profile.nicknameChangeAvailableAt).toBeNull();
      expect(me.startGrant?.status).toBe('granted');
      expect(await holds()).toEqual([{ nickname: auto, userId: user.id }]);
      // Once done, another nickname is a change for MY 설정; the same one changes nothing.
      expect(nicknameRefusal(await setNickname(user, '다른이름'))).toEqual({
        reason: 'already_set',
      });
      expect(meOf(await setNickname(user, '거래왕')).profile.nickname).toBe('거래왕');
      expect((await ledgerOf(user.id)).map((entry) => entry.type)).toEqual(['START_GRANT']);
    });

    it('refuses the prefix, a reserved word and a nickname taken in any case, granting nothing', async () => {
      const other = await signUpTestUser(t);
      await completeOnboarding(t.db, { userId: other.id });
      meOf(await changeNickname(other, 'Trader_Kim'));
      await atNicknameStep();
      for (const [nickname, reason] of [
        ['user_kim', 'auto_prefix'],
        ['USER_kim', 'auto_prefix'],
        ['공식계정', 'reserved_word'],
        ['진짜Admin', 'reserved_word'],
        ['관_리_자', 'reserved_word'],
        ['trader_kim', 'taken'],
        ['TRADER_KIM', 'taken'],
      ] as const) {
        expect(nicknameRefusal(await setNickname(user, nickname)), nickname).toEqual({ reason });
      }
      expect((await getMe(user)).onboarding.nickname).toBe(false);
      expect(await t.db.select().from(schema.startGrants)).toEqual([]);
      // The format is the schema's (VALIDATION_ERROR), before any rule.
      refusal(await setNickname(user, 'a'), 400, 'VALIDATION_ERROR');
    });

    it('completes without the start Coin when the number’s went to another account, and says so (#57-1)', async () => {
      // A withdrawn account verified this number and got its start Coin: its grant's record of the
      // number holds it for good (a grant still waiting would have been cancelled by the
      // withdrawal, freeing the number — the next test).
      const phone = '01055556666';
      const withdrawn = await signUpTestUser(t);
      await createStartGrant(t.db, {
        userId: withdrawn.id,
        phoneHash: t.app.get(PhoneHasher).hash(phone),
        amountCoin: 10_000n,
      });
      await atNicknameStep(user, phone);
      // Before the nickname step the grant was never asked for: nothing to say yet.
      expect((await getMe(user)).startGrant).toBeNull();
      await setAmount(1_000);
      let me!: Me;
      const messages = await published(user.id, async () => {
        me = meOf(await setNickname(user, await nicknameOf(user.id)));
      });
      expect(me.onboarding.completed).toBe(true);
      // What the notice screen reads (오너 결정 2026-10-19): the number already received it.
      expect(me.startGrant).toEqual({ status: 'number_used', amountCoin: null, grantedAt: null });
      expect((await getMe(user)).startGrant).toEqual(me.startGrant);
      expect(await ledgerOf(user.id)).toEqual([]);
      expect(await t.db.select().from(schema.startGrants)).toHaveLength(1);
      // Nothing paid, nothing announced.
      expect(messages).toEqual([]);
    });

    it('grants the start Coin of a number whose earlier grant was cancelled (owner decision 2026-10-18)', async () => {
      // Another account's grant held this number and was cancelled while it waited (its account
      // withdrew, `cancelStartGrant`): the number's once is unused, and is this account's now.
      const phone = '01055556666';
      const withdrawn = await signUpTestUser(t);
      await createStartGrant(t.db, {
        userId: withdrawn.id,
        phoneHash: t.app.get(PhoneHasher).hash(phone),
      });
      await t.db.transaction((tx) => cancelStartGrant(tx, withdrawn.id));
      await atNicknameStep(user, phone);
      await setAmount(1_000);
      const me = meOf(await setNickname(user, await nicknameOf(user.id)));
      expect(me.onboarding.completed).toBe(true);
      expect(me.startGrant).toMatchObject({ status: 'granted', amountCoin: '1000' });
      expect((await ledgerOf(user.id)).map((entry) => entry.type)).toEqual(['START_GRANT']);
    });

    it('says nothing of a number no grant holds, however the onboarding was completed', async () => {
      // An onboarded account with no record and a number no record holds (a test factory's
      // account; later a bot, #115) is not told its number was used — not even while another
      // account's grant holds another number.
      const other = await signUpTestUser(t);
      await createStartGrant(t.db, { userId: other.id });
      await completeOnboarding(t.db, { userId: user.id });
      const me = await getMe(user);
      expect(me.onboarding.completed).toBe(true);
      expect(me.startGrant).toBeNull();
    });

    it('holds every nickname kept from before #58 to the rules, an admin’s too, but the auto one', async () => {
      // Before #58 MY 설정 held a nickname to the format only, so an account may still have one
      // the rules now refuse. Confirmed as it is in the nickname step, it meets them (ADR-0072
      // 7-25), and the step is not done.
      await atNicknameStep();
      for (const [kept, reason] of [
        ['buddha_official', 'reserved_word'],
        ['운_영_자', 'reserved_word'],
        ['user_kim', 'auto_prefix'],
      ] as const) {
        await setStoredNickname(user.id, kept);
        expect(nicknameRefusal(await setNickname(user, kept)), kept).toEqual({ reason });
      }
      expect((await getMe(user)).onboarding.nickname).toBe(false);
      expect(await t.db.select().from(schema.startGrants)).toEqual([]);
      // Another nickname of its choosing sets it.
      expect(meOf(await setNickname(user, '새닉네임')).onboarding.nickname).toBe(true);
      // An ordinary nickname kept from before (the older auto prefix included) is confirmed as it is.
      const older = await signUpTestUser(t);
      await atNicknameStep(older);
      await setStoredNickname(older.id, '예측가_A7K2');
      expect(meOf(await setNickname(older, '예측가_A7K2')).profile.nickname).toBe('예측가_A7K2');
      // An admin's is held to them too — the seed's 관리자 (오너 결정 2026-10-19 (2차) 2): refused,
      // and the admin picks another.
      const admin = await signUpTestUser(t);
      await atNicknameStep(admin);
      await t.db
        .update(schema.profiles)
        .set({ nickname: '관리자', role: 'admin' })
        .where(eq(schema.profiles.userId, admin.id));
      expect(nicknameRefusal(await setNickname(admin, '관리자'))).toEqual({
        reason: 'reserved_word',
      });
      expect((await getMe(admin)).onboarding.nickname).toBe(false);
      expect(meOf(await setNickname(admin, '시장지기')).profile.nickname).toBe('시장지기');
      // Look-alikes are not refused: reports take care of impersonation (2차 7).
      const lookAlike = await signUpTestUser(t);
      await atNicknameStep(lookAlike);
      expect(meOf(await setNickname(lookAlike, 'adm1n')).profile.nickname).toBe('adm1n');
    });

    it('refuses a body naming another account, writing nothing and granting nothing', async () => {
      await atNicknameStep();
      const other = await signUpTestUser(t);
      const res = await setNickname(user, '거래왕', { expectedAccountId: other.id });
      refusal(res, 403, 'FORBIDDEN');
      expect((await getMe(user)).onboarding.nickname).toBe(false);
      expect(await t.db.select().from(schema.startGrants)).toEqual([]);
    });
  });

  // ---- the change of MY 설정 and the holds --------------------------------------------------

  describe('the change of MY 설정 (PATCH /me, #57-6·#37-16)', () => {
    it('waits for the onboarding’s nickname step', async () => {
      expect(stepsOf(await changeNickname(user, '거래왕'))).toEqual([
        'consent',
        'verification',
        'nickname',
      ]);
      await atNicknameStep();
      expect(stepsOf(await changeNickname(user, '거래왕'))).toEqual(['nickname']);
      expect(await nicknameOf(user.id)).toMatch(/^user_/);
    });

    it('changes once in 30 days, saying when the next is allowed', async () => {
      await completeOnboarding(t.db, { userId: user.id });
      const first = meOf(await changeNickname(user, '첫이름'));
      const available = first.profile.nicknameChangeAvailableAt!;
      const [row] = await t.db
        .select({ changedAt: schema.profiles.nicknameChangedAt })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, user.id));
      expect(new Date(available).getTime()).toBe(row!.changedAt!.getTime() + 30 * DAY_MS);
      expect(nicknameRefusal(await changeNickname(user, '둘째이름'))).toEqual({
        reason: 'change_interval',
        nextChangeAt: available,
      });
      // Sending the nickname it has is no change, and allowed.
      expect(meOf(await changeNickname(user, '첫이름')).profile.nickname).toBe('첫이름');
      // 30 days later, the next change goes through.
      await t.db
        .update(schema.profiles)
        .set({ nicknameChangedAt: new Date(Date.now() - 30 * DAY_MS - 60_000) })
        .where(eq(schema.profiles.userId, user.id));
      expect(meOf(await changeNickname(user, '둘째이름')).profile.nickname).toBe('둘째이름');
    });

    it('applies the rules to a change too', async () => {
      await completeOnboarding(t.db, { userId: user.id });
      for (const [nickname, reason] of [
        ['user_ABCD', 'auto_prefix'],
        ['운영팀', 'reserved_word'],
        ['buddha_fan', 'reserved_word'],
        ['ad_min', 'reserved_word'],
      ] as const) {
        expect(nicknameRefusal(await changeNickname(user, nickname)), nickname).toEqual({
          reason,
        });
      }
    });

    it('holds a nickname given up from other accounts for 30 days, in any case, not from its owner', async () => {
      const other = await signUpTestUser(t);
      await completeOnboarding(t.db, { userId: user.id });
      await completeOnboarding(t.db, { userId: other.id });
      meOf(await changeNickname(user, 'Old_Name'));
      // Back 30 days for the next change, then give Old_Name up.
      const rewind = (userId: string) =>
        t.db
          .update(schema.profiles)
          .set({ nicknameChangedAt: new Date(Date.now() - 31 * DAY_MS) })
          .where(eq(schema.profiles.userId, userId));
      await rewind(user.id);
      meOf(await changeNickname(user, 'New_Name'));
      expect((await holds()).at(-1)).toEqual({ nickname: 'Old_Name', userId: user.id });
      for (const nickname of ['Old_Name', 'old_name', 'OLD_NAME']) {
        expect(nicknameRefusal(await changeNickname(other, nickname)), nickname).toEqual({
          reason: 'taken',
        });
      }
      // Its owner may take it back once its own interval allows.
      await rewind(user.id);
      expect(meOf(await changeNickname(user, 'old_name')).profile.nickname).toBe('old_name');
      // A hold past 30 days holds nothing: New_Name, given up just now, is let go of by hand.
      await t.db
        .update(schema.nicknameHolds)
        .set({ releasedAt: new Date(Date.now() - 30 * DAY_MS - 60_000) })
        .where(eq(schema.nicknameHolds.nickname, 'New_Name'));
      expect(meOf(await changeNickname(other, 'new_name')).profile.nickname).toBe('new_name');
    });

    it('holds a withdrawn account’s nickname from everybody (no account on the hold)', async () => {
      await completeOnboarding(t.db, { userId: user.id });
      await t.db.insert(schema.nicknameHolds).values({ nickname: 'Gone_User', userId: null });
      expect(nicknameRefusal(await changeNickname(user, 'gone_user'))).toEqual({
        reason: 'taken',
      });
    });

    it('does not hold a change of case: the nickname stays the account’s', async () => {
      await completeOnboarding(t.db, { userId: user.id });
      meOf(await changeNickname(user, 'casey'));
      await t.db
        .update(schema.profiles)
        .set({ nicknameChangedAt: new Date(Date.now() - 31 * DAY_MS) })
        .where(eq(schema.profiles.userId, user.id));
      const before = (await holds()).length;
      expect(meOf(await changeNickname(user, 'Casey')).profile.nickname).toBe('Casey');
      expect(await holds()).toHaveLength(before);
    });

    it('gives a nickname to one of two accounts taking it at once', async () => {
      const other = await signUpTestUser(t);
      await completeOnboarding(t.db, { userId: user.id });
      await completeOnboarding(t.db, { userId: other.id });
      const [a, b] = await Promise.all([
        changeNickname(user, 'Race_Name'),
        changeNickname(other, 'race_name'),
      ]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = a.statusCode === 409 ? a : b;
      expect(nicknameRefusal(loser)).toEqual({ reason: 'taken' });
    });

    it('keeps a nickname being given up from another account until its hold is written', async () => {
      // A gives Old_Name up while B takes old_name. Without the nickname lock B's hold check would
      // run before A's hold commits, and its write would only wait for A's row in the unique
      // index — which A's change frees — so B would get a nickname held for 30 days.
      const other = await signUpTestUser(t);
      await completeOnboarding(t.db, { userId: user.id });
      await completeOnboarding(t.db, { userId: other.id });
      meOf(await changeNickname(user, 'Old_Name'));
      await t.db
        .update(schema.profiles)
        .set({ nicknameChangedAt: new Date(Date.now() - 31 * DAY_MS) })
        .where(eq(schema.profiles.userId, user.id));
      // Holds A at its hold's INSERT (SHARE blocks it; the reads before it pass), after its
      // UPDATE: A has the nickname locks, the profile changed, nothing committed.
      const blocker = await t.db.$client.connect();
      let giving: Promise<LightMyRequestResponse> | undefined;
      let taking: Promise<LightMyRequestResponse> | undefined;
      let released = false;
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE nickname_holds IN SHARE MODE');
        giving = changeNickname(user, 'New_Name');
        await waitForLockWaiter(blocker, 'A at its hold');
        taking = changeNickname(other, 'old_name');
        // B waits too: on the nickname lock A holds (without it, on A's row in the index).
        await waitForLockWaiter(blocker, 'B behind A', 2);
        await blocker.query('COMMIT');
        released = true;
        expect(meOf(await giving).profile.nickname).toBe('New_Name');
        expect(nicknameRefusal(await taking)).toEqual({ reason: 'taken' });
      } finally {
        if (!released) await blocker.query('ROLLBACK');
        blocker.release();
        await giving?.catch(() => undefined);
        await taking?.catch(() => undefined);
      }
      expect(await nicknameOf(other.id)).toMatch(/^user_/);
      expect((await holds()).at(-1)).toEqual({ nickname: 'Old_Name', userId: user.id });
    });
  });

  // ---- the interest categories ----------------------------------------------------------------

  describe('the interest categories (#57-7)', () => {
    it('takes top-level and sub-categories, as many as picked, and is never asked again', async () => {
      await completeOnboarding(t.db, { userId: user.id });
      const parent = await createCategory(t.db, { slug: `p-${randomUUID().slice(0, 8)}` });
      const child = await createCategory(t.db, {
        slug: `c-${randomUUID().slice(0, 8)}`,
        parentId: parent.id,
      });
      const third = await createCategory(t.db);
      const me = meOf(await setInterests(user, [child.id, parent.id, child.id]));
      expect(me.profile.interestCategoryIds).toEqual([parent.id, child.id].sort((x, y) => x - y));
      expect(me.onboarding).toMatchObject({ interests: true, nextStep: null });
      const [kept] = await t.db
        .select()
        .from(schema.profileInterestCategories)
        .where(eq(schema.profileInterestCategories.categoryId, parent.id));
      // Replaced: what is kept keeps its row, what is dropped goes.
      const replaced = meOf(await setInterests(user, [parent.id, third.id]));
      expect(replaced.profile.interestCategoryIds).toEqual(
        [parent.id, third.id].sort((x, y) => x - y),
      );
      const [still] = await t.db
        .select()
        .from(schema.profileInterestCategories)
        .where(eq(schema.profileInterestCategories.categoryId, parent.id));
      expect(still?.createdAt).toEqual(kept?.createdAt);
    });

    it('is skipped with none: answered, nothing picked', async () => {
      await completeOnboarding(t.db, { userId: user.id });
      const me = meOf(await setInterests(user, []));
      expect(me.profile.interestCategoryIds).toEqual([]);
      expect(me.onboarding).toMatchObject({ completed: true, interests: true, nextStep: null });
    });

    it('refuses a category that does not exist or is retired, naming each, and writes nothing', async () => {
      await completeOnboarding(t.db, { userId: user.id });
      const active = await createCategory(t.db);
      const retired = await createCategory(t.db, { isActive: false });
      const res = await setInterests(user, [active.id, retired.id, 999_999]);
      expect(
        (refusal(res, 400, 'VALIDATION_ERROR') as ValidationIssue[]).map((issue) => issue.path),
      ).toEqual([
        ['categoryIds', 1],
        ['categoryIds', 2],
      ]);
      expect(await t.db.select().from(schema.profileInterestCategories)).toEqual([]);
      expect((await getMe(user)).onboarding.interests).toBe(false);
    });

    it('touches no other account’s picks, saving or skipping, and shows each account its own', async () => {
      const other = await signUpTestUser(t);
      await completeOnboarding(t.db, { userId: user.id });
      await completeOnboarding(t.db, { userId: other.id });
      const p = await createCategory(t.db);
      const c = await createCategory(t.db, {
        slug: `c-${randomUUID().slice(0, 8)}`,
        parentId: p.id,
      });
      const x = await createCategory(t.db);
      const mine = [p.id, c.id].sort((left, right) => left - right);
      meOf(await setInterests(user, mine));
      const picksOf = (userId: string) =>
        t.db
          .select()
          .from(schema.profileInterestCategories)
          .where(eq(schema.profileInterestCategories.userId, userId))
          .orderBy(asc(schema.profileInterestCategories.categoryId));
      const before = await picksOf(user.id);
      // B saves its own list, then skips: A's rows stay as they were, created_at included.
      expect(meOf(await setInterests(other, [x.id])).profile.interestCategoryIds).toEqual([x.id]);
      expect(await picksOf(user.id)).toEqual(before);
      expect((await getMe(user)).profile.interestCategoryIds).toEqual(mine);
      expect((await getMe(other)).profile.interestCategoryIds).toEqual([x.id]);
      expect(meOf(await setInterests(other, [])).profile.interestCategoryIds).toEqual([]);
      expect(await picksOf(user.id)).toEqual(before);
      expect((await getMe(user)).profile.interestCategoryIds).toEqual(mine);
      expect((await getMe(other)).profile.interestCategoryIds).toEqual([]);
    });

    it('refuses a body naming another account, writing nothing', async () => {
      const other = await signUpTestUser(t);
      await completeOnboarding(t.db, { userId: user.id });
      await completeOnboarding(t.db, { userId: other.id });
      const category = await createCategory(t.db);
      refusal(
        await setInterests(user, [category.id], { expectedAccountId: other.id }),
        403,
        'FORBIDDEN',
      );
      expect(await t.db.select().from(schema.profileInterestCategories)).toEqual([]);
    });
  });
});
