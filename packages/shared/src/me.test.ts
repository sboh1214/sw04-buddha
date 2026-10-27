import { describe, expect, it } from 'vitest';
import { meSchema, nicknameSchema, updateMeBodySchema } from './me.js';

describe('nicknameSchema', () => {
  it('accepts Hangul, letters, digits and underscore within 2..20 chars', () => {
    for (const ok of ['user_A7K2', '홍길동', 'user01', 'ab', '가'.repeat(20)]) {
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
    profile: {
      nickname: 'user_Q7Z9',
      role: 'user',
      createdAt: '2026-09-03T00:00:00.000Z',
      timeZone: null,
    },
    balance: { availableCoin: '0', lockedCoin: '0' },
    linkedAccounts: [
      {
        id: 'acc1',
        providerId: 'credential',
        accountId: 'u1',
        createdAt: '2026-09-03T00:00:00.000Z',
      },
    ],
    verification: null,
    startGrant: null,
  };

  it('parses a complete /me payload', () => {
    expect(meSchema.parse(sample)).toEqual(sample);
  });

  it('carries the verification once confirmed, and requires the key either way (ADR-0070)', () => {
    const verified = {
      ...sample,
      verification: {
        realName: '홍길동',
        phone: '01012345678',
        verifiedAt: '2026-10-18T00:00:00.000Z',
      },
    };
    expect(meSchema.parse(verified)).toEqual(verified);
    // The number is the stored digits, never a spelling of them.
    expect(
      meSchema.safeParse({
        ...verified,
        verification: { ...verified.verification, phone: '010-1234-5678' },
      }).success,
    ).toBe(false);
    const { verification: _dropped, ...withoutVerification } = sample;
    expect(meSchema.safeParse(withoutVerification).success).toBe(false);
  });

  it('carries the start grant, pending with no amount or granted with both (#70)', () => {
    const pending = {
      ...sample,
      startGrant: { status: 'pending', amountCoin: null, grantedAt: null },
    };
    expect(meSchema.parse(pending)).toEqual(pending);
    const granted = {
      ...sample,
      startGrant: {
        status: 'granted',
        amountCoin: '10000',
        grantedAt: '2026-10-18T00:00:00.000Z',
      },
    };
    expect(meSchema.parse(granted)).toEqual(granted);
    expect(
      meSchema.safeParse({ ...sample, startGrant: { ...granted.startGrant, status: 'paid' } })
        .success,
    ).toBe(false);
    const { startGrant: _dropped, ...withoutGrant } = sample;
    expect(meSchema.safeParse(withoutGrant).success).toBe(false);
  });

  it('carries the picked time zone, null while the browser is followed, and requires the key', () => {
    const picked = { ...sample, profile: { ...sample.profile, timeZone: 'America/New_York' } };
    expect(meSchema.parse(picked)).toEqual(picked);
    expect(meSchema.parse(sample).profile.timeZone).toBeNull();
    const { timeZone: _dropped, ...withoutZone } = sample.profile;
    expect(meSchema.safeParse({ ...sample, profile: withoutZone }).success).toBe(false);
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
