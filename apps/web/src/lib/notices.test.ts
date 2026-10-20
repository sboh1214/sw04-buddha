import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  NOTICE_PIN_LIMIT,
  NOTICE_TITLE_MAX_LENGTH,
  POST_BODY_MAX_LENGTH,
  POST_TITLE_MAX_LENGTH,
  postImageNotUsableMessage,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { SRC } from '@/test/screen-text';
import { ApiError } from './api';
import { PRIVATE_QUERY_ROOTS } from './market-keys';
import {
  ADMIN_NOTICES_KEY,
  ADMIN_NOTICES_PATH,
  ADMIN_NOTICE_NEW_PATH,
  NOTICES_KEY,
  PINNED_NOTICES_KEY,
  adminNoticeKey,
  adminNoticeListKey,
  adminNoticeListQuery,
  adminNoticeMissing,
  adminNoticePath,
  noticeDescription,
  noticePath,
  noticeSaveToast,
  noticeWriteErrorMessage,
  pinnedNoticesView,
} from './notices';
import { titleTooLong } from './post-editor';
import { POSTS_KEY } from './posts';

/**
 * 운영 공지's addresses, keys and refusals (#138, ADR-0077): pure functions, so they run here under
 * node. The pages and the hooks only wire these.
 */

const NOTICE = 'C1D2E3F4-A5B6-4C7D-8E9F-0A1B2C3D4E5F';
const notice = NOTICE.toLowerCase();

const refusal = (status: number, code: string, details?: unknown) =>
  new ApiError(status, { code, message: 'x', details } as never);

/** The page file a route's address is drawn by, under app/. */
const pageOf = (...segments: string[]) => path.join(SRC, 'app', ...segments, 'page.tsx');

describe('the addresses', () => {
  it('opens a notice under the community, and the admin screens under /admin', () => {
    expect(noticePath(notice)).toBe(`/community/notices/${notice}`);
    expect(ADMIN_NOTICES_PATH).toBe('/admin/notices');
    expect(ADMIN_NOTICE_NEW_PATH).toBe('/admin/notices/new');
    expect(adminNoticePath(notice)).toBe(`/admin/notices/${notice}`);
    // Each address has its page.
    expect(existsSync(pageOf('community', 'notices', '[noticeId]'))).toBe(true);
    expect(existsSync(pageOf('admin', 'notices'))).toBe(true);
    expect(existsSync(pageOf('admin', 'notices', 'new'))).toBe(true);
    expect(existsSync(pageOf('admin', 'notices', '[noticeId]'))).toBe(true);
  });
});

describe('the cache keys', () => {
  it('keeps the public reads under their own public root, apart from the posts', () => {
    expect(PINNED_NOTICES_KEY).toEqual(['notices', 'pinned']);
    expect(PINNED_NOTICES_KEY.slice(0, 1)).toEqual(NOTICES_KEY);
    expect(NOTICES_KEY[0]).not.toBe(POSTS_KEY[0]);
    expect(PRIVATE_QUERY_ROOTS.has(NOTICES_KEY[0])).toBe(false);
  });

  it('keeps the admin reads under the private admin root, one list per state and one notice per id', () => {
    expect(PRIVATE_QUERY_ROOTS.has(ADMIN_NOTICES_KEY[0])).toBe(true);
    expect(adminNoticeListKey('pinned')).toEqual(['admin', 'notices', 'list', 'pinned']);
    expect(adminNoticeListKey('unpinned')).toEqual(['admin', 'notices', 'list', 'unpinned']);
    expect(adminNoticeKey(NOTICE)).toEqual(['admin', 'notices', 'notice', notice]);
  });

  it('asks for a list by its state, and for the next page with the cursor', () => {
    expect(adminNoticeListQuery('pinned')).toEqual({ state: 'pinned' });
    expect(adminNoticeListQuery('unpinned', 'c2')).toEqual({ state: 'unpinned', cursor: 'c2' });
  });
});

describe('how a notice is drawn', () => {
  it('describes a notice by the start of its text, on one line, without cutting an emoji', () => {
    const body = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph' as const,
          content: [{ type: 'text' as const, text: '점검', marks: [{ type: 'bold' as const }] }],
        },
        { type: 'paragraph' as const, content: [{ type: 'text' as const, text: '😀안내' }] },
      ],
    };
    expect(noticeDescription(body, 160)).toBe('점검 😀안내');
    expect(noticeDescription(body, 4)).toBe('점검 😀');
  });

  it('says what the save did as the API answers it, whatever `editedAt` the screen held', () => {
    // Review on #138: the toast was a guess from the `editedAt` the edit screen held. Another
    // admin's edit the screen had not read yet moved it, so a save of what that edit already said
    // — nothing written — read as '공지를 고쳤습니다.'. `changed` is the server's own word.
    // The answers as they come: the notice moved by the other admin's edit, and the word.
    const theirs = { editedAt: '2026-10-20T01:00:00.000Z' };
    const unchanged = { notice: theirs, changed: false };
    const changed = { notice: theirs, changed: true };
    expect(noticeSaveToast(unchanged)).toEqual({
      type: 'info',
      title: copy.adminNoticeUnchanged,
    });
    expect(noticeSaveToast(changed)).toEqual({
      type: 'success',
      title: copy.adminNoticeSaved,
    });
  });
});

describe('the fixed area above the community list (ADR-0077 decision 8-10)', () => {
  const row = { id: notice, title: '점검 안내' };
  const state = {
    isPending: false,
    isLoadingError: false,
    isRefetchError: false,
    data: [row] as (typeof row)[] | undefined,
  };

  it('draws nothing while the first read is pending, and nothing when no notice is pinned', () => {
    expect(pinnedNoticesView({ ...state, isPending: true, data: undefined })).toEqual({
      kind: 'none',
    });
    expect(pinnedNoticesView({ ...state, data: [] })).toEqual({ kind: 'none' });
  });

  it('says a first read failed, with 다시 시도, and keeps the rows when a later refresh fails', () => {
    expect(pinnedNoticesView({ ...state, isLoadingError: true, data: undefined })).toEqual({
      kind: 'error',
    });
    expect(pinnedNoticesView(state)).toEqual({ kind: 'rows', rows: [row], refreshFailed: false });
    expect(pinnedNoticesView({ ...state, isRefetchError: true })).toEqual({
      kind: 'rows',
      rows: [row],
      refreshFailed: true,
    });
  });
});

describe('the admin edit screen', () => {
  it('opened at an unknown id or at a segment that is not a uuid, finds no notice', () => {
    expect(adminNoticeMissing(refusal(404, 'NOT_FOUND'))).toBe(true);
    expect(
      adminNoticeMissing(
        refusal(400, 'VALIDATION_ERROR', [{ path: ['noticeId'], message: 'Invalid UUID' }]),
      ),
    ).toBe(true);
    // Anything else is the screen's generic failure.
    expect(adminNoticeMissing(refusal(403, 'FORBIDDEN'))).toBe(false);
    expect(adminNoticeMissing(refusal(500, 'INTERNAL'))).toBe(false);
    expect(adminNoticeMissing(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('a refused admin write', () => {
  it('says the fixed area is full, and to unpin one first', () => {
    expect(
      noticeWriteErrorMessage(
        refusal(409, 'NOTICE_PIN_LIMIT_REACHED', { limit: NOTICE_PIN_LIMIT }),
      ),
    ).toBe(copy.errNoticePinLimit);
  });

  it('tells the title apart from the body, whose refusals read as a post’s', () => {
    expect(
      noticeWriteErrorMessage(
        refusal(400, 'VALIDATION_ERROR', [{ path: ['title'], message: 'required' }]),
      ),
    ).toBe(copy.errNoticeTitle);
    expect(
      noticeWriteErrorMessage(
        refusal(400, 'VALIDATION_ERROR', [
          { path: ['body'], message: postImageNotUsableMessage(notice) },
        ]),
      ),
    ).toBe(copy.errPostImageUnusable);
    expect(
      noticeWriteErrorMessage(
        refusal(400, 'VALIDATION_ERROR', [{ path: ['noticeId'], message: 'x' }]),
      ),
    ).toBe(copy.errPostInvalid);
  });

  it('names a notice that is not there, a revoked admin, the onboarding and an unreachable server', () => {
    expect(noticeWriteErrorMessage(refusal(404, 'NOT_FOUND'))).toBe(copy.adminNoticeNotFound);
    expect(noticeWriteErrorMessage(refusal(403, 'FORBIDDEN'))).toBe(copy.adminOnly);
    expect(noticeWriteErrorMessage(refusal(409, 'ONBOARDING_REQUIRED'))).toBe(
      copy.errPostOnboarding,
    );
    expect(noticeWriteErrorMessage(new TypeError('Failed to fetch'))).toBe(copy.errNetwork);
    expect(noticeWriteErrorMessage(refusal(500, 'INTERNAL'))).toBe(copy.errUnknown);
  });
});

describe('the copy', () => {
  it('names the limits the shared constants hold (ADR-0069 decision 2 #45-8 and decision 4 #138)', () => {
    const number = (value: number) => value.toLocaleString('ko-KR');
    expect(copy.errNoticePinLimit).toContain(`${String(NOTICE_PIN_LIMIT)}개`);
    expect(copy.adminNoticesIntro).toContain(`${String(NOTICE_PIN_LIMIT)}개`);
    expect(copy.errNoticeTitle).toContain(`${number(NOTICE_TITLE_MAX_LENGTH)}자`);
    // The notice form is the post form, whose body count is the post body's 5,000 (#138).
    expect(copy.errPostBodyTooLong).toContain(`${number(POST_BODY_MAX_LENGTH)}자`);
  });

  it('holds a notice title to the limit the post form counts, which is one number', () => {
    // The form's title check is the post's (`titleTooLong`, POST_TITLE_MAX_LENGTH): it says the
    // same as the server's notice rule only while the two limits are one.
    expect(NOTICE_TITLE_MAX_LENGTH).toBe(POST_TITLE_MAX_LENGTH);
    expect(titleTooLong('가'.repeat(NOTICE_TITLE_MAX_LENGTH))).toBe(false);
    expect(titleTooLong('가'.repeat(NOTICE_TITLE_MAX_LENGTH + 1))).toBe(true);
  });

  it('tells the admin, before writing, that an unpinned notice is public at its address', () => {
    // ADR-0077 decision 8-1 (an open question to the owner): every notice is readable at its
    // address, pinned or not. The intro is on the list and on the write screen, so it names the
    // list rather than 'here'.
    expect(copy.adminNoticesIntro).toContain('고정하지 않은 공지도');
    expect(copy.adminNoticesIntro).toContain('주소로 누구나 읽을 수 있');
    expect(copy.adminNoticesIntro).toContain('공지 목록에 남아');
    expect(copy.adminNoticesIntro).not.toContain('여기');
  });

  it('writes notices as 운영팀, and marks them 공지 — no operator, no admin mark', () => {
    expect(copy.noticeAuthor).toBe('운영팀');
    expect(copy.noticeBadge).toBe('공지');
    expect(copy.noticeAuthor).not.toBe(copy.postAuthorAdmin);
  });
});
