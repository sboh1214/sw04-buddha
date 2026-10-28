import { describe, expect, it } from 'vitest';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import {
  LIKE_NOT_ALLOWED_REASONS,
  likeCountSchema,
  likeNotAllowedDetailsSchema,
  likeStateSchema,
  myPostLikesSchema,
  updateLikeBodySchema,
} from './like.js';

const ID = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';

describe('likeCountSchema', () => {
  it('is a count: a whole number, never below zero', () => {
    expect(likeCountSchema.parse(0)).toBe(0);
    expect(likeCountSchema.parse(12)).toBe(12);
    for (const count of [-1, 1.5, '3', null]) {
      expect(likeCountSchema.safeParse(count).success, String(count)).toBe(false);
    }
  });
});

describe('likeStateSchema and myPostLikesSchema', () => {
  it('say the caller’s own state and the public count, and nobody else’s', () => {
    expect(likeStateSchema.parse({ liked: true, likeCount: 1 })).toEqual({
      liked: true,
      likeCount: 1,
    });
    expect(Object.keys(likeStateSchema.shape)).toEqual(['liked', 'likeCount']);
    expect(myPostLikesSchema.parse({ postLiked: false, likedCommentIds: [ID] })).toEqual({
      postLiked: false,
      likedCommentIds: [ID],
    });
    expect(myPostLikesSchema.safeParse({ postLiked: false, likedCommentIds: ['x'] }).success).toBe(
      false,
    );
  });

  it('names what PRIVATE_DATA keeps out of every public shape, the count aside (#49)', () => {
    // The owner-only answers may say whether the caller liked; a public one never may, and no
    // public one lists who liked. The count is public.
    expect(findPrivateField('liked').map((hit) => hit.item)).toEqual(['likers']);
    expect(findPrivateField('postLiked').map((hit) => hit.item)).toEqual(['likers']);
    expect(findPrivateField('likedCommentIds').map((hit) => hit.item)).toEqual(['likers']);
    expect(findPrivateField('likeCount')).toEqual([]);
  });

  it('names no excluded feature: a like is display only, never a reward or a score (D5)', () => {
    for (const name of ['likeCount', 'liked', 'postLiked', 'likedCommentIds', 'LikeState']) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
    }
  });
});

describe('updateLikeBodySchema', () => {
  const account = { expectedAccountId: 'user-1' };

  it('sets the state either way', () => {
    expect(updateLikeBodySchema.parse({ liked: true, ...account })).toEqual({
      liked: true,
      ...account,
    });
    expect(updateLikeBodySchema.parse({ liked: false, ...account })).toEqual({
      liked: false,
      ...account,
    });
  });

  it('requires the state and the account the screen shows (A-PG-24)', () => {
    for (const body of [account, { liked: null, ...account }, { liked: 'true', ...account }]) {
      const parsed = updateLikeBodySchema.safeParse(body);
      expect({ body, success: parsed.success }).toEqual({ body, success: false });
      expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([['liked']]);
    }
    for (const expectedAccountId of [undefined, '', 'x'.repeat(256)]) {
      expect(updateLikeBodySchema.safeParse({ liked: true, expectedAccountId }).success).toBe(
        false,
      );
    }
  });
});

describe('likeNotAllowedDetailsSchema', () => {
  it('names why a target takes no like: deleted to its placeholder, or hidden', () => {
    expect(LIKE_NOT_ALLOWED_REASONS).toEqual(['deleted', 'hidden']);
    for (const reason of LIKE_NOT_ALLOWED_REASONS) {
      expect(likeNotAllowedDetailsSchema.parse({ reason })).toEqual({ reason });
    }
    expect(likeNotAllowedDetailsSchema.safeParse({ reason: 'own' }).success).toBe(false);
  });
});
