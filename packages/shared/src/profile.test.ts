import { describe, expect, expectTypeOf, it } from 'vitest';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import {
  IMAGE_CONTENT_TYPES,
  IMAGE_MAX_BYTES,
  PROFILE_IMAGE_CONTENT_TYPES,
  PROFILE_IMAGE_SIZE,
  uploadImageQuerySchema,
} from './media.js';
import { type PostAuthor } from './post.js';
import {
  BIO_MAX_LENGTH,
  JOINED_MONTH_PATTERN,
  bioInputSchema,
  bioRefusalOf,
  bioTooLongMessage,
  deleteProfileImageBodySchema,
  normaliseBio,
  profileMemberSchema,
  publicProfileSchema,
  updateBioBodySchema,
  type ProfileMember,
} from './profile.js';

/** The issues' messages of a 소개 that is refused. */
function refusals(bio: unknown): string[] {
  const result = bioInputSchema.safeParse(bio);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('the 소개 (#37-3)', () => {
  it('is plain text, trimmed, its line breaks kept and written as \\n', () => {
    expect(bioInputSchema.parse('  첫 줄\r\n\r\n셋째 줄\r넷째\n  ')).toBe('첫 줄\n\n셋째 줄\n넷째');
    // Markup and addresses are text: nothing is parsed, removed or refused (no links means the
    // profile never draws one, ADR-0078).
    expect(bioInputSchema.parse('<b>굵게</b> https://example.com')).toBe(
      '<b>굵게</b> https://example.com',
    );
  });

  it('drops control characters but a tab, and turns a lone surrogate into U+FFFD', () => {
    expect(normaliseBio('a\u0000b\u0007c\td\u007fe')).toBe('abc\tde');
    const text = JSON.parse('"a\\ud800b😀"') as string;
    expect(bioInputSchema.parse(text)).toBe('a�b😀');
    // The same text sent again is the same text: saving it again changes nothing.
    expect(bioInputSchema.parse(bioInputSchema.parse(text))).toBe(bioInputSchema.parse(text));
  });

  it('is none when nothing is left: empty, blank or null clears it', () => {
    for (const bio of ['', '   ', '\n\r\n\t', '\u0000', null]) {
      expect(bioInputSchema.parse(bio), JSON.stringify(bio)).toBeNull();
    }
    expect(bioInputSchema.safeParse(undefined).success).toBe(false);
    expect(bioInputSchema.safeParse(3).success).toBe(false);
  });

  it('is at most 160 characters, counted in code points, a line break one', () => {
    expect(BIO_MAX_LENGTH).toBe(160);
    expect(bioInputSchema.parse('😀'.repeat(160))).toHaveLength(320);
    expect(bioInputSchema.parse(`${'가'.repeat(80)}\n${'a'.repeat(79)}`)).toHaveLength(160);
    // Counted after trimming.
    expect(bioInputSchema.parse(`  ${'가'.repeat(160)}\n`)).toBe('가'.repeat(160));
    expect(refusals('가'.repeat(161))).toEqual([bioTooLongMessage(161)]);
    expect(refusals(`${'가'.repeat(80)}\n${'a'.repeat(80)}`)).toEqual([bioTooLongMessage(161)]);
    expect(bioRefusalOf(bioTooLongMessage(161))).toEqual({ kind: 'too_long', length: 161 });
    expect(bioRefusalOf('something else')).toBeUndefined();
    expect(bioRefusalOf(`${bioTooLongMessage(1)}x`)).toBeUndefined();
  });

  it('is sent with the account the screen shows, both keys required', () => {
    expect(updateBioBodySchema.parse({ bio: ' 안녕 ', expectedAccountId: 'u1' })).toEqual({
      bio: '안녕',
      expectedAccountId: 'u1',
    });
    expect(updateBioBodySchema.parse({ bio: null, expectedAccountId: 'u1' })).toEqual({
      bio: null,
      expectedAccountId: 'u1',
    });
    expect(updateBioBodySchema.safeParse({ expectedAccountId: 'u1' }).success).toBe(false);
    expect(updateBioBodySchema.safeParse({ bio: '안녕' }).success).toBe(false);
    expect(updateBioBodySchema.safeParse({ bio: '안녕', expectedAccountId: '' }).success).toBe(
      false,
    );
  });
});

describe('the profile image (#141, #37-6)', () => {
  it('fixes the owner’s rules: JPEG, PNG or WebP, 5MB, a square of 512px at most', () => {
    expect(PROFILE_IMAGE_CONTENT_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    // A post's types but the GIF: the store serves both from the same list.
    expect(IMAGE_CONTENT_TYPES).toEqual(expect.arrayContaining([...PROFILE_IMAGE_CONTENT_TYPES]));
    expect(PROFILE_IMAGE_CONTENT_TYPES).not.toContain('image/gif');
    expect(IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(PROFILE_IMAGE_SIZE).toBe(512);
  });

  it('is uploaded and deleted naming the account the screen shows', () => {
    expect(uploadImageQuerySchema.parse({ expectedAccountId: 'u1' })).toEqual({
      expectedAccountId: 'u1',
    });
    expect(deleteProfileImageBodySchema.parse({ expectedAccountId: 'u1' })).toEqual({
      expectedAccountId: 'u1',
    });
    expect(deleteProfileImageBodySchema.safeParse({}).success).toBe(false);
    expect(deleteProfileImageBodySchema.safeParse({ expectedAccountId: '' }).success).toBe(false);
    // Nothing else rides on the deletion: no image id to aim at another member's.
    expect(deleteProfileImageBodySchema.parse({ expectedAccountId: 'u1', imageId: 'x' })).toEqual({
      expectedAccountId: 'u1',
    });
  });
});

describe('the public profile (#41)', () => {
  const profile = {
    member: {
      kind: 'member',
      publicId: 'k7m2p9qx4z',
      nickname: '예측가',
      imageUrl: null,
      isAdmin: false,
    },
    bio: '첫 줄\n둘째 줄',
    interestCategories: [
      { slug: 'economy', nameKo: '경제', parent: null },
      { slug: 'housing', nameKo: '부동산', parent: { slug: 'economy', nameKo: '경제' } },
    ],
    joinedMonth: '2026-10',
    postCount: 3,
    commentCount: 12,
    receivedLikeCount: 7,
  };

  it('parses a profile, and one with nothing optional to show', () => {
    expect(publicProfileSchema.parse(profile)).toEqual(profile);
    const bare = { ...profile, bio: null, interestCategories: [] };
    expect(publicProfileSchema.parse(bare)).toEqual(bare);
  });

  it('names the member by the public face a post’s author has, and nothing more', () => {
    expectTypeOf<ProfileMember>().toEqualTypeOf<Extract<PostAuthor, { kind: 'member' }>>();
    expect(Object.keys(profileMemberSchema.shape).sort()).toEqual(
      ['imageUrl', 'isAdmin', 'kind', 'nickname', 'publicId'].sort(),
    );
    // Not the account id: a public id has the public shape.
    expect(
      publicProfileSchema.safeParse({
        ...profile,
        member: { ...profile.member, publicId: 'Wl2Yb0bJ0tB7xLJXg3YQ2fkZ' },
      }).success,
    ).toBe(false);
  });

  it('shows the joined month and nothing finer (#37-3)', () => {
    for (const month of ['2026-01', '2026-12', '1999-09']) {
      expect(JOINED_MONTH_PATTERN.test(month), month).toBe(true);
    }
    for (const month of ['2026-1', '2026-13', '2026-00', '2026-10-20', '2026-10-20T00:00:00Z']) {
      expect(JOINED_MONTH_PATTERN.test(month), month).toBe(false);
      expect(publicProfileSchema.safeParse({ ...profile, joinedMonth: month }).success).toBe(false);
    }
  });

  it('takes counts as whole numbers from zero', () => {
    for (const key of ['postCount', 'commentCount', 'receivedLikeCount'] as const) {
      expect(publicProfileSchema.safeParse({ ...profile, [key]: -1 }).success, key).toBe(false);
      expect(publicProfileSchema.safeParse({ ...profile, [key]: 1.5 }).success, key).toBe(false);
    }
  });

  it('has no field the public guards refuse', () => {
    // The surface checks read the answer's fields too (apps/api/src/surface); this keeps the shape
    // itself clean of private data and of excluded features (#113) before any route serves it.
    const names = [
      ...Object.keys(publicProfileSchema.shape),
      ...Object.keys(profileMemberSchema.shape),
      'slug',
      'nameKo',
      'parent',
    ];
    expect(
      names.flatMap((name) => [
        ...findPrivateField(name).map((hit) => `${name}: ${hit.item}`),
        ...findExcludedIdentifier(name, 'api').map((hit) => `${name}: ${hit.feature}`),
      ]),
    ).toEqual([]);
  });
});
