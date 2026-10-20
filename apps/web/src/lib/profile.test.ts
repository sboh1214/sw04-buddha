import { BIO_MAX_LENGTH, bioTooLongMessage, findExcludedText } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type PublicProfile } from './api';
import {
  PROFILE_SETTINGS_PATH,
  bioDraft,
  bioFormSchema,
  bioLengthText,
  bioToSend,
  interestCategoryLabel,
  interestsChanged,
  isOwnProfile,
  joinedMonthText,
  profileCounts,
  profileItemFailure,
  profilePageMetadata,
  profilePath,
} from './profile';

/**
 * 공개 프로필 on the web (#41, ADR-0078): the address, what the page says of the public items, and
 * MY 설정's 소개 and interest categories — pure functions, so they run here under node.
 */

const profile = (over: Partial<PublicProfile> = {}): PublicProfile => ({
  member: {
    kind: 'member',
    publicId: 'k7m2p9qx4z',
    nickname: '근거왕',
    imageUrl: null,
    isAdmin: false,
  },
  bio: '첫 줄\n둘째 줄',
  interestCategories: [
    { slug: 'economy', nameKo: '경제', parent: null },
    { slug: 'housing', nameKo: '주택', parent: { slug: 'economy', nameKo: '경제' } },
  ],
  joinedMonth: '2026-10',
  postCount: 3,
  commentCount: 1200,
  receivedLikeCount: 0,
  ...over,
});

const refusal = (status: number, code: string, details?: unknown) =>
  new ApiError(status, { code, message: 'x', details } as never);

describe('the profile address (#37-2)', () => {
  it('is the public id under /u, never the nickname', () => {
    expect(profilePath('k7m2p9qx4z')).toBe('/u/k7m2p9qx4z');
    expect(PROFILE_SETTINGS_PATH).toBe('/my/settings');
  });

  it('keeps every answer out of search engines and names the member by the current nickname (#37-1)', () => {
    expect(profilePageMetadata(profile())).toEqual({
      title: `근거왕 | ${copy.appName}`,
      robots: { index: false },
    });
    expect(profilePageMetadata(null)).toEqual({
      title: `${copy.profileNotFound} | ${copy.appName}`,
      robots: { index: false },
    });
  });

  it('is the viewer’s own only by the public id', () => {
    expect(isOwnProfile('k7m2p9qx4z', 'k7m2p9qx4z')).toBe(true);
    expect(isOwnProfile('k7m2p9qx4z', 'zzzzzzzzzz')).toBe(false);
    expect(isOwnProfile('k7m2p9qx4z', undefined)).toBe(false);
  });
});

describe('what the profile says', () => {
  it('says the year and month joined, nothing finer (#37-3)', () => {
    expect(joinedMonthText('2026-10')).toBe('2026년 10월 가입');
    expect(joinedMonthText('2026-01')).toBe('2026년 1월 가입');
    // Never sent; a broken date is worse than none.
    expect(joinedMonthText('2026-13')).toBe('');
    expect(joinedMonthText('2026-10-20')).toBe('');
  });

  it('writes a sub-category after its top-level one (#37-5, #57-7)', () => {
    const [top, sub] = profile().interestCategories;
    expect(interestCategoryLabel(top!)).toBe('경제');
    expect(interestCategoryLabel(sub!)).toBe('경제 › 주택');
  });

  it('counts posts, comments and likes received in the owner’s order, each named for what it counts (#37-4)', () => {
    expect(profileCounts(profile())).toEqual([
      { key: 'posts', label: copy.profilePostCount, value: '3' },
      { key: 'comments', label: copy.profileCommentCount, value: '1,200' },
      { key: 'likes', label: copy.profileReceivedLikes, value: '0' },
    ]);
  });

  it('names no score, rank, skill or reward anywhere on the profile (N04 §4, N05 §2, D5)', () => {
    const keys = Object.keys(copy).filter(
      (key) => key.startsWith('profile') || key.startsWith('bio') || key.startsWith('settingsBio'),
    ) as (keyof typeof copy)[];
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(findExcludedText(copy[key]), key).toEqual([]);
  });
});

describe('MY 설정: the 소개 (#37-3)', () => {
  it('counts the 소개 as the server does: normalised, by code point, a line break one', () => {
    expect(bioDraft('  안녕\r\n😀  ')).toEqual({ bio: '안녕\n😀', length: 4, tooLong: false });
    expect(bioDraft('가'.repeat(BIO_MAX_LENGTH))).toMatchObject({ tooLong: false });
    expect(bioDraft('가'.repeat(BIO_MAX_LENGTH + 1))).toMatchObject({
      length: BIO_MAX_LENGTH + 1,
      tooLong: true,
    });
    expect(bioLengthText(12)).toBe(`12 / ${String(BIO_MAX_LENGTH)}${copy.bioLengthUnit}`);
  });

  it('sends what the server keeps, and null for a blank box, which clears it', () => {
    expect(bioToSend(' 소개 \n')).toBe('소개');
    expect(bioToSend('   \n ')).toBeNull();
    expect(bioToSend('')).toBeNull();
  });

  it('refuses more than the limit before sending, and lets a blank box through', () => {
    expect(bioFormSchema.safeParse({ bio: '' }).success).toBe(true);
    expect(bioFormSchema.safeParse({ bio: '가'.repeat(BIO_MAX_LENGTH) }).success).toBe(true);
    const over = bioFormSchema.safeParse({ bio: '가'.repeat(BIO_MAX_LENGTH + 1) });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toBe(copy.errBioTooLong);
  });

  it('says the same limit the server holds (ADR-0069 decision 3 #37-3)', () => {
    expect(copy.settingsBioHint).toContain(`${String(BIO_MAX_LENGTH)}자`);
    expect(copy.errBioTooLong).toContain(`${String(BIO_MAX_LENGTH)}자`);
  });
});

describe('MY 설정: a refused public-item write', () => {
  it('says what each refusal means', () => {
    expect(
      profileItemFailure(
        refusal(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'other' }]),
      ),
    ).toEqual({ kind: 'notice', message: copy.sessionChanged });
    expect(profileItemFailure(refusal(409, 'ONBOARDING_REQUIRED', { steps: ['consent'] }))).toEqual(
      { kind: 'refresh', message: copy.errPostOnboarding },
    );
    expect(
      profileItemFailure(
        refusal(400, 'VALIDATION_ERROR', [{ path: ['bio'], message: bioTooLongMessage(161) }]),
      ),
    ).toEqual({ kind: 'field', message: copy.errBioTooLong });
    expect(
      profileItemFailure(
        refusal(400, 'VALIDATION_ERROR', [
          { path: ['categoryIds', 0], message: 'not an active category' },
        ]),
      ),
    ).toEqual({ kind: 'categories', message: copy.errInterestsUnavailable });
  });

  it('says nothing of a restriction it cannot tell apart: that is #185’s and #139’s to say', () => {
    // The FORBIDDEN a writing or an account restriction answers for a new value names no field
    // (ADR-0078); so does the CSRF refusal.
    expect(profileItemFailure(refusal(403, 'FORBIDDEN'))).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
    expect(profileItemFailure(new TypeError('Failed to fetch'))).toEqual({
      kind: 'notice',
      message: copy.errNetwork,
    });
  });
});

describe('MY 설정: the interest categories (#37-5, #57-7)', () => {
  const offered = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it('is changed only when the picks among the offered categories differ', () => {
    expect(interestsChanged([1, 2], [2, 1], offered)).toBe(false);
    expect(interestsChanged([1], [1, 2], offered)).toBe(true);
    expect(interestsChanged([], [1], offered)).toBe(true);
    expect(interestsChanged([], [], offered)).toBe(false);
  });

  it('ignores a category the list no longer offers (retired by operators)', () => {
    // The account had 9, retired since: neither shown nor sent, so nothing moved on screen.
    expect(interestsChanged([1], [1, 9], offered)).toBe(false);
  });
});

describe('where the public items are written', () => {
  it('says they show on the public profile, which anyone reads, wherever they are written (#37-1, #37-5)', () => {
    // MY 설정's two cards, the 소개 box itself, and the onboarding's step, where most picks are made.
    for (const key of [
      'settingsBioHint',
      'bioPlaceholder',
      'settingsInterestsHint',
      'interestsIntro',
    ] as const) {
      expect(copy[key], key).toContain('공개 프로필');
      // Not other members only: a visitor who is not logged in reads the profile too.
      expect(copy[key], key).not.toContain('회원에게');
    }
  });
});
