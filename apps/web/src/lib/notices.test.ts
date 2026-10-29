import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  NOTICE_ACTION_TYPES,
  NOTICE_PIN_LIMIT,
  NOTICE_TITLE_MAX_LENGTH,
  POST_BODY_MAX_LENGTH,
  POST_TITLE_MAX_LENGTH,
  mediaPath,
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
  adminNoticeActionsKey,
  adminNoticeImagePath,
  adminNoticeKey,
  adminNoticeListKey,
  adminNoticeListQuery,
  adminNoticeMissing,
  adminNoticePageQuery,
  adminNoticePath,
  adminNoticeReadView,
  adminNoticeRevisionKey,
  adminNoticeRevisionPath,
  adminNoticeRevisionsKey,
  noticeActionLabel,
  noticeActorName,
  noticeDescription,
  noticeEditConflict,
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
    expect(adminNoticeRevisionPath(notice, 7)).toBe(`/admin/notices/${notice}/revisions/7`);
    // Each address has its page.
    expect(existsSync(pageOf('community', 'notices', '[noticeId]'))).toBe(true);
    expect(existsSync(pageOf('admin', 'notices'))).toBe(true);
    expect(existsSync(pageOf('admin', 'notices', 'new'))).toBe(true);
    expect(existsSync(pageOf('admin', 'notices', '[noticeId]'))).toBe(true);
    expect(existsSync(pageOf('admin', 'notices', '[noticeId]', 'revisions', '[revisionId]'))).toBe(
      true,
    );
  });

  it('draws a notice’s images on the admin screens through the admin route, not the public one', () => {
    // Owner decision 2026-10-21: the public image route serves a pinned notice's current images
    // only; the admin's edit screen of a notice not pinned, and an earlier version, read them here.
    const media = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';
    expect(adminNoticeImagePath(notice, media)).toBe(
      `/api/v1/admin/notices/${notice}/images/${media}`,
    );
    expect(adminNoticeImagePath(notice, media)).not.toBe(mediaPath(media));
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

  it('keeps a notice’s records and earlier versions under the notice’s own key', () => {
    expect(adminNoticeActionsKey(NOTICE)).toEqual([
      'admin',
      'notices',
      'notice',
      notice,
      'actions',
    ]);
    expect(adminNoticeRevisionsKey(NOTICE)).toEqual([
      'admin',
      'notices',
      'notice',
      notice,
      'revisions',
    ]);
    // A version by its id as the address names it, a number or its digits alike.
    expect(adminNoticeRevisionKey(NOTICE, 7)).toEqual([...adminNoticeRevisionsKey(notice), '7']);
    expect(adminNoticeRevisionKey(NOTICE, '7')).toEqual(adminNoticeRevisionKey(notice, 7));
    expect(adminNoticePageQuery()).toEqual({});
    expect(adminNoticePageQuery('c2')).toEqual({ cursor: 'c2' });
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

  it('says what the save did as the API answers it', () => {
    // `changed` is the server's own word, whatever the answer's `editedAt` says.
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

describe('the records and earlier versions (owner decision 2026-10-21)', () => {
  it('names each of the four records as the owner did: 작성·수정·고정·해제', () => {
    expect(NOTICE_ACTION_TYPES.map(noticeActionLabel)).toEqual([
      '작성',
      '수정',
      '고정',
      '고정 해제',
    ]);
  });

  it('names the operator by nickname, and says so where no record names one', () => {
    expect(noticeActorName({ nickname: '운영자하나' })).toBe('운영자하나');
    expect(noticeActorName(null)).toBe(copy.adminNoticeActorUnknown);
    expect(noticeActorName({ nickname: '' })).toBe(copy.adminNoticeActorUnknown);
    // An operator who closed the account since (#140, once the role was revoked).
    expect(noticeActorName({ nickname: null })).toBe(copy.postAuthorFormer);
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

  /** A read with something drawn, settled: what the screens' query reports once a read landed. */
  const read = {
    isPending: false,
    isError: false,
    isLoadingError: false,
    error: null as unknown,
    fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
    dataUpdatedAt: 2_000,
  };

  it('draws a skeleton before the first read, its not-found or failure after a refused one', () => {
    const first = { ...read, isPending: true, dataUpdatedAt: 0 };
    expect(adminNoticeReadView({ ...first, fetchStatus: 'fetching' })).toBe('pending');
    expect(adminNoticeReadView({ ...first, fetchStatus: 'paused' }, 0)).toBe('pending');
    const refused = { ...read, isError: true, isLoadingError: true, dataUpdatedAt: 0 };
    expect(adminNoticeReadView({ ...refused, error: refusal(404, 'NOT_FOUND') })).toBe('missing');
    expect(adminNoticeReadView({ ...refused, error: refusal(400, 'VALIDATION_ERROR') }, 0)).toBe(
      'missing',
    );
    expect(adminNoticeReadView({ ...refused, error: refusal(500, 'INTERNAL') })).toBe('failed');
    expect(adminNoticeReadView({ ...refused, error: new TypeError('Failed to fetch') })).toBe(
      'failed',
    );
  });

  it('keeps what was read on screen when a later refresh fails', () => {
    expect(adminNoticeReadView(read)).toBe('ready');
    const refreshFailed = { ...read, isError: true, error: refusal(500, 'INTERNAL') };
    expect(adminNoticeReadView(refreshFailed)).toBe('ready');
    expect(adminNoticeReadView(refreshFailed, 1_000)).toBe('ready');
  });

  it('opens the edit form only on a read made after the screen opened (ADR-0077 decision 8-19)', () => {
    // The screen opened at 1,500 on a copy the cache held from 1,000: not what the form opens on.
    const held = { ...read, dataUpdatedAt: 1_000 };
    expect(adminNoticeReadView({ ...held, fetchStatus: 'fetching' }, 1_500)).toBe('pending');
    expect(adminNoticeReadView({ ...held, fetchStatus: 'paused' }, 1_500)).toBe('pending');
    // The read on opening was refused: the screen fails as a first read does — no form on the
    // copy, and the not-found if it found nothing.
    const refused = { ...held, isError: true, error: refusal(500, 'INTERNAL') };
    expect(adminNoticeReadView(refused, 1_500)).toBe('failed');
    expect(adminNoticeReadView({ ...refused, error: refusal(404, 'NOT_FOUND') }, 1_500)).toBe(
      'missing',
    );
    // Asked again (a refocus), it waits for that read.
    expect(adminNoticeReadView({ ...refused, fetchStatus: 'fetching' }, 1_500)).toBe('pending');
    // Read since — in the very millisecond it opened, too: the form opens on it.
    expect(adminNoticeReadView(read, 1_500)).toBe('ready');
    expect(adminNoticeReadView({ ...read, dataUpdatedAt: 1_500 }, 1_500)).toBe('ready');
    // The version screen passes no `openedAt`: a version never changes, any copy will do.
    expect(adminNoticeReadView(held)).toBe('ready');
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

  it('says the notice was saved meanwhile in one neutral sentence, and knows it from any other refusal', () => {
    // Owner decisions 2026-10-21 (second answers): whoever saved first — another admin, or the same
    // one in another tab — «그사이 공지가 고쳐졌습니다. 최신 내용을 불러와 주세요.», never who.
    const conflict = refusal(409, 'NOTICE_EDIT_CONFLICT', { editedAt: null });
    const neutral = '그사이 공지가 고쳐졌습니다. 최신 내용을 불러와 주세요.';
    expect(noticeWriteErrorMessage(conflict)).toBe(neutral);
    expect(copy.errNoticeEditConflict).toBe(neutral);
    expect(copy.errNoticeEditConflict).not.toContain('운영자');
    // The hint and the button beside it stay as built (the second answers: «이대로»).
    expect(copy.adminNoticeEditConflictHint).toBe('최신 내용을 불러오면 쓰던 내용은 사라집니다.');
    expect(copy.adminNoticeReloadLatest).toBe('최신 내용 불러오기');
    expect(noticeEditConflict(conflict)).toBe(true);
    for (const other of [
      refusal(409, 'NOTICE_PIN_LIMIT_REACHED', { limit: NOTICE_PIN_LIMIT }),
      refusal(404, 'NOT_FOUND'),
      new TypeError('Failed to fetch'),
    ]) {
      expect(noticeEditConflict(other)).toBe(false);
    }
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

  it('tells the admin that only a pinned notice is public, and no longer that an unpinned one is', () => {
    // Owner decision 2026-10-21: «고정하지 않았거나 푼 공지 → 공개 안 함». The intro is on the list
    // and on the write screen, so it names the list rather than 'here'.
    expect(copy.adminNoticesIntro).toContain('고정한 공지만 누구나 읽을 수 있');
    expect(copy.adminNoticesIntro).toContain('고정하지 않은 공지는 공지 목록에만');
    expect(copy.adminNoticesIntro).not.toContain('고정하지 않은 공지도');
    expect(copy.adminNoticesIntro).not.toContain('주소로 누구나');
    expect(copy.adminNoticesIntro).toContain('공지 목록에 남아');
    expect(copy.adminNoticesIntro).not.toContain('여기');
  });

  it('writes notices as 운영팀, and marks them 공지 — no operator, no admin mark', () => {
    expect(copy.noticeAuthor).toBe('운영팀');
    expect(copy.noticeBadge).toBe('공지');
    expect(copy.noticeAuthor).not.toBe(copy.postAuthorAdmin);
  });
});
