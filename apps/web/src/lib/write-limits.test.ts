import {
  WRITE_LIMITS,
  WRITE_LIMIT_REASONS,
  type WriteLimitReason,
  writeLimitWindow,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError } from './api';
import { formatInTimeZone, formatKst } from './datetime';
import { writeLimitMessage, writeLimitedMessage, writeRetryAt } from './write-limits';

/**
 * 작성 빈도 제한 (#187, ADR-0083) as the writer reads a refusal: which limit, and the time it can
 * write again (ADR-0069 decision 4 #187 «다시 쓸 수 있는 시각을 보인다»).
 */

/** 2026-10-21 15:41:30 in Seoul. */
const RECEIVED_AT = Date.parse('2026-10-21T06:41:30.000Z');

const limited = (
  reason: WriteLimitReason,
  retryAfterSeconds: number,
  receivedAt: number = RECEIVED_AT,
  limit: number = writeLimitWindow(reason).limit,
) =>
  new ApiError(
    429,
    {
      code: 'WRITE_LIMITED',
      message: 'Too many writes',
      details: { reason, limit, retryAfterSeconds },
    },
    receivedAt,
  );

describe('the limits’ sentences', () => {
  it('say the owner’s numbers, the same as WRITE_LIMITS: the count and the window', () => {
    const windowWords: Record<number, string> = { 60: '1분', 600: '10분', 86_400: '24시간' };
    const unit: Record<string, string> = { post: '개', comment: '개', edit: '번', upload: '장' };
    for (const [action, windows] of Object.entries(WRITE_LIMITS)) {
      for (const window of windows) {
        const sentence = writeLimitMessage(window.reason);
        expect(sentence, window.reason).toContain(`${windowWords[window.seconds]!} 동안`);
        expect(sentence, window.reason).toContain(
          `${window.limit.toLocaleString('ko-KR')}${unit[action]!}까지`,
        );
      }
    }
  });

  it('name what each counts: posts, comments and replies together, edits of both, both images', () => {
    expect(copy.errWriteLimitPosts10m).toContain('근거 글');
    expect(copy.errWriteLimitPosts24h).toContain('근거 글');
    for (const sentence of [copy.errWriteLimitComments1m, copy.errWriteLimitComments24h]) {
      expect(sentence).toContain('댓글과 답글');
    }
    for (const sentence of [copy.errWriteLimitEdits10m, copy.errWriteLimitEdits24h]) {
      expect(sentence).toContain('글과 댓글');
      expect(sentence).toContain('고칠');
    }
    // Owner decision 2026-10-22 (ADR-0079): a profile image counts with a post's images.
    expect(copy.errWriteLimitUploads24h).toContain('프로필 이미지');
    // One sentence per reason, none shared.
    const sentences = WRITE_LIMIT_REASONS.map(writeLimitMessage);
    expect(new Set(sentences).size).toBe(WRITE_LIMIT_REASONS.length);
  });
});

describe('the time it can write again', () => {
  it('is the server’s wait from when the answer arrived, rounded up to the minute', () => {
    // 15:41:30 + 2 minutes = 15:43:30: shown as 15:44, never 15:43 when it is still refused.
    expect(
      writeRetryAt({ reason: 'posts_10m', limit: 3, retryAfterSeconds: 120 }, RECEIVED_AT),
    ).toBe('2026-10-21T06:44:00.000Z');
    // On the minute already: kept.
    const onTheMinute = Date.parse('2026-10-21T06:41:00.000Z');
    expect(
      writeRetryAt({ reason: 'comments_1m', limit: 5, retryAfterSeconds: 60 }, onTheMinute),
    ).toBe('2026-10-21T06:42:00.000Z');
    // A day's wait crosses the date.
    expect(
      writeRetryAt({ reason: 'posts_24h', limit: 20, retryAfterSeconds: 86_400 }, RECEIVED_AT),
    ).toBe('2026-10-22T06:42:00.000Z');
  });

  it('follows the limit’s sentence, in the screen’s zone, with the verb of what it holds back', () => {
    expect(writeLimitedMessage(limited('posts_10m', 600), formatKst)).toBe(
      `${copy.errWriteLimitPosts10m} 2026. 10. 21. 오후 3:52${copy.writeLimitRetryWrite}`,
    );
    expect(writeLimitedMessage(limited('comments_1m', 60), formatKst)).toBe(
      `${copy.errWriteLimitComments1m} 2026. 10. 21. 오후 3:43${copy.writeLimitRetryWrite}`,
    );
    expect(writeLimitedMessage(limited('edits_10m', 540), formatKst)).toBe(
      `${copy.errWriteLimitEdits10m} 2026. 10. 21. 오후 3:51${copy.writeLimitRetryEdit}`,
    );
    expect(writeLimitedMessage(limited('uploads_24h', 3_600), formatKst)).toBe(
      `${copy.errWriteLimitUploads24h} 2026. 10. 21. 오후 4:42${copy.writeLimitRetryUpload}`,
    );
    expect(copy.writeLimitRetryWrite).toBe('부터 다시 쓸 수 있습니다.');
    // A member who picked another zone reads it there, marked (ADR-0063).
    expect(
      writeLimitedMessage(limited('posts_24h', 3_600), (iso) =>
        formatInTimeZone(iso, 'America/New_York'),
      ),
    ).toBe(
      `${copy.errWriteLimitPosts24h} 2026. 10. 21. 오전 3:42 (GMT-4)${copy.writeLimitRetryWrite}`,
    );
  });

  it('names the same time on every render: the instant is the answer’s, not the render’s', () => {
    const error = limited('posts_10m', 600);
    const first = writeLimitedMessage(error, formatKst);
    // However late the screen words it again (a comment box reads its refusal on every render).
    expect(writeLimitedMessage(error, formatKst)).toBe(first);
    // An answer that arrived a minute later names a minute later.
    expect(writeLimitedMessage(limited('posts_10m', 600, RECEIVED_AT + 60_000), formatKst)).toBe(
      `${copy.errWriteLimitPosts10m} 2026. 10. 21. 오후 3:53${copy.writeLimitRetryWrite}`,
    );
  });

  it('says to wait and try again when the refusal’s details cannot be read', () => {
    const odd = (details: unknown) =>
      new ApiError(429, { code: 'WRITE_LIMITED', message: 'x', details }, RECEIVED_AT);
    expect(writeLimitedMessage(odd(undefined), formatKst)).toBe(copy.errWriteLimited);
    expect(
      writeLimitedMessage(odd({ reason: 'posts_1h', limit: 3, retryAfterSeconds: 60 }), formatKst),
    ).toBe(copy.errWriteLimited);
    expect(
      writeLimitedMessage(odd({ reason: 'posts_10m', limit: 3, retryAfterSeconds: 90 }), formatKst),
    ).toBe(copy.errWriteLimited);
  });

  it('leaves every other answer to the screen that asked', () => {
    expect(
      writeLimitedMessage(
        new ApiError(429, {
          code: 'RATE_LIMITED',
          message: 'x',
          details: { retryAfterSeconds: 60 },
        }),
        formatKst,
      ),
    ).toBeUndefined();
    expect(writeLimitedMessage(new TypeError('Failed to fetch'), formatKst)).toBeUndefined();
    expect(writeLimitedMessage(undefined, formatKst)).toBeUndefined();
  });
});
