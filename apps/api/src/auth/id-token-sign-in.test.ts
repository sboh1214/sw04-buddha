import { type Db } from '@buddha/db';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../config/env.js';
import { createAuth } from './auth.js';

/**
 * Social sign-in and linking go through the provider's redirect only (ADR-0151): a client cannot
 * hand `/sign-in/social` or `/link-social` an ID token it got elsewhere. better-auth accepts one
 * for every provider that declares an ID-token verifier — Google already in 1.7.7, Kakao since
 * 1.7.26 — unless the provider's options say `disableIdTokenSignIn`; Naver declares none. Both
 * routes ask the same `supportsIdTokenSignIn` before anything else, so the sign-in route stands
 * for both. Pure: the refusal comes before any database read or provider call.
 */
describe('a client-submitted ID token', () => {
  const auth = createAuth({
    env: envSchema.parse({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://unused@localhost/unused',
      REDIS_URL: 'redis://localhost:6379',
      BETTER_AUTH_SECRET: 'id-token-only-secret-0123456789abcdef0123456789',
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      KAKAO_CLIENT_ID: 'kakao-client',
      KAKAO_CLIENT_SECRET: 'kakao-secret',
      NAVER_CLIENT_ID: 'naver-client',
      NAVER_CLIENT_SECRET: 'naver-secret',
    }),
    db: {} as Db,
    mailer: { send: () => Promise.resolve(), verify: () => Promise.resolve(), close: () => {} },
  });

  it.each(['google', 'kakao', 'naver'] as const)(
    'is refused for %s before anything is read',
    async (provider) => {
      await expect(
        auth.api.signInSocial({
          body: { provider, idToken: { token: 'header.payload.signature' } },
        }),
      ).rejects.toMatchObject({ status: 'NOT_FOUND', body: { code: 'ID_TOKEN_NOT_SUPPORTED' } });
    },
  );
});
