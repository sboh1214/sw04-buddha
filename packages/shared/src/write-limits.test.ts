import { describe, expect, it } from 'vitest';
import {
  WRITE_LIMIT_ACTIONS,
  WRITE_LIMIT_DAY_SECONDS,
  WRITE_LIMIT_REASONS,
  WRITE_LIMITS,
  writeLimitWindow,
  writeLimitedDetailsSchema,
} from './write-limits.js';

describe('WRITE_LIMITS (#187, ADR-0069 decision 2 #45-15 and decision 7)', () => {
  it('holds the owner’s numbers', () => {
    const table = Object.fromEntries(
      WRITE_LIMIT_ACTIONS.map((action) => [
        action,
        WRITE_LIMITS[action].map(({ seconds, limit }) => [seconds, limit]),
      ]),
    );
    expect(table).toEqual({
      // 근거 글 10분에 3개·하루 20개
      post: [
        [600, 3],
        [86_400, 20],
      ],
      // 댓글·대댓글 1분에 5개·하루 200개
      comment: [
        [60, 5],
        [86_400, 200],
      ],
      // 글·댓글 수정 10분에 10번·하루 50번
      edit: [
        [600, 10],
        [86_400, 50],
      ],
      // 이미지 업로드 하루 50장
      upload: [[86_400, 50]],
    });
  });

  it('names every window once, and a day is the last 24 hours', () => {
    const reasons = WRITE_LIMIT_ACTIONS.flatMap((action) =>
      WRITE_LIMITS[action].map((window) => window.reason),
    );
    expect([...reasons].sort()).toEqual([...WRITE_LIMIT_REASONS].sort());
    expect(WRITE_LIMIT_DAY_SECONDS).toBe(24 * 60 * 60);
    for (const reason of WRITE_LIMIT_REASONS) {
      expect(writeLimitWindow(reason).reason).toBe(reason);
    }
    expect(writeLimitWindow('posts_10m')).toEqual({ reason: 'posts_10m', seconds: 600, limit: 3 });
  });

  it('answers a refusal with the limit and whole minutes to wait', () => {
    expect(
      writeLimitedDetailsSchema.parse({ reason: 'comments_1m', limit: 5, retryAfterSeconds: 60 }),
    ).toEqual({ reason: 'comments_1m', limit: 5, retryAfterSeconds: 60 });
    for (const retryAfterSeconds of [0, 30, 61]) {
      expect(() =>
        writeLimitedDetailsSchema.parse({ reason: 'posts_10m', limit: 3, retryAfterSeconds }),
      ).toThrow();
    }
    expect(() =>
      writeLimitedDetailsSchema.parse({ reason: 'reports_24h', limit: 20, retryAfterSeconds: 60 }),
    ).toThrow();
  });
});
