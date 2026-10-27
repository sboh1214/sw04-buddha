import { type Db } from '@buddha/db';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../config/env.js';
import { createAuth, OAUTH_SCOPES } from './auth.js';

/**
 * What the service asks each social login provider for (오너 결정 2026-10-19 (2차) 3, ADR-0072
 * 7-40): the member identifier and the email address, never the name or the profile photo. Read
 * from the provider's authorization address — what its consent screen shows the member — as
 * better-auth builds it, so a default scope an upgrade adds back is caught. Pure: the instance has
 * nothing behind it and building an address calls nobody.
 */
describe('the scopes asked of a social login provider', () => {
  const auth = createAuth({
    env: envSchema.parse({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://unused@localhost/unused',
      REDIS_URL: 'redis://localhost:6379',
      BETTER_AUTH_SECRET: 'scopes-only-secret-0123456789abcdef0123456789',
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

  async function scopesOf(id: string): Promise<string[]> {
    const context = await auth.$context;
    const provider = context.socialProviders.find((candidate) => candidate.id === id);
    if (!provider) throw new Error(`no ${id} provider`);
    const url = await provider.createAuthorizationURL({
      state: 'state',
      codeVerifier: 'code-verifier-0123456789abcdef0123456789abcdef',
      redirectURI: `http://localhost:4000/api/auth/callback/${id}`,
    });
    return (url.searchParams.get('scope') ?? '').split(/[ ,]+/).filter(Boolean);
  }

  it('asks Google for the member and the address only: no `profile`', async () => {
    expect(await scopesOf('google')).toEqual(['openid', 'email']);
    expect(OAUTH_SCOPES.google).toEqual(['openid', 'email']);
  });

  it('asks Kakao for the address only: no nickname, no profile photo', async () => {
    expect(await scopesOf('kakao')).toEqual(['account_email']);
  });

  it('leaves Naver as better-auth asks: its console decides what it hands over (결과 3)', async () => {
    // Naver reads no scope from the request; the fields it returns are the ones its developer
    // console turns on. Pinned so a change here is a decision, not a drift.
    expect(await scopesOf('naver')).toEqual(['profile', 'email']);
  });
});
