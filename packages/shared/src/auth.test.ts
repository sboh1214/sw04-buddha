import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, setPasswordBodySchema } from './auth.js';

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
