import { describe, expect, it } from 'vitest';
import { meSchema, nicknameSchema, updateMeBodySchema } from './me.js';

describe('nicknameSchema', () => {
  it('accepts Hangul, letters, digits and underscore within 2..20 chars', () => {
    for (const ok of ['예측가_A7K2', '홍길동', 'user01', 'ab', '가'.repeat(20)]) {
      expect(nicknameSchema.safeParse(ok).success).toBe(true);
    }
  });

  it('rejects length and charset violations', () => {
    for (const bad of ['a', '가'.repeat(21), 'hello world', 'nick-name', '닉네임!', '']) {
      expect(nicknameSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('meSchema', () => {
  const sample = {
    id: 'u1',
    email: 'user@example.com',
    emailVerified: false,
    profile: { nickname: '예측가_Q7Z9', role: 'user', createdAt: '2026-09-03T00:00:00.000Z' },
    balance: { availableCoin: '0', lockedCoin: '0' },
    linkedAccounts: [
      {
        id: 'acc1',
        providerId: 'credential',
        accountId: 'u1',
        createdAt: '2026-09-03T00:00:00.000Z',
      },
    ],
    contact: null,
  };

  it('parses a complete /me payload', () => {
    expect(meSchema.parse(sample)).toEqual(sample);
  });

  it('carries the contact once provided, and requires the key either way', () => {
    const withContact = { ...sample, contact: { realName: '홍길동', phone: '01012345678' } };
    expect(meSchema.parse(withContact)).toEqual(withContact);
    const { contact: _dropped, ...withoutContact } = sample;
    expect(meSchema.safeParse(withoutContact).success).toBe(false);
  });

  it('rejects a non-string balance', () => {
    expect(
      meSchema.safeParse({ ...sample, balance: { availableCoin: 0, lockedCoin: '0' } }).success,
    ).toBe(false);
  });

  it('validates PATCH /me bodies', () => {
    expect(updateMeBodySchema.parse({ nickname: '새이름' })).toEqual({ nickname: '새이름' });
    expect(updateMeBodySchema.safeParse({ nickname: 'x' }).success).toBe(false);
  });
});
