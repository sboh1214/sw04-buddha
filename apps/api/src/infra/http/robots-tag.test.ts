/**
 * `X-Robots-Tag: noindex` on every `/api` response (#47, ADR-0075 — owner decision 2026-10-21),
 * against the docker `test` profile: the whole app as main.ts builds it (`createTestApp` registers
 * the same headers and the same address limit), so each half of the API answers as it does in a
 * deployment — Nest's routes and its exception filter, Fastify's own refusals ahead of any handler,
 * and better-auth's `/api/auth/*` on the raw response. Skips when TEST_* are unset.
 */
import { randomUUID } from 'node:crypto';
import { createMarket, createPost, createUser } from '@buddha/db/test';
import { type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp } from '../../test/app.js';
import { hasTestInfra } from '../../test/setup-env.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

function expectNoindex(res: LightMyRequestResponse, status: number): void {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['x-robots-tag']).toBe('noindex');
}

describe.skipIf(!hasTestInfra)('X-Robots-Tag on every /api response (integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
  });

  const get = (url: string, cookie?: string) =>
    t.app.inject({ method: 'GET', url, ...(cookie === undefined ? {} : { headers: { cookie } }) });

  it('marks a public route: the 토론 the market detail reads in the browser, and the rest', async () => {
    const market = await createMarket(t.db);
    const { user } = await createUser(t.db);
    await createPost(t.db, { marketId: market.id, authorId: user.id });

    const discussion = await get(`/api/v1/markets/${market.id}/posts`);
    expectNoindex(discussion, 200);
    expect(discussion.json<{ meta: { total: number } }>().meta.total).toBe(1);
    expectNoindex(await get('/api/v1/posts'), 200);
    expectNoindex(await get(`/api/v1/markets/${market.slug}`), 200);
    expectNoindex(await get('/api/health'), 200);
  });

  it('marks an error response, wherever it is answered', async () => {
    // Nest's exception filter: an unknown market, a slug where a uuid goes, no session.
    const unknown = await get(`/api/v1/markets/${randomUUID()}/posts`);
    expectNoindex(unknown, 404);
    expect(unknown.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expectNoindex(await get('/api/v1/markets/not-a-uuid/posts'), 400);
    expectNoindex(await get('/api/v1/me'), 401);
    // Fastify's own, before any handler: a path no route matches, a body that does not parse.
    expectNoindex(await get('/api/v1/no-such-route'), 404);
    expectNoindex(
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: '{',
      }),
      400,
    );
  });

  it('marks an auth route: better-auth answers on the raw response, ahead of Nest', async () => {
    const member = await signUpTestUser(t);
    const signIn = (password: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json' },
        payload: { email: member.email, password },
      });
    expectNoindex(await signIn(member.password), 200);
    expectNoindex(await signIn('not-the-password'), 401);
    expectNoindex(await get('/api/auth/get-session', member.cookie), 200);
    expectNoindex(await get('/api/auth/no-such-route'), 404);
  });
});
