import { describe, expect, it } from 'vitest';
import { ADMIN_ACTION_TYPES } from './enums.js';
import { ERROR_CODES } from './api/errors.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import {
  NOTICE_LIST_STATES,
  NOTICE_PIN_LIMIT,
  NOTICE_TITLE_MAX_LENGTH,
  adminNoticeListQuerySchema,
  adminNoticeSchema,
  adminNoticeSummarySchema,
  adminNoticeUpdateResultSchema,
  createNoticeBodySchema,
  noticePinLimitDetailsSchema,
  noticeSchema,
  noticeSummarySchema,
  noticeTitleInputSchema,
  updateNoticeBodySchema,
} from './notice.js';
import { POST_BODY_MAX_LENGTH, POST_IMAGES_MAX } from './post-document.js';
import { POST_TITLE_MAX_LENGTH } from './post.js';

const ID = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';
const BODY = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: '점검 안내' }] }],
};
const AT = '2026-10-20T00:00:00.000Z';

describe('the owner’s notice rules (#45-8, #138)', () => {
  it('pins at most three, titles like a post’s, and writes the body in the posts’ editor', () => {
    expect(NOTICE_PIN_LIMIT).toBe(3);
    expect(NOTICE_TITLE_MAX_LENGTH).toBe(POST_TITLE_MAX_LENGTH);
    // The body is a post's: the same limits, read from the same constants.
    expect(POST_BODY_MAX_LENGTH).toBe(5_000);
    expect(POST_IMAGES_MAX).toBe(10);
  });

  it('records each of the four writes as its own admin action type', () => {
    for (const type of ['notice_create', 'notice_update', 'notice_pin', 'notice_unpin']) {
      expect(ADMIN_ACTION_TYPES).toContain(type);
      expect(type.length).toBeLessThanOrEqual(40);
    }
    expect(ERROR_CODES).toContain('NOTICE_PIN_LIMIT_REACHED');
  });
});

describe('a notice’s title', () => {
  it('is required: absent, null and blank are refused', () => {
    for (const title of [undefined, null, '', '   ']) {
      expect(noticeTitleInputSchema.safeParse(title).success, JSON.stringify(title)).toBe(false);
    }
  });

  it('is trimmed, one line and at most 100 characters, counted in code points', () => {
    expect(noticeTitleInputSchema.parse('  서비스 점검  ')).toBe('서비스 점검');
    expect(noticeTitleInputSchema.parse('😀'.repeat(NOTICE_TITLE_MAX_LENGTH))).toBe(
      '😀'.repeat(NOTICE_TITLE_MAX_LENGTH),
    );
    for (const title of [
      '가'.repeat(NOTICE_TITLE_MAX_LENGTH + 1),
      '😀'.repeat(NOTICE_TITLE_MAX_LENGTH + 1),
      'a\nb',
      'a\tb',
      'a\u0007b',
    ]) {
      expect(noticeTitleInputSchema.safeParse(title).success, JSON.stringify(title)).toBe(false);
    }
  });

  it('turns a lone surrogate into U+FFFD, so the same title sent again is the same title', () => {
    const title = JSON.parse('"a\\ud800b😀"') as string;
    expect(noticeTitleInputSchema.parse(title)).toBe('a�b😀');
    expect(noticeTitleInputSchema.parse(noticeTitleInputSchema.parse(title))).toBe(
      noticeTitleInputSchema.parse(title),
    );
  });
});

describe('the bodies of the admin writes', () => {
  it('takes a required title and a normalised body, nothing else', () => {
    const parsed = createNoticeBodySchema.parse({
      title: ' 점검 ',
      body: { ...BODY, extra: 1 },
      pinned: true,
    });
    expect(parsed).toEqual({
      title: '점검',
      body: { document: BODY, text: '점검 안내', length: 5, imageIds: [] },
    });
    expect(createNoticeBodySchema.safeParse({ body: BODY }).success).toBe(false);
    const empty = updateNoticeBodySchema.safeParse({
      title: '점검',
      body: { type: 'doc', content: [] },
    });
    expect(empty.error?.issues.map((issue) => issue.path)).toEqual([['body']]);
  });

  it('lists the pinned or the unpinned notices, one state at a time', () => {
    expect(NOTICE_LIST_STATES).toEqual(['pinned', 'unpinned']);
    expect(adminNoticeListQuerySchema.parse({ state: 'pinned' })).toEqual({
      state: 'pinned',
      limit: 20,
    });
    expect(adminNoticeListQuerySchema.safeParse({}).success).toBe(false);
    expect(adminNoticeListQuerySchema.safeParse({ state: 'all' }).success).toBe(false);
  });
});

describe('the shapes', () => {
  it('draws the fixed area’s card and the notice page with no person in them', () => {
    const summary = { id: ID, title: '점검', createdAt: AT, editedAt: null };
    expect(noticeSummarySchema.parse(summary)).toEqual(summary);
    expect(noticeSchema.parse({ ...summary, body: BODY })).toEqual({ ...summary, body: BODY });
    // Nothing public names who wrote it, nor anything private (#113).
    const names = [...Object.keys(noticeSchema.shape), ...Object.keys(noticeSummarySchema.shape)];
    for (const name of names) {
      expect(findPrivateField(name), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
    }
    expect(names).not.toContain('author');
  });

  it('tells the admin when a notice was pinned, or that it is not', () => {
    const summary = { id: ID, title: '점검', createdAt: AT, editedAt: AT, pinnedAt: AT };
    expect(adminNoticeSummarySchema.parse(summary)).toEqual(summary);
    expect(adminNoticeSchema.parse({ ...summary, pinnedAt: null, body: BODY }).pinnedAt).toBeNull();
    expect(noticePinLimitDetailsSchema.parse({ limit: NOTICE_PIN_LIMIT })).toEqual({ limit: 3 });
  });

  it('answers an edit with the notice and whether that edit changed it', () => {
    const notice = {
      id: ID,
      title: '점검',
      createdAt: AT,
      editedAt: AT,
      pinnedAt: null,
      body: BODY,
    };
    for (const changed of [true, false]) {
      expect(adminNoticeUpdateResultSchema.parse({ notice, changed })).toEqual({ notice, changed });
    }
    // Both are required: the screen picks its message from `changed`, never from `editedAt`.
    expect(adminNoticeUpdateResultSchema.safeParse({ notice }).success).toBe(false);
    expect(adminNoticeUpdateResultSchema.safeParse(notice).success).toBe(false);
  });
});
