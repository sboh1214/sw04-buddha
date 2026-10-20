import { describe, expect, it } from 'vitest';
import { meSchema, updateMeBodySchema } from './me.js';

describe('meSchema', () => {
  const sample = {
    id: 'u1',
    email: 'user@example.com',
    emailVerified: false,
    profile: {
      publicId: 'k7m2p9qx4z',
      nickname: 'user_Q7Z9',
      role: 'user',
      createdAt: '2026-09-03T00:00:00.000Z',
      timeZone: null,
      nicknameChangeAvailableAt: null,
      interestCategoryIds: [],
      bio: null,
      imageUrl: null,
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
    onboarding: {
      consent: false,
      verification: false,
      nickname: false,
      completed: false,
      interests: false,
      nextStep: 'consent',
      consents: [],
    },
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

  it('carries the start grant: pending, granted with an amount, or the number already used (#70, #58)', () => {
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
    // #58 (오너 결정 2026-10-19): the account's number's start Coin is another account's.
    const numberUsed = {
      ...sample,
      startGrant: { status: 'number_used', amountCoin: null, grantedAt: null },
    };
    expect(meSchema.parse(numberUsed)).toEqual(numberUsed);
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

  it('carries the public id public answers name the account by, never in another shape (#46)', () => {
    const { publicId: _dropped, ...withoutId } = sample.profile;
    expect(meSchema.safeParse({ ...sample, profile: withoutId }).success).toBe(false);
    expect(
      meSchema.safeParse({ ...sample, profile: { ...sample.profile, publicId: 'user_Q7Z9' } })
        .success,
    ).toBe(false);
  });

  it('rejects a non-string balance', () => {
    expect(
      meSchema.safeParse({ ...sample, balance: { availableCoin: 0, lockedCoin: '0' } }).success,
    ).toBe(false);
  });

  it('carries the onboarding, the next change of the nickname and the interests (#58)', () => {
    const onboarded = {
      ...sample,
      profile: {
        ...sample.profile,
        nicknameChangeAvailableAt: '2026-11-17T00:00:00.000Z',
        interestCategoryIds: [1, 7],
      },
      onboarding: {
        consent: true,
        verification: true,
        nickname: true,
        completed: true,
        interests: true,
        nextStep: null,
        consents: [
          {
            item: 'terms',
            version: 'draft-2026-10-18',
            agreed: true,
            recordedAt: '2026-10-18T00:00:00.000Z',
          },
        ],
      },
    };
    expect(meSchema.parse(onboarded)).toEqual(onboarded);
    const { onboarding: _dropped, ...withoutOnboarding } = sample;
    expect(meSchema.safeParse(withoutOnboarding).success).toBe(false);
    expect(
      meSchema.safeParse({ ...sample, onboarding: { ...sample.onboarding, nextStep: 'grant' } })
        .success,
    ).toBe(false);
  });

  it('carries the 소개, or null while there is none, and requires the key (#41)', () => {
    const withBio = { ...sample, profile: { ...sample.profile, bio: '첫 줄\n둘째 줄' } };
    expect(meSchema.parse(withBio)).toEqual(withBio);
    const { bio: _dropped, ...profileWithoutBio } = sample.profile;
    expect(meSchema.safeParse({ ...sample, profile: profileWithoutBio }).success).toBe(false);
  });

  it('carries the profile image’s address, or null while there is none, and requires the key (#141)', () => {
    const imageUrl = '/api/v1/media/0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';
    const withImage = { ...sample, profile: { ...sample.profile, imageUrl } };
    expect(meSchema.parse(withImage)).toEqual(withImage);
    const { imageUrl: _dropped, ...profileWithoutImage } = sample.profile;
    expect(meSchema.safeParse({ ...sample, profile: profileWithoutImage }).success).toBe(false);
  });

  it('validates PATCH /me bodies: the nickname and the account the screen shows', () => {
    expect(updateMeBodySchema.parse({ nickname: '새이름', expectedAccountId: 'u1' })).toEqual({
      nickname: '새이름',
      expectedAccountId: 'u1',
    });
    expect(updateMeBodySchema.safeParse({ nickname: 'x', expectedAccountId: 'u1' }).success).toBe(
      false,
    );
    expect(updateMeBodySchema.safeParse({ nickname: '새이름' }).success).toBe(false);
    expect(
      updateMeBodySchema.safeParse({ nickname: '새이름', expectedAccountId: '' }).success,
    ).toBe(false);
  });
});
