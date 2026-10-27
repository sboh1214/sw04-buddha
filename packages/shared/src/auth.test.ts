import { describe, expect, it } from 'vitest';
import {
  NEXT_PATH_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SET_PASSWORD_PATH,
  isSameOriginPath,
  registerBodySchema,
  setPasswordBodySchema,
  setPasswordCallbackURL,
} from './auth.js';

describe('setPasswordCallbackURL', () => {
  it('lands on /set-password, carrying a next that is not home (#58)', () => {
    expect(SET_PASSWORD_PATH).toBe('/set-password');
    expect(setPasswordCallbackURL(undefined)).toBe('/set-password');
    expect(setPasswordCallbackURL('/')).toBe('/set-password');
    const url = new URL(setPasswordCallbackURL('/markets/a?x=1&y=2'), 'https://x.invalid');
    expect(url.pathname).toBe('/set-password');
    expect([...url.searchParams.keys()]).toEqual(['next']);
    expect(url.searchParams.get('next')).toBe('/markets/a?x=1&y=2');
  });
});

describe('isSameOriginPath', () => {
  it('takes a path on this origin, query string included', () => {
    for (const path of ['/', '/my/settings', '/markets/abc?x=1&y=2', '/onboarding?next=%2Fmy']) {
      expect(isSameOriginPath(path), path).toBe(true);
    }
  });

  it('refuses anything that could leave the origin', () => {
    for (const path of [
      '',
      'my/settings',
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.com',
      '/\n/evil.com',
      '/\r\n//evil.com',
      '/my/settings\\..',
      'javascript:alert(1)',
    ]) {
      expect(isSameOriginPath(path), JSON.stringify(path)).toBe(false);
    }
  });
});

describe('registerBodySchema', () => {
  it('takes the email alone, or with the page the visitor came from (#58)', () => {
    expect(registerBodySchema.parse({ email: 'a@example.com' })).toEqual({
      email: 'a@example.com',
    });
    expect(registerBodySchema.parse({ email: 'a@example.com', next: '/markets/abc?x=1' })).toEqual({
      email: 'a@example.com',
      next: '/markets/abc?x=1',
    });
  });

  it('refuses a next that is not a path on this origin, or is too long', () => {
    for (const next of [
      'https://evil.example',
      '//evil.example',
      '',
      `/${'a'.repeat(NEXT_PATH_MAX_LENGTH)}`,
    ]) {
      expect(registerBodySchema.safeParse({ email: 'a@example.com', next }).success, next).toBe(
        false,
      );
    }
  });
});

describe('setPasswordBodySchema', () => {
  const newPassword = 'x'.repeat(PASSWORD_MIN_LENGTH);

  it('takes the first password and the account the screen is showing', () => {
    expect(setPasswordBodySchema.parse({ newPassword, expectedAccountId: 'user-1' })).toEqual({
      newPassword,
      expectedAccountId: 'user-1',
    });
    for (const bad of ['x'.repeat(PASSWORD_MIN_LENGTH - 1), 'x'.repeat(PASSWORD_MAX_LENGTH + 1)]) {
      expect(
        setPasswordBodySchema.safeParse({ newPassword: bad, expectedAccountId: 'user-1' }).success,
      ).toBe(false);
    }
  });

  it('requires the account the screen is showing', () => {
    // A stale tab must not be able to give whoever the cookie now belongs to a password.
    expect(setPasswordBodySchema.safeParse({ newPassword }).success).toBe(false);
    expect(setPasswordBodySchema.safeParse({ newPassword, expectedAccountId: '' }).success).toBe(
      false,
    );
    expect(
      setPasswordBodySchema.safeParse({ newPassword, expectedAccountId: 'u'.repeat(256) }).success,
    ).toBe(false);
  });
});
