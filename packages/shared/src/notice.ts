import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
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
 * Nothing here names who wrote a notice: the public answers carry no person at all (the web
 * writes '운영팀'), and the admin answers carry the notice itself (who did what is the audit
 * log's, `admin_actions`).
 */

/** At most this many notices are pinned at a time (#45-8: «최대 3개»). */
export const NOTICE_PIN_LIMIT = 3;

/**
 * A notice title's characters at most, in code points. The owner settled «제목 필수» and not its
 * length: this takes the post title's 100 (owner decision 2026-10-18 for posts), as the notice is
 * written in the posts' form — this PR's choice, an open question to the owner.
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
 * (images by media id, served by `GET /media/:mediaId`). Read-only: no comments, likes or reports
 * (#45-8). The earlier versions are the operators' and never ride here.
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
 * notice has taken.
 */
export const createNoticeBodySchema = z
  .object({ title: noticeTitleInputSchema, body: postDocumentInputSchema })
  .meta({ id: 'CreateNoticeBody' });
export type CreateNoticeBody = z.input<typeof createNoticeBodySchema>;

/**
 * `PUT /admin/notices/:noticeId`: the title and the body that replace the notice's, by any admin
 * (#45-8). Sending what the notice already says changes nothing, marks nothing edited and records
 * nothing. An image the notice already holds may stay whoever uploaded it.
 */
export const updateNoticeBodySchema = z
  .object({ title: noticeTitleInputSchema, body: postDocumentInputSchema })
  .meta({ id: 'UpdateNoticeBody' });
export type UpdateNoticeBody = z.input<typeof updateNoticeBodySchema>;

/**
 * `PUT /admin/notices/:noticeId`'s answer: the notice as it now is, and whether this request changed
 * it. `changed` is false when the notice already said what was sent — nothing was written, marked
 * edited or recorded. The screen says which from this, not from `editedAt`: another admin's edit
 * the screen has not read yet moves `editedAt` too.
 */
export const adminNoticeUpdateResultSchema = z
  .object({ notice: adminNoticeSchema, changed: z.boolean() })
  .meta({ id: 'AdminNoticeUpdateResult' });
export type AdminNoticeUpdateResult = z.infer<typeof adminNoticeUpdateResultSchema>;

/** A write's body as the API reads it: the title trimmed, the body normalised. */
export type NoticeContent = z.output<typeof createNoticeBodySchema>;

/**
 * NOTICE_PIN_LIMIT_REACHED: NOTICE_PIN_LIMIT notices are pinned already, so another cannot be
 * until one is unpinned (#45-8: no automatic unpinning).
 */
export const noticePinLimitDetailsSchema = z
  .object({ limit: z.number().int().min(1) })
  .meta({ id: 'NoticePinLimitDetails' });
export type NoticePinLimitDetails = z.infer<typeof noticePinLimitDetailsSchema>;
