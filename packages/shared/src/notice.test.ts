import { describe, expect, it } from 'vitest';
import { ADMIN_ACTION_TYPES } from './enums.js';
import { ERROR_CODES } from './api/errors.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import {
  NOTICE_ACTION_TYPES,
  NOTICE_LIST_STATES,
  NOTICE_PIN_LIMIT,
  NOTICE_TITLE_MAX_LENGTH,
  adminNoticeActionSchema,
  adminNoticeListQuerySchema,
  adminNoticeRevisionSchema,
  adminNoticeRevisionSummarySchema,
  adminNoticeSchema,
  adminNoticeSummarySchema,
  adminNoticeUpdateResultSchema,
  createNoticeBodySchema,
  noticeEditConflictDetailsSchema,
  noticePinLimitDetailsSchema,
  noticeRevisionIdParamSchema,
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
/** The admin on screen, which every admin write on a notice names (ADR-0092). */
const account = { expectedAccountId: 'admin-1' } as const;

describe('the owner’s notice rules (#45-8, #138)', () => {
  it('pins at most three, titles like a post’s, and writes the body in the posts’ editor', () => {
    expect(NOTICE_PIN_LIMIT).toBe(3);
    expect(NOTICE_TITLE_MAX_LENGTH).toBe(POST_TITLE_MAX_LENGTH);
    // The body is a post's: the same limits, read from the same constants.
    expect(POST_BODY_MAX_LENGTH).toBe(5_000);
    expect(POST_IMAGES_MAX).toBe(10);
  });

  it('records each of the four writes as its own admin action type', () => {
    expect(NOTICE_ACTION_TYPES).toEqual([
      'notice_create',
      'notice_update',
      'notice_pin',
      'notice_unpin',
    ]);
    for (const type of NOTICE_ACTION_TYPES) {
      expect(ADMIN_ACTION_TYPES).toContain(type);
      expect(type.length).toBeLessThanOrEqual(40);
    }
    expect(ERROR_CODES).toContain('NOTICE_PIN_LIMIT_REACHED');
    expect(ERROR_CODES).toContain('NOTICE_EDIT_CONFLICT');
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
  it('takes a required title, a normalised body and the admin on screen, nothing else', () => {
    const parsed = createNoticeBodySchema.parse({
      title: ' 점검 ',
      body: { ...BODY, extra: 1 },
      pinned: true,
      ...account,
    });
    expect(parsed).toEqual({
      title: '점검',
      body: { document: BODY, text: '점검 안내', length: 5, imageIds: [] },
      ...account,
    });
    expect(createNoticeBodySchema.safeParse({ body: BODY, ...account }).success).toBe(false);
    const empty = updateNoticeBodySchema.safeParse({
      title: '점검',
      body: { type: 'doc', content: [] },
      expectedEditedAt: null,
      ...account,
    });
    expect(empty.error?.issues.map((issue) => issue.path)).toEqual([['body']]);
    // ADR-0092: both name the admin on screen.
    expect(
      createNoticeBodySchema
        .safeParse({ title: '점검', body: BODY })
        .error?.issues.map((issue) => issue.path),
    ).toEqual([['expectedAccountId']]);
    expect(
      updateNoticeBodySchema
        .safeParse({ title: '점검', body: BODY, expectedEditedAt: null })
        .error?.issues.map((issue) => issue.path),
    ).toEqual([['expectedAccountId']]);
  });

  it('takes an edit with the version it was opened from, null for a notice never edited', () => {
    // Owner decision 2026-10-21: a save opened before another admin's is refused, so every edit
    // says which version it read.
    for (const expectedEditedAt of [null, AT]) {
      expect(
        updateNoticeBodySchema.parse({ title: '점검', body: BODY, expectedEditedAt, ...account })
          .expectedEditedAt,
      ).toBe(expectedEditedAt);
    }
    for (const expectedEditedAt of [undefined, '', 'yesterday', 0, '2026-10-20']) {
      const parsed = updateNoticeBodySchema.safeParse({
        title: '점검',
        body: BODY,
        expectedEditedAt,
        ...account,
      });
      expect(
        parsed.error?.issues.map((issue) => issue.path),
        String(expectedEditedAt),
      ).toEqual([['expectedEditedAt']]);
    }
    expect(noticeEditConflictDetailsSchema.parse({ editedAt: AT })).toEqual({ editedAt: AT });
    expect(noticeEditConflictDetailsSchema.parse({ editedAt: null })).toEqual({ editedAt: null });
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

describe('the admin’s notice screen (owner decision 2026-10-21)', () => {
  const actor = { id: 'admin-1', nickname: '운영자하나' };

  it('reads a record as who did which of the four, and when; an edit names its version', () => {
    const record = { id: ID, type: 'notice_update', actor, createdAt: AT, revisionId: 7 };
    expect(adminNoticeActionSchema.parse(record)).toEqual(record);
    const pin = { ...record, type: 'notice_pin', revisionId: null };
    expect(adminNoticeActionSchema.parse(pin)).toEqual(pin);
    expect(adminNoticeActionSchema.safeParse({ ...record, type: 'admin_grant' }).success).toBe(
      false,
    );
    // No reason: the owner takes none for a notice (#138).
    expect(Object.keys(adminNoticeActionSchema.shape)).not.toContain('reason');
  });

  it('reads an earlier version with who wrote and who replaced it, and whole with its body', () => {
    const version = {
      id: 3,
      title: '점검',
      writtenAt: AT,
      writtenBy: actor,
      replacedAt: AT,
      replacedBy: null,
    };
    expect(adminNoticeRevisionSummarySchema.parse(version)).toEqual(version);
    expect(adminNoticeRevisionSchema.parse({ ...version, body: BODY })).toEqual({
      ...version,
      body: BODY,
    });
  });

  it('takes a version id in a path as a positive safe integer only', () => {
    for (const id of ['1', '42', '9'.repeat(15)]) {
      expect(noticeRevisionIdParamSchema.parse(id)).toBe(id);
      expect(Number.isSafeInteger(Number(id))).toBe(true);
    }
    for (const id of ['', '0', '01', '-1', '1.5', 'x', '9'.repeat(16)]) {
      expect(noticeRevisionIdParamSchema.safeParse(id).success, id).toBe(false);
    }
  });
});
