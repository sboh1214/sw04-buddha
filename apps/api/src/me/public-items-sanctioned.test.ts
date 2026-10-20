/**
 * Every public profile item write goes through the one check point (#41, ADR-0069 decision 3
 * #37-9 and decision 7), proven against the docker `test` profile with the sanction lookup
 * stubbed — no writing restriction (#185) or account restriction (#139) exists yet, so a flag here
 * stands for "the account is under one". Under it: the 소개 can be emptied but not written, interest
 * categories dropped but not added, the nickname not changed; the time zone (a private setting)
 * still changes, and the profile still opens (#37-9: «그대로 열린다»). Nothing is written by a
 * refused request. The onboarding's interests step shares the route: its first picks are new values
 * too, and only its skip passes (ADR-0078 7-10). Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { completeOnboarding, createCategory } from '@buddha/db/test';
import { meSchema } from '@buddha/shared';
import { eq } from 'drizzle-orm';
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

  const send = (method: 'PUT' | 'PATCH', url: string, payload: Record<string, unknown>) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        cookie: member.cookie,
      },
      payload: JSON.stringify({ ...payload, expectedAccountId: member.id }),
    });
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
  const picks = async () =>
    (
      await t.db
        .select({ categoryId: schema.profileInterestCategories.categoryId })
        .from(schema.profileInterestCategories)
        .where(eq(schema.profileInterestCategories.userId, member.id))
    )
      .map((row) => row.categoryId)
      .sort((x, y) => x - y);
  const codeOf = (res: { statusCode: number; json: <T>() => T }) => ({
    status: res.statusCode,
    code: res.json<{ error?: { code: string } }>().error?.code ?? null,
  });

  it('keeps public items from new values and lets them be cleared (#37-9, decision 7)', async () => {
    const [a, b, c] = await Promise.all([
      createCategory(t.db),
      createCategory(t.db),
      createCategory(t.db),
    ]);
    expect((await send('PUT', '/me/bio', { bio: '처음 소개' })).statusCode).toBe(200);
    expect(
      (await send('PUT', '/me/interest-categories', { categoryIds: [a.id, b.id] })).statusCode,
    ).toBe(200);
    const before = await profileRow();
    // The two writes above were new values with no sanction: asked, and let through.
    expect(sanction.asked).toEqual([member.id, member.id]);
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

  it('refuses the onboarding’s first picks as new values and lets its skip through (ADR-0078 7-10)', async () => {
    // The member has finished the three steps but not answered the interests step: no picks.
    const answeredAt = async () => {
      const [row] = await t.db
        .select({ at: schema.profiles.interestsAnsweredAt })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, member.id));
      return row!.at;
    };
    expect(await answeredAt()).toBeNull();
    const category = await createCategory(t.db);
    sanction.on = true;

    // Any pick is a category the account did not have: refused, and the step stays unanswered.
    const picked = await send('PUT', '/me/interest-categories', { categoryIds: [category.id] });
    expect(codeOf(picked)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await picks()).toEqual([]);
    expect(await answeredAt()).toBeNull();
    expect(sanction.asked).toEqual([member.id]);

    // The skip sends none: nothing new, so it passes unasked and answers the step for good.
    const skipped = await send('PUT', '/me/interest-categories', { categoryIds: [] });
    expect(skipped.statusCode, skipped.body).toBe(200);
    expect(await answeredAt()).not.toBeNull();
    expect(sanction.asked).toEqual([member.id]);
  });
});
