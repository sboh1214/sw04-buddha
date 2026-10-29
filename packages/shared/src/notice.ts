import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { cursorQuerySchema } from './api/pagination.js';
import { expectedAccountIdSchema, type WithoutExpectedAccount } from './expected-account.js';
import { codePointLength, postDocumentInputSchema, postDocumentSchema } from './post-document.js';
import { POST_TITLE_MAX_LENGTH } from './post.js';

/**
 * 운영 공지 (#138). Owner decisions (ADR-0069 decision 2 #45-8 and decision 4 #138): operators
 * write notices with a required title and a body in the posts' editor (POST_BODY_MAX_LENGTH
 * characters, links and images, '수정됨' once edited, earlier versions kept for operators only, as
 * a post's are), and pin them in the fixed area above the community list only — at most
 * NOTICE_PIN_LIMIT at a time, never unpinned automatically; an unpinned notice stays on the admin
 * screen and can be pinned again. Any admin writes, edits, pins and unpins, with no second admin's
 * approval, and each of the four records its admin and time (`admin_actions`, no reason). A notice
 * is shown as written by '운영팀', never by an operator's nickname, and takes no comments, likes
 * or reports. The theme pages' notices (#81) are another feature.
 *
 * The owner's answers of 2026-10-21 (ADR-0077): only a PINNED notice is public — one never pinned
 * or unpinned answers like a missing notice, its images too, and stays on the admin screens; the
 * fixed area is the latest pinned first; the earlier versions are kept with no retention period;
 * the admin's notice screen shows its operation records (who, when, which of the four) and its
 * earlier versions; and an edit names the version it was opened from, refused when the notice was
 * saved since (NOTICE_EDIT_CONFLICT). The second answers of that day: whoever saved it — another
 * admin, or the same one in another tab — the refusal is one neutral sentence, '그사이 공지가
 * 고쳐졌습니다. 최신 내용을 불러와 주세요.'.
 *
 * Nothing public names who wrote a notice: the public answers carry no person at all (the web
 * writes '운영팀'). Who did what is the audit log's (`admin_actions`), which only the admin
 * routes read — the records and the earlier versions name the operator (`AdminAccountActor`).
 */

/** At most this many notices are pinned at a time (#45-8: «최대 3개»). */
export const NOTICE_PIN_LIMIT = 3;

/**
 * A notice title's characters at most, in code points: the post title's 100 (owner decision
 * 2026-10-18 for posts), as the notice is written in the posts' form — the owner kept it
 * (2026-10-21, ADR-0077: «이대로»).
 */
export const NOTICE_TITLE_MAX_LENGTH = POST_TITLE_MAX_LENGTH;

/**
 * A notice title as a request sends it: required (#138 «제목 필수»), trimmed, one line — no control
 * characters — and at most NOTICE_TITLE_MAX_LENGTH characters. The post title's rules otherwise
 * (`postTitleInputSchema`): the wire bound only stops an absurd string before the count, and a lone
 * UTF-16 surrogate becomes U+FFFD as Postgres would store it, so resending a title is the same
 * title and an edit that changes nothing stays one.
 */
export const noticeTitleInputSchema = z
  .string()
  .trim()
  .overwrite((title) => title.replace(/\p{Cs}/gu, '�'))
  .min(1, { error: 'required' })
  .max(NOTICE_TITLE_MAX_LENGTH * 2)
  .refine((title) => !/\p{Cc}/u.test(title), {
    error: 'must be one line, without control characters',
  })
  .refine((title) => codePointLength(title) <= NOTICE_TITLE_MAX_LENGTH, {
    error: `at most ${String(NOTICE_TITLE_MAX_LENGTH)} characters`,
  })
  .describe(`Required, one line, at most ${String(NOTICE_TITLE_MAX_LENGTH)} characters`);

/**
 * One pinned notice as the community list's fixed area shows it (`GET /notices`): its title and
 * dates — the page opens the notice. No author: every notice is shown as 운영팀's (#45-8), which
 * the web writes, and no operator is named anywhere public.
 */
export const noticeSummarySchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    createdAt: z.iso.datetime(),
    /** The last edit ('수정됨'), or null while the notice was never edited. */
    editedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'NoticeSummary' });
export type NoticeSummary = z.infer<typeof noticeSummarySchema>;

/**
 * A notice page (`GET /notices/:noticeId`): the whole notice, its body a PostDocument as a post's
 * (images by media id, served by `GET /media/:mediaId`). Only a pinned notice is public (owner
 * decision 2026-10-21): any other answers like a missing one. Read-only: no comments, likes or
 * reports (#45-8). The earlier versions are the operators' and never ride here.
 */
export const noticeSchema = noticeSummarySchema
  .extend({ body: postDocumentSchema })
  .meta({ id: 'Notice' });
export type Notice = z.infer<typeof noticeSchema>;

/**
 * A notice on the admin screen's lists (`GET /admin/notices`): the public card and whether it is
 * pinned now — the time it was pinned, or null.
 */
export const adminNoticeSummarySchema = noticeSummarySchema
  .extend({ pinnedAt: z.iso.datetime().nullable() })
  .meta({ id: 'AdminNoticeSummary' });
export type AdminNoticeSummary = z.infer<typeof adminNoticeSummarySchema>;

/** A notice as the admin screen edits it, and as every admin write answers. */
export const adminNoticeSchema = noticeSchema
  .extend({ pinnedAt: z.iso.datetime().nullable() })
  .meta({ id: 'AdminNotice' });
export type AdminNotice = z.infer<typeof adminNoticeSchema>;

/**
 * The admin screen's two lists (`GET /admin/notices?state=`): `pinned` — the notices the community
 * list shows, in its order (the latest pinned first); `unpinned` — every other notice, the newest
 * written first, each of which may be pinned again (#45-8).
 */
export const NOTICE_LIST_STATES = ['pinned', 'unpinned'] as const;
export type NoticeListState = (typeof NOTICE_LIST_STATES)[number];

/** `GET /admin/notices` (no `.meta`: query DTO, expanded per field like `postListQuerySchema`). */
export const adminNoticeListQuerySchema = cursorQuerySchema.extend({
  state: z.enum(NOTICE_LIST_STATES),
});
export type AdminNoticeListQuery = z.infer<typeof adminNoticeListQuerySchema>;

/**
 * `POST /admin/notices`: a new notice, not pinned — pinning is its own action and record. The body
 * is a post's (`postDocumentInputSchema`: the allow-list, POST_BODY_MAX_LENGTH characters,
 * POST_IMAGES_MAX images); each new image an upload of the writing admin's that no post or other
 * notice has taken. And the admin on screen (`expectedAccountId`, ADR-0092 — the edit names it too,
 * and the pin and the unpin with `expectedAccountBodySchema`).
 */
export const createNoticeBodySchema = z
  .object({
    title: noticeTitleInputSchema,
    body: postDocumentInputSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'CreateNoticeBody' });
export type CreateNoticeBody = z.input<typeof createNoticeBodySchema>;

/**
 * `PUT /admin/notices/:noticeId`: the title and the body that replace the notice's, by any admin
 * (#45-8), and the version the edit screen was opened from — the notice's `editedAt` as the screen
 * read it, null for a notice never edited. A save of the notice since then — another admin's, or
 * the same admin's from another tab — refuses this one (NOTICE_EDIT_CONFLICT, owner decisions
 * 2026-10-21: «연 뒤 다른 운영자가 고쳤으면 저장을 막고», and the refusal the same whoever saved), and
 * nothing changes. Sending what the notice already says changes nothing, marks nothing edited and
 * records nothing. An image the notice already holds may stay whoever uploaded it.
 */
export const updateNoticeBodySchema = z
  .object({
    title: noticeTitleInputSchema,
    body: postDocumentInputSchema,
    /**
     * The `editedAt` of the version the edit was opened from (null: never edited). Required: a
     * save that does not say which version it read could replace one its writer never saw.
     */
    expectedEditedAt: z.iso.datetime().nullable(),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'UpdateNoticeBody' });
export type UpdateNoticeBody = z.input<typeof updateNoticeBodySchema>;

/**
 * `PUT /admin/notices/:noticeId`'s answer: the notice as it now is, and whether this request changed
 * it. `changed` is false when the notice already said what was sent — nothing was written, marked
 * edited or recorded. The screen says which from this, the server's own word, rather than from a
 * comparison of times.
 */
export const adminNoticeUpdateResultSchema = z
  .object({ notice: adminNoticeSchema, changed: z.boolean() })
  .meta({ id: 'AdminNoticeUpdateResult' });
export type AdminNoticeUpdateResult = z.infer<typeof adminNoticeUpdateResultSchema>;

/** A write's body as the API reads it: the title trimmed, the body normalised, the account. */
export type ParsedCreateNoticeBody = z.output<typeof createNoticeBodySchema>;

/** An edit's body as the API reads it: the content, the version it was opened from, the account. */
export type ParsedUpdateNoticeBody = z.output<typeof updateNoticeBodySchema>;

/** What a write hands the service: its content, the account checked and dropped. */
export type NoticeContent = WithoutExpectedAccount<ParsedCreateNoticeBody>;

/** What an edit hands the service: the content and the version it was opened from. */
export type NoticeEdit = WithoutExpectedAccount<ParsedUpdateNoticeBody>;

/**
 * NOTICE_PIN_LIMIT_REACHED: NOTICE_PIN_LIMIT notices are pinned already, so another cannot be
 * until one is unpinned (#45-8: no automatic unpinning).
 */
export const noticePinLimitDetailsSchema = z
  .object({ limit: z.number().int().min(1) })
  .meta({ id: 'NoticePinLimitDetails' });
export type NoticePinLimitDetails = z.infer<typeof noticePinLimitDetailsSchema>;

/**
 * NOTICE_EDIT_CONFLICT: the edit was opened from a version a save has replaced since, whoever made
 * it (owner decisions 2026-10-21) — nothing was written. `editedAt` is the notice's version now, which
 * the screen reads again before it offers the latest.
 */
export const noticeEditConflictDetailsSchema = z
  .object({ editedAt: z.iso.datetime().nullable() })
  .meta({ id: 'NoticeEditConflictDetails' });
export type NoticeEditConflictDetails = z.infer<typeof noticeEditConflictDetailsSchema>;

// ---- the admin's notice screen: the operation records and the earlier versions -----------------

/**
 * What an operation record of a notice says was done (#138: «작성·수정·고정·해제»): the four
 * `admin_actions` types of a notice, each written only when it changed something.
 */
export const NOTICE_ACTION_TYPES = [
  'notice_create',
  'notice_update',
  'notice_pin',
  'notice_unpin',
] as const;
export type NoticeActionType = (typeof NOTICE_ACTION_TYPES)[number];

/**
 * One operation record of a notice (`GET /admin/notices/:noticeId/actions`, owner decision
 * 2026-10-21: «운영 기록(운영자·시각·동작)»): who did which of the four, and when. No reason — the
 * owner takes none (#138). An edit names the version it replaced (`revisionId`, readable with
 * `GET /admin/notices/:noticeId/revisions/:revisionId`); the other three null.
 */
export const adminNoticeActionSchema = z
  .object({
    /** The admin_actions row. */
    id: z.uuid(),
    type: z.enum(NOTICE_ACTION_TYPES).meta({ id: 'NoticeActionType' }),
    /** The admin who did it: id and current nickname. */
    actor: adminAccountActorSchema,
    createdAt: z.iso.datetime(),
    /** `notice_update`: the earlier version this edit replaced. Null for the other three. */
    revisionId: z.number().int().positive().nullable(),
  })
  .meta({ id: 'AdminNoticeAction' });
export type AdminNoticeAction = z.infer<typeof adminNoticeActionSchema>;

/**
 * One earlier version of a notice on the admin's notice screen (`GET
 * /admin/notices/:noticeId/revisions`, owner decision 2026-10-21: «이전 판을 보임»): its title, when
 * and by whom it was written (the notice's writing or the edit before), and when and by whom an
 * edit replaced it. An operator is null only for a version no record names (a row written past
 * the API).
 */
export const adminNoticeRevisionSummarySchema = z
  .object({
    /** The notice_revisions row: the newer the version, the larger. */
    id: z.number().int().positive(),
    title: z.string(),
    writtenAt: z.iso.datetime(),
    writtenBy: adminAccountActorSchema.nullable(),
    replacedAt: z.iso.datetime(),
    replacedBy: adminAccountActorSchema.nullable(),
  })
  .meta({ id: 'AdminNoticeRevisionSummary' });
export type AdminNoticeRevisionSummary = z.infer<typeof adminNoticeRevisionSummarySchema>;

/**
 * One earlier version, whole (`GET /admin/notices/:noticeId/revisions/:revisionId`), read-only: its
 * body a PostDocument, its images served to admins by `GET /admin/notices/:noticeId/images/:mediaId`
 * (the public image route serves a pinned notice's current body only).
 */
export const adminNoticeRevisionSchema = adminNoticeRevisionSummarySchema
  .extend({ body: postDocumentSchema })
  .meta({ id: 'AdminNoticeRevision' });
export type AdminNoticeRevision = z.infer<typeof adminNoticeRevisionSchema>;

/**
 * A version's id in a path: a positive integer of at most 15 digits, so it is a safe integer
 * (`Number`) and within the bigserial — anything else is malformed (400), never a 500 from the
 * driver.
 */
export const noticeRevisionIdParamSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,14}$/)
  .describe('An earlier version’s id: a positive integer');
