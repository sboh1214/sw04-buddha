import { type Db } from '@buddha/db';
import { createEmailVerificationToken } from 'better-auth/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envSchema } from '../config/env.js';
import { MAIL_TEMPLATES } from '../mail/templates.js';
import { createMemoryMailer } from '../test/memory-mailer.js';
import { createAuth } from './auth.js';

/**
 * Which mail better-auth's `sendVerificationEmail` hook sends a link in (ADR-0153): the hook as
 * `createAuth` builds it, handed links minted the way better-auth mints them
 * (`createEmailVerificationToken`, the payloads of `email-verification.mjs` and `/change-email`
 * in 1.7.26) with the secret it signs them with. Pure: nothing is read from a database.
 * auth.test.ts walks the same mails through the real routes.
 */
describe('the verification mail hook', () => {
  const configured = 'verification-mail-only-secret-0123456789abcdef0123';
  const mailer = createMemoryMailer();
  // Also where better-auth's own lines go (`betterAuthLog`, ADR-0152), so the checks below look
  // for the hook's own lines only.
  const logger = { debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  /** The hook's line for a link it could not read. */
  const unreadable: unknown = expect.stringContaining('verification link token did not verify');
  const build = () =>
    createAuth({
      env: envSchema.parse({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://unused@localhost/unused',
        REDIS_URL: 'redis://localhost:6379',
        BETTER_AUTH_SECRET: configured,
      }),
      db: {} as Db,
      mailer,
      logger,
    });
  const auth = build();

  const current = 'member@test.local';
  const next = 'member-next@test.local';
  const userId = 'user-1';
  const linkOf = (token: string) =>
    `http://localhost:3000/api/auth/verify-email?token=${token}&callbackURL=%2Fmy%2Fsettings`;

  /** Hands `instance`'s hook a link for `user`, as better-auth does. */
  async function mail(
    user: { email: string; emailVerified: boolean },
    token: string,
    instance = auth,
  ) {
    const hook = (await instance.$context).options.emailVerification?.sendVerificationEmail;
    if (hook === undefined) throw new Error('no sendVerificationEmail hook');
    const now = new Date();
    await hook({
      user: { id: userId, name: 'x', createdAt: now, updatedAt: now, ...user },
      url: linkOf(token),
      token,
    });
  }

  /** The secret better-auth signs links with: `configured`, unless the shell sets BETTER_AUTH_SECRETS. */
  const signing = async (instance = auth) => (await instance.$context).secret;

  /** A change of address's link to the new one: both branches of `/change-email` mint this. */
  const changeToken = async (signedWith?: string) =>
    createEmailVerificationToken(signedWith ?? (await signing()), current, next, 3600, {
      requestType: 'change-email-verification',
      userId,
    });

  beforeEach(() => {
    mailer.messages.length = 0;
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends the sign-up and resend link in the sign-up mail', async () => {
    const token = await createEmailVerificationToken(await signing(), current, undefined, 3600, {
      userId,
    });
    await mail({ email: current, emailVerified: false }, token);
    expect(mailer.messages).toEqual([
      { to: current, ...MAIL_TEMPLATES.verification({ url: linkOf(token) }) },
    ]);
    expect(logger.warn).not.toHaveBeenCalledWith(unreadable);
  });

  it('sends a verified account’s link to its new address in the mail that says the click changes and verifies it', async () => {
    // `user` is the account asking with the new address in place of its own: the confirmation
    // branch, after the click at the current address.
    const token = await changeToken();
    await mail({ email: next, emailVerified: true }, token);
    expect(mailer.messages).toEqual([
      { to: next, ...MAIL_TEMPLATES.changeEmailVerified({ url: linkOf(token) }) },
    ]);
    expect(logger.warn).not.toHaveBeenCalledWith(unreadable);
  });

  it('sends an unverified account’s link to its new address in the mail that says the click only changes it', async () => {
    // The branch with no confirmation: a Kakao/Naver synthetic address, a real one not verified.
    const token = await changeToken();
    await mail({ email: next, emailVerified: false }, token);
    expect(mailer.messages).toEqual([
      { to: next, ...MAIL_TEMPLATES.changeEmailUnverified({ url: linkOf(token) }) },
    ]);
    expect(logger.warn).not.toHaveBeenCalledWith(unreadable);
  });

  it('reads the link with the secret better-auth signs it with: the current one of BETTER_AUTH_SECRETS when that is set', async () => {
    // better-auth reads BETTER_AUTH_SECRETS from the environment itself, over the `secret` option.
    const rotated = 'rotated-current-secret-0123456789abcdef0123456789abcdef';
    vi.stubEnv('BETTER_AUTH_SECRETS', `2:${rotated},1:${configured}`);
    const instance = build();
    expect(await signing(instance)).toBe(rotated);
    const token = await changeToken(rotated);
    await mail({ email: next, emailVerified: false }, token, instance);
    expect(mailer.messages).toEqual([
      { to: next, ...MAIL_TEMPLATES.changeEmailUnverified({ url: linkOf(token) }) },
    ]);
    expect(logger.warn).not.toHaveBeenCalledWith(unreadable);
  });

  it('still sends a link it cannot read, in the sign-up mail, and says so', async () => {
    const token = await changeToken('another-secret-0123456789abcdef0123456789abcdef');
    await mail({ email: next, emailVerified: true }, token);
    expect(mailer.messages).toEqual([
      { to: next, ...MAIL_TEMPLATES.verification({ url: linkOf(token) }) },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(unreadable);
  });

  it('logs a failed send and rethrows it, whichever mail it was (ADR-0023)', async () => {
    mailer.failNext(1);
    await expect(mail({ email: next, emailVerified: false }, await changeToken())).rejects.toThrow(
      'smtp unavailable',
    );
    expect(mailer.messages).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`mail to ${next} failed`));
  });
});
