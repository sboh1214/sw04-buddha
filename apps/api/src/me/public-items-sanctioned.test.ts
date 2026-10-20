/**
 * Every public profile item write goes through the one check point (#41, ADR-0069 decision 3
 * #37-9 and decision 7), proven against the docker `test` profile with the sanction lookup
 * stubbed — no writing restriction (#185) or account restriction (#139) exists yet, so a flag here
 * stands for "the account is under one". Under it: the 소개 can be emptied but not written, interest
 * categories dropped but not added, the nickname not changed; the time zone (a private setting)
 * still changes, and the profile still opens (#37-9: «그대로 열린다»). Nothing is written by a
 * refused request. The onboarding's first choices are not changes (owner decision 2026-10-21 answer
 * 4): the nickname step takes a nickname of the member's own, and the interests step's screen
 * (`POST /me/onboarding/interests`) takes its first picks; only later additions are refused. Only
 * that screen's first answer passes (owner decision 2026-10-21 (2nd) answer 2): MY 설정's first
 * pick is refused however the account left the step — with the skip its screen sent on leaving, or
 * with nothing recorded — and so is the screen's pick once the step is answered, or once 24 hours
 * have passed since the nickname step (owner decision 2026-10-21 (3rd) answer 1: the first answer's
 * window, whose boundary is tested at 23 h 59 min and 24 h 1 min; the screen's skip then records
 * the skip). An account the onboarding holds back (a re-consent) hears that before the restriction
 * (ADR-0078 decision 4). Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createConsents,
  createPhoneVerification,
} from '@buddha/db/test';
import { meSchema, onboardingRequiredDetailsSchema } from '@buddha/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import type * as PublicItems from './public-items.js';

/** Whether the stubbed lookup says the account is under a sanction. */
const sanction = vi.hoisted(() => ({ on: false, asked: [] as string[] }));

vi.mock('./public-items.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PublicItems>();
  return {
    ...actual,
    // The real check point, with the stub as its lookup: what #185 and #139 will plug in.
    assertPublicItemEdit: (
      ...[executor, userId, edit]: Parameters<typeof actual.assertPublicItemEdit>
    ) =>
      actual.assertPublicItemEdit(executor, userId, edit, (_executor, asked) => {
        sanction.asked.push(asked);
        return Promise.resolve(sanction.on);
      }),
  };
});

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

describe.skipIf(!hasTestInfra)('public profile items under a restriction (integration)', () => {
  let t: TestApp;
  let member: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    sanction.on = false;
    sanction.asked = [];
    member = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: member.id });
  });

  const send = (
    method: 'POST' | 'PUT' | 'PATCH',
    url: string,
    payload: Record<string, unknown>,
    who: TestUser = member,
  ) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        cookie: who.cookie,
      },
      payload: JSON.stringify({ ...payload, expectedAccountId: who.id }),
    });
  const answeredAt = async (userId: string = member.id) => {
    const [row] = await t.db
      .select({ at: schema.profiles.interestsAnsweredAt })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return row!.at;
  };
  /** The nickname step moved back by `ago` (a Postgres interval), by the database's clock. */
  const nicknameConfirmedAgo = (userId: string, ago: string) =>
    t.db
      .update(schema.profiles)
      .set({ nicknameConfirmedAt: sql`now() - ${ago}::interval` })
      .where(eq(schema.profiles.userId, userId));
  const profileRow = async () => {
    const [row] = await t.db
      .select({
        nickname: schema.profiles.nickname,
        bio: schema.profiles.bio,
        timeZone: schema.profiles.timeZone,
        publicId: schema.profiles.publicId,
      })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, member.id));
    return row!;
  };
  const picks = async (userId: string = member.id) =>
    (
      await t.db
        .select({ categoryId: schema.profileInterestCategories.categoryId })
        .from(schema.profileInterestCategories)
        .where(eq(schema.profileInterestCategories.userId, userId))
    )
      .map((row) => row.categoryId)
      .sort((x, y) => x - y);
  const codeOf = (res: { statusCode: number; json: <T>() => T }) => ({
    status: res.statusCode,
    code: res.json<{ error?: { code: string } }>().error?.code ?? null,
  });
  const stepsOf = (res: { statusCode: number; body: string; json: <T>() => T }) => {
    expect(res.statusCode, res.body).toBe(409);
    const { error } = res.json<{ error: { code: string; details?: unknown } }>();
    expect(error.code).toBe('ONBOARDING_REQUIRED');
    return onboardingRequiredDetailsSchema.parse(error.details).steps;
  };
  const sorted = (ids: number[]) => [...ids].sort((x, y) => x - y);

  it('keeps public items from new values and lets them be cleared (#37-9, decision 7)', async () => {
    const [a, b, c] = await Promise.all([
      createCategory(t.db),
      createCategory(t.db),
      createCategory(t.db),
    ]);
    expect((await send('PUT', '/me/bio', { bio: '처음 소개' })).statusCode).toBe(200);
    expect(
      (await send('POST', '/me/onboarding/interests', { categoryIds: [a.id, b.id] })).statusCode,
    ).toBe(200);
    const before = await profileRow();
    // The 소개 was a new value with no sanction: asked, and let through. The picks were the
    // interests step's first answer, which is not asked (answer 4, the test below).
    expect(sanction.asked).toEqual([member.id]);
    sanction.asked = [];
    sanction.on = true;

    // New values: refused, nothing written.
    const refusedBio = await send('PUT', '/me/bio', { bio: '새 소개' });
    expect(codeOf(refusedBio)).toEqual({ status: 403, code: 'FORBIDDEN' });
    const added = await send('PUT', '/me/interest-categories', { categoryIds: [a.id, c.id] });
    expect(codeOf(added)).toEqual({ status: 403, code: 'FORBIDDEN' });
    const renamed = await send('PATCH', '/me', { nickname: '다른이름' });
    expect(codeOf(renamed)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await profileRow()).toEqual(before);
    expect(await picks()).toEqual([a.id, b.id].sort((x, y) => x - y));
    expect(sanction.asked).toEqual([member.id, member.id, member.id]);

    // What changes nothing asks nothing and passes: the same 소개, the same picks.
    sanction.asked = [];
    expect((await send('PUT', '/me/bio', { bio: '처음 소개' })).statusCode).toBe(200);
    expect(
      (await send('PUT', '/me/interest-categories', { categoryIds: [b.id, a.id] })).statusCode,
    ).toBe(200);
    expect((await send('PATCH', '/me', { nickname: before.nickname })).statusCode).toBe(200);
    expect(sanction.asked).toEqual([]);

    // Clearing: dropping a category, then all, and emptying the 소개.
    const dropped = await send('PUT', '/me/interest-categories', { categoryIds: [b.id] });
    expect(dropped.statusCode, dropped.body).toBe(200);
    expect(await picks()).toEqual([b.id]);
    expect((await send('PUT', '/me/interest-categories', { categoryIds: [] })).statusCode).toBe(
      200,
    );
    expect(await picks()).toEqual([]);
    const emptied = await send('PUT', '/me/bio', { bio: '  ' });
    expect(emptied.statusCode, emptied.body).toBe(200);
    expect(meSchema.parse(emptied.json<{ data: unknown }>().data).profile.bio).toBeNull();

    // A private setting is not a public item, and the profile stays open.
    expect((await send('PUT', '/me/time-zone', { timeZone: 'Asia/Tokyo' })).statusCode).toBe(200);
    expect((await profileRow()).timeZone).toBe('Asia/Tokyo');
    const profile = await t.app.inject({
      method: 'GET',
      url: `/api/v1/profiles/${before.publicId}`,
    });
    expect(profile.statusCode).toBe(200);

    // Lifted: new values pass again.
    sanction.on = false;
    expect((await send('PUT', '/me/bio', { bio: '새 소개' })).statusCode).toBe(200);
    expect((await profileRow()).bio).toBe('새 소개');
  });

  it('takes the onboarding’s first picks as a first choice, and refuses later additions (owner decision 2026-10-21 answer 4)', async () => {
    // The member has finished the three steps but not answered the interests step: no picks.
    expect(await answeredAt()).toBeNull();
    const [first, second, later] = await Promise.all([
      createCategory(t.db),
      createCategory(t.db),
      createCategory(t.db),
    ]);
    sanction.on = true;

    // The step's answer is the account's first choice, not a change: taken without asking.
    const picked = await send('POST', '/me/onboarding/interests', {
      categoryIds: [first.id, second.id],
    });
    expect(picked.statusCode, picked.body).toBe(200);
    expect(await picks()).toEqual([first.id, second.id].sort((x, y) => x - y));
    expect(await answeredAt()).not.toBeNull();
    expect(sanction.asked).toEqual([]);

    // Answered, a category added is a change of MY 설정: refused, nothing written. Dropping passes.
    const added = await send('PUT', '/me/interest-categories', {
      categoryIds: [first.id, second.id, later.id],
    });
    expect(codeOf(added)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(sanction.asked).toEqual([member.id]);
    // Nor is the step's screen a way back to a first choice once it is answered.
    const again = await send('POST', '/me/onboarding/interests', {
      categoryIds: [first.id, later.id],
    });
    expect(codeOf(again)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(sanction.asked).toEqual([member.id, member.id]);
    const dropped = await send('PUT', '/me/interest-categories', { categoryIds: [first.id] });
    expect(dropped.statusCode, dropped.body).toBe(200);
    expect(await picks()).toEqual([first.id]);
  });

  it('takes the skip of the interests step and a nickname of the member’s own in the nickname step (answer 4)', async () => {
    sanction.on = true;
    // The skip answers the step for good, unasked.
    const skipped = await send('POST', '/me/onboarding/interests', { categoryIds: [] });
    expect(skipped.statusCode, skipped.body).toBe(200);
    expect(await answeredAt()).not.toBeNull();

    // An account at the nickname step: the consent and the 본인확인 done.
    const newcomer = await signUpTestUser(t);
    await createConsents(t.db, { userId: newcomer.id });
    await createPhoneVerification(t.db, { userId: newcomer.id });
    const chosen = await send(
      'POST',
      '/me/onboarding/nickname',
      { nickname: `first_${String(Date.now() % 1_000_000)}` },
      newcomer,
    );
    expect(chosen.statusCode, chosen.body).toBe(200);
    const me = meSchema.parse(chosen.json<{ data: unknown }>().data);
    expect(me.profile.nickname).toMatch(/^first_/);
    expect(me.onboarding.nickname).toBe(true);
    // Its later change in MY 설정 is refused (the first change after the onboarding is open).
    const renamed = await send('PATCH', '/me', { nickname: 'second_name' }, newcomer);
    expect(codeOf(renamed)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(sanction.asked).toEqual([newcomer.id]);
  });

  it('asks the onboarding before the restriction: an account a re-consent holds back hears the consent step (decision 4)', async () => {
    const [a, b, c] = await Promise.all([
      createCategory(t.db),
      createCategory(t.db),
      createCategory(t.db),
    ]);
    expect((await send('PUT', '/me/bio', { bio: '내 소개' })).statusCode).toBe(200);
    expect(
      (await send('POST', '/me/onboarding/interests', { categoryIds: [a.id, b.id] })).statusCode,
    ).toBe(200);
    // A revision that changed members' rights asks the consent again (profiles.controller.test.ts
    // makes it the same way): the record the member agreed to is one the list no longer holds.
    await t.db.delete(schema.consentRecords).where(eq(schema.consentRecords.userId, member.id));
    await createConsents(t.db, { userId: member.id, versions: { terms: 'draft-1999-01-01' } });
    const before = await profileRow();
    sanction.asked = [];
    sanction.on = true;

    // New values name the consent step and never reach the restriction: the web sends the member to
    // the step (`profileItemFailure`) instead of showing the field-less 403's generic sentence.
    expect(stepsOf(await send('PUT', '/me/bio', { bio: '새 소개' }))).toEqual(['consent']);
    expect(
      stepsOf(await send('PUT', '/me/interest-categories', { categoryIds: [a.id, b.id, c.id] })),
    ).toEqual(['consent']);
    expect(sanction.asked).toEqual([]);
    expect(await profileRow()).toEqual(before);
    expect(await picks()).toEqual(sorted([a.id, b.id]));

    // Clearing asks neither: a category dropped, the 소개 emptied.
    const dropped = await send('PUT', '/me/interest-categories', { categoryIds: [a.id] });
    expect(dropped.statusCode, dropped.body).toBe(200);
    expect(await picks()).toEqual([a.id]);
    const emptied = await send('PUT', '/me/bio', { bio: null });
    expect(emptied.statusCode, emptied.body).toBe(200);
    expect((await profileRow()).bio).toBeNull();
    expect(sanction.asked).toEqual([]);
  });

  it('lets only the onboarding screen’s first answer through: MY 설정’s first pick is refused however the account left the step (owner decision 2026-10-21 (2nd) answer 2)', async () => {
    // Three members who finished the three steps. `member` left the start-Coin notice with nothing
    // recorded (the screen's skip never arrived: the browser crashed); `leaver` left the interests
    // screen, whose skip the server recorded; `picker` is still on the interests screen.
    const leaver = await signUpTestUser(t);
    const picker = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: leaver.id });
    await completeOnboarding(t.db, { userId: picker.id });
    const left = await send('POST', '/me/onboarding/interests', { categoryIds: [] }, leaver);
    expect(left.statusCode, left.body).toBe(200);
    const category = await createCategory(t.db);
    sanction.on = true;

    // MY 설정's first pick is a change for both: refused, nothing written, the step unanswered
    // where it was.
    const unrecorded = await send('PUT', '/me/interest-categories', { categoryIds: [category.id] });
    expect(codeOf(unrecorded)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await answeredAt()).toBeNull();
    const recorded = await send(
      'PUT',
      '/me/interest-categories',
      { categoryIds: [category.id] },
      leaver,
    );
    expect(codeOf(recorded)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(sanction.asked).toEqual([member.id, leaver.id]);
    // The step's screen after the recorded leave (its page restored by the back button): a change.
    const restored = await send(
      'POST',
      '/me/onboarding/interests',
      { categoryIds: [category.id] },
      leaver,
    );
    expect(codeOf(restored)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await picks()).toEqual([]);
    expect(await picks(leaver.id)).toEqual([]);

    // The pick inside the onboarding's interests screen is the first choice: taken, unasked.
    sanction.asked = [];
    const firstPick = await send(
      'POST',
      '/me/onboarding/interests',
      { categoryIds: [category.id] },
      picker,
    );
    expect(firstPick.statusCode, firstPick.body).toBe(200);
    expect(await picks(picker.id)).toEqual([category.id]);
    expect(sanction.asked).toEqual([]);
  });

  it('takes the interests step’s screen as the first answer only within 24 hours of the nickname step: past them its pick is a change and its skip records the skip (owner decision 2026-10-21 (3rd) answer 1)', async () => {
    // Two members who finished the three steps and whose leaving of the onboarding's screens never
    // reached the server (the interests step unanswered): `member` confirmed its nickname 23 hours
    // 59 minutes ago, `late` 24 hours 1 minute ago.
    const late = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: late.id });
    await nicknameConfirmedAgo(member.id, '23 hours 59 minutes');
    await nicknameConfirmedAgo(late.id, '24 hours 1 minute');
    const category = await createCategory(t.db);
    sanction.on = true;

    // Within the 24 hours: the step's first answer, a first choice taken unasked.
    const within = await send('POST', '/me/onboarding/interests', { categoryIds: [category.id] });
    expect(within.statusCode, within.body).toBe(200);
    expect(await picks()).toEqual([category.id]);
    expect(await answeredAt()).not.toBeNull();
    expect(sanction.asked).toEqual([]);

    // Past them: a change ('replace'), refused under the restriction — nothing written, the step
    // still unanswered.
    const past = await send(
      'POST',
      '/me/onboarding/interests',
      { categoryIds: [category.id] },
      late,
    );
    expect(codeOf(past)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(sanction.asked).toEqual([late.id]);
    expect(await picks(late.id)).toEqual([]);
    expect(await answeredAt(late.id)).toBeNull();

    // Its skip records the skip, unasked: no public item takes a value.
    sanction.asked = [];
    const skipped = await send('POST', '/me/onboarding/interests', { categoryIds: [] }, late);
    expect(skipped.statusCode, skipped.body).toBe(200);
    expect(await answeredAt(late.id)).not.toBeNull();
    expect(await picks(late.id)).toEqual([]);
    expect(sanction.asked).toEqual([]);
  });

  it('saves the interests step’s pick past the 24 hours as a change once no restriction is in force, answering the step (owner decision 2026-10-21 (3rd) answer 1)', async () => {
    await nicknameConfirmedAgo(member.id, '24 hours 1 minute');
    const category = await createCategory(t.db);
    const picked = await send('POST', '/me/onboarding/interests', { categoryIds: [category.id] });
    expect(picked.statusCode, picked.body).toBe(200);
    // Asked, as every new value is, and let through.
    expect(sanction.asked).toEqual([member.id]);
    expect(await picks()).toEqual([category.id]);
    expect(await answeredAt()).not.toBeNull();
  });
});
