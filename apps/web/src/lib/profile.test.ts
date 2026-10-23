import {
  BIO_MAX_LENGTH,
  IMAGE_MAX_BYTES,
  PROFILE_IMAGE_CONTENT_TYPES,
  bioTooLongMessage,
  findExcludedText,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type PublicProfile } from './api';
import { formatKst } from './datetime';
import { type Onboarding, isOnboardingExemptPage } from './onboarding';
import {
  PROFILE_IMAGE_ACCEPT,
  PROFILE_SETTINGS_PATH,
  bioDraft,
  bioEdit,
  bioFormSchema,
  bioLengthText,
  bioToSend,
  interestCategoryLabel,
  interestsChanged,
  interestsEdit,
  interestsStepFailure,
  isOwnProfile,
  joinedMonthText,
  profileCounts,
  profileImageContentType,
  profileImageDeleteFailure,
  profileImagePrecheck,
  profileImageRefusalMessage,
  profileImageUploadFailure,
  profileItemFailure,
  profileItemRefusalMove,
  profileItemSaveGoesToStep,
  profilePageMetadata,
  profilePath,
} from './profile';

/**
 * 공개 프로필 on the web (#41, ADR-0078): the address, what the page says of the public items, and
 * MY 설정's image (#141, ADR-0079), 소개 and interest categories — pure functions, so they run here
 * under node.
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
        formatKst,
      ),
    ).toEqual({ kind: 'notice', message: copy.sessionChanged });
    expect(
      profileItemFailure(refusal(409, 'ONBOARDING_REQUIRED', { steps: ['consent'] }), formatKst),
    ).toEqual({ kind: 'refresh', message: copy.errPostOnboarding });
    expect(
      profileItemFailure(
        refusal(400, 'VALIDATION_ERROR', [{ path: ['bio'], message: bioTooLongMessage(161) }]),
        formatKst,
      ),
    ).toEqual({ kind: 'field', message: copy.errBioTooLong });
    expect(
      profileItemFailure(
        refusal(400, 'VALIDATION_ERROR', [
          { path: ['categoryIds', 0], message: 'not an active category' },
        ]),
        formatKst,
      ),
    ).toEqual({ kind: 'categories', message: copy.errInterestsUnavailable });
  });

  it('says a writing restriction with its end and that clearing stays open — no appeal sentence (#185)', () => {
    // RESTRICTED (owner decision 2026-10-21 answer 8 on #41): a code of its own with the end.
    const endsAt = '2026-10-23T06:00:00.000Z';
    expect(
      profileItemFailure(refusal(403, 'RESTRICTED', { kind: 'writing', endsAt }), formatKst),
    ).toEqual({
      kind: 'notice',
      message: `${copy.errRestrictedProfile}(${formatKst(endsAt)}까지). ${copy.errRestrictedClearAllowed}`,
    });
    expect(
      profileItemFailure(refusal(403, 'RESTRICTED', { kind: 'writing', endsAt: null }), formatKst),
    ).toEqual({
      kind: 'notice',
      message: `${copy.errRestrictedProfile}(무기한). ${copy.errRestrictedClearAllowed}`,
    });
    // A FORBIDDEN that names no field is the CSRF refusal: the generic sentence.
    expect(profileItemFailure(refusal(403, 'FORBIDDEN'), formatKst)).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
    expect(profileItemFailure(new TypeError('Failed to fetch'), formatKst)).toEqual({
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

describe('MY 설정 for an account facing a re-consent (owner decision 2026-10-21 answer 2)', () => {
  /** `GET /me`'s onboarding: everything done, then a revision asked for the consent again. */
  const done: Onboarding = {
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
  };
  const reconsent: Onboarding = { ...done, consent: false, completed: false, nextStep: 'consent' };
  /** Agreed once, left before the 본인확인, then a revision: never finished. */
  const notFinished: Onboarding = {
    ...reconsent,
    verification: false,
    nickname: false,
  };
  const onboardingRefusal = refusal(409, 'ONBOARDING_REQUIRED', { steps: ['consent'] });

  it('is a page the gate keeps such an account on', () => {
    expect(isOnboardingExemptPage(PROFILE_SETTINGS_PATH)).toBe(true);
  });

  it('tells a deletion from a new value as the server does', () => {
    expect(bioEdit(null)).toBe('clear');
    expect(bioEdit(bioToSend('   \n  '))).toBe('clear');
    expect(bioEdit(bioToSend(' 새 소개 '))).toBe('replace');
    // Dropping some or all is a deletion; anything the account did not have is a new value, even
    // beside a drop (ADR-0078 7-11).
    expect(interestsEdit([], [1, 2])).toBe('clear');
    expect(interestsEdit([2], [1, 2])).toBe('clear');
    expect(interestsEdit([1, 2], [1, 2])).toBe('clear');
    expect(interestsEdit([1, 3], [1, 2])).toBe('replace');
    expect(interestsEdit([3], [])).toBe('replace');
  });

  it('sends a deletion with a session alone and takes a new value to the step', () => {
    expect(profileItemSaveGoesToStep('clear', true)).toBe(false);
    expect(profileItemSaveGoesToStep('replace', true)).toBe(true);
    // Nothing left, or not known yet: sent — the server decides.
    expect(profileItemSaveGoesToStep('replace', false)).toBe(false);
    expect(profileItemSaveGoesToStep('clear', false)).toBe(false);
  });

  it('moves a save refused for the onboarding to the step on MY 설정, without a word', () => {
    expect(
      profileItemRefusalMove(onboardingRefusal, {
        pathname: PROFILE_SETTINGS_PATH,
        onboarding: reconsent,
      }),
    ).toBe('step');
  });

  it('leaves it to the gate for an onboarding not finished', () => {
    expect(
      profileItemRefusalMove(onboardingRefusal, {
        pathname: PROFILE_SETTINGS_PATH,
        onboarding: notFinished,
      }),
    ).toBe('gate');
  });

  it('says why when there is nowhere to go: `GET /me` not read again or naming no step, another page, another refusal', () => {
    for (const onboarding of [undefined, done]) {
      expect(
        profileItemRefusalMove(onboardingRefusal, { pathname: PROFILE_SETTINGS_PATH, onboarding }),
      ).toBeUndefined();
    }
    expect(
      profileItemRefusalMove(onboardingRefusal, { pathname: '/my/settingsx', onboarding: done }),
    ).toBeUndefined();
    expect(
      profileItemRefusalMove(refusal(403, 'FORBIDDEN'), {
        pathname: PROFILE_SETTINGS_PATH,
        onboarding: reconsent,
      }),
    ).toBeUndefined();
    // What the card then says.
    expect(profileItemFailure(onboardingRefusal, formatKst)).toEqual({
      kind: 'refresh',
      message: copy.errPostOnboarding,
    });
  });
});

describe('the onboarding’s interests step: a refused answer', () => {
  it('says a writing restriction on a late pick with its end, or 무기한, that 건너뛰기 stays open, and the way to 조치·신고 내역 — nothing to clear on that screen (#185)', () => {
    // A pick past the 24 hours after the nickname step is a change (ADR-0078 3rd answer 1).
    const endsAt = '2026-10-23T06:00:00.000Z';
    expect(
      interestsStepFailure(refusal(403, 'RESTRICTED', { kind: 'writing', endsAt }), formatKst),
    ).toEqual({
      message: `${copy.errRestrictedProfile}(${formatKst(endsAt)}까지). ${copy.errRestrictedSkipAllowed}`,
      restricted: true,
      refetchCategories: false,
    });
    const indefinite = interestsStepFailure(
      refusal(403, 'RESTRICTED', { kind: 'writing', endsAt: null }),
      formatKst,
    );
    // Owner decision 2026-10-23 answer 9: '건너뛰기는 할 수 있습니다.' after the end.
    expect(indefinite).toEqual({
      message:
        '작성 제한 중에는 공개 프로필을 새 값으로 바꿀 수 없습니다(무기한). 건너뛰기는 할 수 있습니다.',
      restricted: true,
      refetchCategories: false,
    });
    // MY 설정's sentence that clearing stays open is not this screen's: it has nothing to clear.
    expect(indefinite.message).not.toContain(copy.errRestrictedClearAllowed);
  });

  it('says the rest as before, none of it with the way to 조치·신고 내역', () => {
    expect(
      interestsStepFailure(
        refusal(400, 'VALIDATION_ERROR', [
          { path: ['categoryIds', 0], message: 'not an active category' },
        ]),
        formatKst,
      ),
    ).toEqual({
      message: copy.errInterestsUnavailable,
      restricted: false,
      refetchCategories: true,
    });
    expect(
      interestsStepFailure(refusal(409, 'ONBOARDING_REQUIRED', { steps: ['consent'] }), formatKst),
    ).toEqual({
      message: copy.errOnboardingStepsFirst,
      restricted: false,
      refetchCategories: false,
    });
    expect(
      interestsStepFailure(
        refusal(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'other' }]),
        formatKst,
      ),
    ).toEqual({ message: copy.sessionChanged, restricted: false, refetchCategories: false });
    expect(interestsStepFailure(new TypeError('Failed to fetch'), formatKst)).toEqual({
      message: copy.errUnknown,
      restricted: false,
      refetchCategories: false,
    });
  });
});

describe('MY 설정: the image (#141, #37-6)', () => {
  const refused = (reason: string) => refusal(422, 'IMAGE_NOT_ALLOWED', { reason });

  it('offers and sends the three types the server takes, and no GIF', () => {
    expect(PROFILE_IMAGE_CONTENT_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(PROFILE_IMAGE_ACCEPT).toBe('image/jpeg,image/png,image/webp');
    expect(profileImageContentType({ type: 'image/webp' })).toBe('image/webp');
    expect(profileImageContentType({ type: 'image/jpeg' })).toBe('image/jpeg');
    // No declared type: the bytes go as bytes, and the server reads them.
    expect(profileImageContentType({ type: '' })).toBe('application/octet-stream');
  });

  it('refuses before sending what the server would refuse anyway, with its reason', () => {
    expect(profileImagePrecheck({ type: 'image/png', size: 0 })).toBe('empty');
    expect(profileImagePrecheck({ type: 'image/jpeg', size: IMAGE_MAX_BYTES + 1 })).toBe('size');
    expect(profileImagePrecheck({ type: 'image/jpeg', size: IMAGE_MAX_BYTES })).toBeUndefined();
    // A post takes a GIF; a profile image does not (#37-6: «JPEG·PNG·WebP»).
    expect(profileImagePrecheck({ type: 'image/gif', size: 100 })).toBe('type');
    expect(profileImagePrecheck({ type: 'image/heic', size: 100 })).toBe('type');
    // Nothing declared: it goes up, and the server decides by the bytes.
    expect(profileImagePrecheck({ type: '', size: 100 })).toBeUndefined();
  });

  it('says the profile image’s own rule for a type or a size, and a post image’s words otherwise', () => {
    expect(profileImageRefusalMessage('type')).toBe(copy.errProfileImageType);
    expect(profileImageRefusalMessage('size')).toBe(copy.errProfileImageSize);
    expect(copy.errProfileImageType).toContain('JPEG·PNG·WebP');
    expect(copy.errProfileImageType).not.toContain('GIF');
    expect(copy.errProfileImageSize).toContain('5MB');
    // The card's hint says the same rule before anything is picked.
    expect(copy.settingsProfileImageHint).toContain('JPEG·PNG·WebP');
    expect(copy.settingsProfileImageHint).not.toContain('GIF');
    expect(copy.settingsProfileImageHint).toContain('5MB');
    expect(profileImageRefusalMessage('pixels')).toBe(copy.errImageTooLarge);
    expect(profileImageRefusalMessage('unreadable')).toBe(copy.errImageUnreadable);
    expect(profileImageRefusalMessage('empty')).toBe(copy.errImageEmpty);
  });

  it('says what each refused upload means', () => {
    expect(profileImageUploadFailure(refused('type'), formatKst)).toBe(copy.errProfileImageType);
    expect(profileImageUploadFailure(refused('size'), formatKst)).toBe(copy.errProfileImageSize);
    expect(profileImageUploadFailure(refused('unreadable'), formatKst)).toBe(
      copy.errImageUnreadable,
    );
    // A reason the route does not name is a failed upload.
    expect(profileImageUploadFailure(refused('later'), formatKst)).toBe(copy.errImageUpload);
    // Fastify's own cut-off, twice the limit: the size.
    expect(profileImageUploadFailure(refusal(413, 'VALIDATION_ERROR'), formatKst)).toBe(
      copy.errProfileImageSize,
    );
    expect(
      profileImageUploadFailure(
        refusal(403, 'FORBIDDEN', [
          { path: ['expectedAccountId'], message: 'session belongs to another account' },
        ]),
        formatKst,
      ),
    ).toBe(copy.sessionChanged);
    expect(
      profileImageUploadFailure(
        refusal(409, 'ONBOARDING_REQUIRED', { steps: ['consent'] }),
        formatKst,
      ),
    ).toBe(copy.errPostOnboarding);
    // A FORBIDDEN that names no field (the CSRF refusal) is a failed upload.
    expect(profileImageUploadFailure(refusal(403, 'FORBIDDEN'), formatKst)).toBe(
      copy.errImageUpload,
    );
    // A writing restriction (#185): a public profile item's refusal, its deletion left open.
    expect(
      profileImageUploadFailure(
        refusal(403, 'RESTRICTED', { kind: 'writing', endsAt: null }),
        formatKst,
      ),
    ).toBe(`${copy.errRestrictedProfile}(무기한). ${copy.errRestrictedClearAllowed}`);
    expect(profileImageUploadFailure(new TypeError('Failed to fetch'), formatKst)).toBe(
      copy.errNetwork,
    );
  });

  it('says what a refused deletion means', () => {
    expect(
      profileImageDeleteFailure(
        refusal(403, 'FORBIDDEN', [
          { path: ['expectedAccountId'], message: 'session belongs to another account' },
        ]),
      ),
    ).toBe(copy.sessionChanged);
    expect(profileImageDeleteFailure(new TypeError('Failed to fetch'))).toBe(copy.errNetwork);
    expect(profileImageDeleteFailure(refusal(500, 'INTERNAL'))).toBe(copy.errProfileImageDelete);
  });
});

describe('where the public items are written', () => {
  it('says they show on the public profile, which anyone reads, wherever they are written (#37-1, #37-5)', () => {
    // MY 설정's cards, the 소개 box itself, and the onboarding's step, where most picks are made.
    for (const key of [
      'settingsProfileImageHint',
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
