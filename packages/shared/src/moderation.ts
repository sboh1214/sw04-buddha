import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
import { uuidSchema } from './api/uuid.js';
import { adminAccountActorSchema } from './admin-accounts.js';
import { commentedPostSchema, hiddenReasonSchema } from './authored.js';
import { normaliseCommentBody } from './comment.js';
import {
  moderationActionTypeSchema,
  reportReasonSchema,
  reportStatusSchema,
  roleSchema,
  type ReportReason,
} from './enums.js';
import { postAuthorSchema } from './post.js';
import { codePointLength, postDocumentSchema } from './post-document.js';
import { publicIdSchema } from './public-id.js';

/**
 * 신고와 운영 처리 (#50, ADR-0081). Owner decisions (ADR-0069 decision 2 #45-10…#45-15, decision 3
 * #37-10, decision 4 #50 rows, decision 7):
 *
 * - What is reported: a 근거 글, a 댓글 or 대댓글, and a member's public profile (#37-10). Never a
 *   notice (#45-8). One reason of REPORT_REASONS per report; '기타' needs a description. The screen
 *   says that disagreeing or a wrong forecast is not a reason (#45-10).
 * - Who reports: an account that finished the onboarding (#57-8). Never its own post, comment or
 *   profile. The same person — the keyed hash of the verified number, so a new account on the same
 *   number is the same person (decision 7) — reports a target again only once their report on it is
 *   not pending any more. At most REPORTS_PER_DAY a day per person; an operator account has no
 *   limit (#45-15). Who reported is never shown to the member reported (#45-10, #45-13).
 * - No count of reports hides anything or sanctions anybody (#45-10 «자동 숨김 없다», N05 §5): an
 *   operator decides each case on the admin screen, choosing by the violation's weight (#45-11)
 *   among hiding the item, dismissing the reports (기각), a warning (a record and the member's notice
 *   only), and for a profile the nickname back to an auto nickname, the 소개 emptied or the image
 *   removed (#37-10). An operator also acts without a report, and cancels an action with a reason
 *   (decision 4 #50). Reports on an operator's own post, comment or profile are another operator's
 *   to process. Every action, cancellation and dismissal records the reason, the operator and the
 *   time; every report its intake and processing times (N05 §8, for #95's metrics).
 * - Effects are immediate (#45-13). The member acted on sees the action, its reason, its end when
 *   it has one and how to appeal (by email, once per action within APPEAL_WINDOW_DAYS, #45-14 —
 *   #186 words it); never who reported nor which operator acted. The reporter sees the receipt and
 *   the result: 조치함 or 기각 (#45-13). Notifications are M13's.
 * - Every admin reads the reports and the actions (ADR-0056 decision 1-2) — but an admin reading a
 *   record about themselves, a report on their item or profile or an action on them, reads no
 *   reporter, no report description and no operator's name in it (owner decision 2026-10-21,
 *   `aboutViewer`); nothing of them is ever public (PRIVATE_DATA `reports`, `moderation`,
 *   `risk-flag`), and nothing turns them into a score, a standing or an order (N04 §4).
 */

/** Reports a person files in REPORT_WINDOW_HOURS at most (#45-15 «신고 하루 20건», fixed). */
export const REPORTS_PER_DAY = 20;

/**
 * The window REPORTS_PER_DAY counts in: the last 24 hours, as #187's daily write limits count (owner
 * decision 2026-10-22 on #187: «하루 → 지난 24시간»).
 */
export const REPORT_WINDOW_HOURS = 24;

/**
 * A report's description at most, in code points (`codePointLength`). The owner set no length;
 * 500 is the operator reasons' (ADMIN_ROLE_REASON_MAX_LENGTH) and half a comment (ADR-0081).
 */
export const REPORT_DESCRIPTION_MAX_LENGTH = 500;

/** An operator's explanation shown to the member with an action (`note`), at most. */
export const MODERATION_NOTE_MAX_LENGTH = 500;

/** An operator's reason for a cancellation or a dismissal (operators only), at most. */
export const MODERATION_REASON_MAX_LENGTH = 500;

/**
 * The days within which an action may be appealed, by email and once (#45-14 «조치마다 한 번, 조치 뒤
 * 14일 안»). The screens count them from the action's time (`appealDeadlineOf`); #186 words the
 * notice.
 */
export const APPEAL_WINDOW_DAYS = 14;

/** The last instant an action taken at `createdAt` may be appealed (APPEAL_WINDOW_DAYS later). */
export function appealDeadlineOf(createdAt: string | Date): Date {
  const start = typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
  return new Date(start.getTime() + APPEAL_WINDOW_DAYS * 24 * 60 * 60 * 1_000);
}

// ---- plain text inputs ---------------------------------------------------------------------------

/** The refusal of a text over its limit (`textTooLongMessage`), told apart by the web like a body's. */
const TEXT_TOO_LONG_HEAD = 'at most ';

/** A text of more than `max` characters: `at most <max> characters, not <length>`. */
export function textTooLongMessage(max: number, length: number): string {
  return `${TEXT_TOO_LONG_HEAD}${String(max)} characters, not ${String(length)}`;
}

/**
 * Optional plain text as it is kept — normalised the way a comment is (`normaliseCommentBody`: line
 * breaks kept, controls dropped, trimmed) — at most `max` code points; blank, null or absent is
 * none (null).
 */
function optionalTextSchema(max: number) {
  return z
    .string()
    .overwrite(normaliseCommentBody)
    .superRefine((text, ctx) => {
      const length = codePointLength(text);
      if (length > max) ctx.addIssue({ code: 'custom', message: textTooLongMessage(max, length) });
    })
    .nullable()
    .optional()
    .transform((text) => (text ? text : null));
}

/** Required plain text of at most `max` code points, normalised the same way. */
function requiredTextSchema(max: number) {
  return z
    .string()
    .overwrite(normaliseCommentBody)
    .superRefine((text, ctx) => {
      if (text === '') {
        ctx.addIssue({ code: 'custom', message: 'must have some text' });
        return;
      }
      const length = codePointLength(text);
      if (length > max) ctx.addIssue({ code: 'custom', message: textTooLongMessage(max, length) });
    });
}

/** The message of a '기타' (or an operator's 기타) sent without the text it needs. */
export const OTHER_NEEDS_TEXT_MESSAGE = 'required with the reason other';

/** Whether `reason` needs a text beside it: '기타' does (#45-10 «'기타'는 설명이 필수다»). */
export function reasonNeedsText(reason: ReportReason): boolean {
  return reason === 'other';
}

/** The account the screen shows (better-auth `user.id`, text), on every write below. */
const expectedAccountIdSchema = z.string().min(1).max(255);

// ---- a member reports ----------------------------------------------------------------------------

/**
 * `POST /posts/:postId/reports`, `POST /comments/:commentId/reports` and
 * `POST /profiles/:publicId/reports`: one reason (#50 «하나»), the description — optional, required
 * with `other` (#45-10) — and the account the screen shows (A-PG-24).
 */
export const createReportBodySchema = z
  .object({
    reason: reportReasonSchema,
    description: optionalTextSchema(REPORT_DESCRIPTION_MAX_LENGTH).describe(
      `Plain text, at most ${String(REPORT_DESCRIPTION_MAX_LENGTH)} characters after trimming; ` +
        'required with the reason other, optional otherwise',
    ),
    /** The signed-in user id the screen is showing (better-auth `user.id`, text). */
    expectedAccountId: expectedAccountIdSchema,
  })
  .superRefine((body, ctx) => {
    if (reasonNeedsText(body.reason) && body.description === null) {
      ctx.addIssue({ code: 'custom', path: ['description'], message: OTHER_NEEDS_TEXT_MESSAGE });
    }
  })
  .meta({ id: 'CreateReportBody' });
export type CreateReportBody = z.input<typeof createReportBodySchema>;
export type ParsedReportBody = z.output<typeof createReportBodySchema>;

/**
 * Why a report is refused (REPORT_NOT_ALLOWED): `own` — the reporter's own post, comment or profile
 * (#45-10); `duplicate` — the same person's report on it is still pending (decision 7); `deleted`
 * and `hidden` — the post or comment shows only its placeholder, its author's deletion or an
 * operator's hiding. A target gone from every view, or never there, is NOT_FOUND.
 */
export const REPORT_REFUSALS = ['own', 'duplicate', 'deleted', 'hidden'] as const;
export type ReportRefusal = (typeof REPORT_REFUSALS)[number];
export const reportNotAllowedDetailsSchema = z
  .object({ reason: z.enum(REPORT_REFUSALS).meta({ id: 'ReportRefusal' }) })
  .meta({ id: 'ReportNotAllowedDetails' });
export type ReportNotAllowedDetails = z.infer<typeof reportNotAllowedDetailsSchema>;

/**
 * REPORT_LIMITED: the person's limit (REPORTS_PER_DAY) and the seconds until the oldest of the
 * reports it counts leaves the window, rounded up to the minute (#187's way: never another
 * account's report time to the second).
 */
export const reportLimitedDetailsSchema = z
  .object({ limit: z.number().int().positive(), retryAfterSeconds: z.number().int().positive() })
  .meta({ id: 'ReportLimitedDetails' });
export type ReportLimitedDetails = z.infer<typeof reportLimitedDetailsSchema>;

// ---- what the reporter sees (MY) -----------------------------------------------------------------

/**
 * A reported comment as the public sees it now: published — the start of its text — or its
 * placeholder, by its id alone.
 */
export const reportedCommentSchema = z
  .discriminatedUnion('state', [
    z
      .object({ state: z.literal('published'), id: z.uuid(), excerpt: z.string() })
      .meta({ id: 'ReportedPublishedComment' }),
    z.object({ state: z.literal('deleted'), id: z.uuid() }).meta({ id: 'ReportedDeletedComment' }),
    z.object({ state: z.literal('hidden'), id: z.uuid() }).meta({ id: 'ReportedHiddenComment' }),
  ])
  .meta({ id: 'ReportedComment' });
export type ReportedComment = z.infer<typeof reportedCommentSchema>;

/**
 * What a report was about, as the public sees it now — never more than the reporter could read
 * before: a post by its title and the start of its text (`CommentedPost`), a comment by the start of
 * its text and the post it is under, a profile by its member's public face. A placeholder names the
 * item by its id alone, so nothing of a hidden or deleted item comes back through a report.
 */
export const reportTargetSchema = z
  .discriminatedUnion('type', [
    z
      .object({ type: z.literal('post'), post: commentedPostSchema })
      .meta({ id: 'ReportedPostTarget' }),
    z
      .object({ type: z.literal('comment'), postId: z.uuid(), comment: reportedCommentSchema })
      .meta({ id: 'ReportedCommentTarget' }),
    z
      .object({ type: z.literal('profile'), member: postAuthorSchema })
      .meta({ id: 'ReportedProfileTarget' }),
  ])
  .meta({ id: 'ReportTarget' });
export type ReportTarget = z.infer<typeof reportTargetSchema>;

/**
 * One report of the member's own (`GET /me/reports`, and the answer of a report): what it was
 * about, the reason and description sent, when, and the result — `pending` (접수), `actioned`
 * (조치함) or `dismissed` (기각) with when (#45-13). Not which action was taken, nor by whom: the
 * action is the member acted on's to read.
 */
export const myReportSchema = z
  .object({
    id: z.uuid(),
    target: reportTargetSchema,
    reason: reportReasonSchema,
    description: z.string().nullable(),
    createdAt: z.iso.datetime(),
    status: reportStatusSchema,
    /** When an operator processed it; null while it is pending. */
    resolvedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MyReport' });
export type MyReport = z.infer<typeof myReportSchema>;

// ---- what the member acted on sees (MY) ----------------------------------------------------------

/**
 * What an action was about, as the member acted on sees it: their own post or comment — the title
 * and the start of the text, or null when they deleted it since (MY shows no deleted item, #45-5) —
 * or their profile. Null for a warning given about nothing in particular.
 */
export const myActionSubjectSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('post'),
        id: z.uuid(),
        title: z.string().nullable(),
        excerpt: z.string().nullable(),
      })
      .meta({ id: 'MyActionPostSubject' }),
    z
      .object({
        type: z.literal('comment'),
        id: z.uuid(),
        postId: z.uuid(),
        excerpt: z.string().nullable(),
      })
      .meta({ id: 'MyActionCommentSubject' }),
    z.object({ type: z.literal('profile') }).meta({ id: 'MyActionProfileSubject' }),
  ])
  .meta({ id: 'MyActionSubject' });
export type MyActionSubject = z.infer<typeof myActionSubjectSchema>;

/**
 * One action an operator took on the member (`GET /me/moderation/actions`, #45-13: «조치 종류·사유·
 * 기간·이의 방법»): its type, the reason — the report reason the operator picked and the explanation
 * they wrote (`HiddenReason`'s shape, ADR-0080) — when, its end (`endsAt`: a restriction's, #185 and
 * #139; null for every type #50 takes) and whether it was cancelled since. The appeal deadline is
 * `appealDeadlineOf(createdAt)`. Never the operator, nor a report or its reporter.
 */
export const myModerationActionSchema = z
  .object({
    id: z.uuid(),
    type: moderationActionTypeSchema,
    reason: hiddenReasonSchema,
    subject: myActionSubjectSchema.nullable(),
    createdAt: z.iso.datetime(),
    endsAt: z.iso.datetime().nullable(),
    /** When an operator cancelled it; null while it stands. */
    cancelledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MyModerationAction' });
export type MyModerationAction = z.infer<typeof myModerationActionSchema>;

// ---- operators -----------------------------------------------------------------------------------

/** An account as the moderation screens name it: the account id, the public face and the role. */
export const moderationUserSchema = z
  .object({
    id: z.string(),
    publicId: publicIdSchema,
    nickname: z.string(),
    role: roleSchema,
  })
  .meta({ id: 'ModerationUser' });
export type ModerationUser = z.infer<typeof moderationUserSchema>;

/** What a report or an action is about, for operators: the item's ids and the account. */
export const moderationTargetSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('post'), postId: z.uuid() }).meta({ id: 'ModerationPostTarget' }),
    z
      .object({ type: z.literal('comment'), commentId: z.uuid(), postId: z.uuid() })
      .meta({ id: 'ModerationCommentTarget' }),
    z
      .object({ type: z.literal('profile'), userId: z.string() })
      .meta({ id: 'ModerationProfileTarget' }),
  ])
  .meta({ id: 'ModerationTarget' });
export type ModerationTarget = z.infer<typeof moderationTargetSchema>;

/** The states an item is in for operators: the public's three and `gone` (deleted, nothing under). */
export const MODERATION_ITEM_STATES = ['published', 'hidden', 'deleted', 'gone'] as const;
export const moderationItemStateSchema = z
  .enum(MODERATION_ITEM_STATES)
  .meta({ id: 'ModerationItemState' });
export type ModerationItemState = z.infer<typeof moderationItemStateSchema>;

/**
 * Whether a record is about the admin reading it — a report on their post, comment or profile, an
 * action on them. Then who reported, what the reporter wrote and which operators processed, acted
 * and cancelled are withheld from them, on the admin screens too (null); they read the reasons, the
 * times and what was done (owner decision 2026-10-21, ADR-0081: #45-10 and #45-13 «신고자와 처리한
 * 운영자는 대상자에게 보이지 않는다» over ADR-0056 1-2 for a record about oneself).
 */
const aboutViewerSchema = z
  .boolean()
  .describe(
    'True when the record is about the admin reading it: the reporter, the description and the ' +
      'operators are withheld (null)',
  );

/**
 * One report, for operators (ADR-0056 1-2: every admin reads them), the reporter included — but
 * for the admin it is about (`aboutViewer`).
 */
export const adminReportSchema = z
  .object({
    id: z.uuid(),
    target: moderationTargetSchema,
    /** Null for the admin the report is about (`aboutViewer`). */
    reporter: moderationUserSchema.nullable(),
    reason: reportReasonSchema,
    /** The reporter's text; null when none was sent, and for the admin it is about. */
    description: z.string().nullable(),
    createdAt: z.iso.datetime(),
    status: reportStatusSchema,
    resolvedAt: z.iso.datetime().nullable(),
    /** Who processed it; null while it is pending, and for the admin it is about. */
    resolvedBy: adminAccountActorSchema.nullable(),
    /** The action that resolved it (`actioned`), or null. */
    actionId: z.uuid().nullable(),
    /** The operator's reason for dismissing it (`dismissed`), or null. */
    dismissalReason: z.string().nullable(),
    aboutViewer: aboutViewerSchema,
  })
  .meta({ id: 'AdminReport' });
export type AdminReport = z.infer<typeof adminReportSchema>;

/**
 * What an operator took away from a profile, kept for operators for the retention period (#37-10,
 * never restored): the nickname, the 소개, or the image (its operator-only address,
 * `adminMediaPath`). Null for the other types.
 */
export const removedProfileItemSchema = z
  .discriminatedUnion('item', [
    z.object({ item: z.literal('nickname'), nickname: z.string() }),
    z.object({ item: z.literal('bio'), bio: z.string() }),
    z.object({ item: z.literal('image'), imageUrl: z.string() }),
  ])
  .meta({ id: 'RemovedProfileItem' });
export type RemovedProfileItem = z.infer<typeof removedProfileItemSchema>;

/**
 * One moderation action, for operators: everything recorded with it — but the operators, for the
 * admin it was taken on (`aboutViewer`).
 */
export const adminModerationActionSchema = z
  .object({
    id: z.uuid(),
    type: moderationActionTypeSchema,
    user: moderationUserSchema,
    /** The item it was about (a hiding's, a warning's when given), or null. */
    subject: moderationTargetSchema.nullable(),
    reason: hiddenReasonSchema,
    /** The operator who took it; null for the admin it was taken on (`aboutViewer`). */
    createdBy: adminAccountActorSchema.nullable(),
    createdAt: z.iso.datetime(),
    endsAt: z.iso.datetime().nullable(),
    cancelledAt: z.iso.datetime().nullable(),
    /** Who cancelled it; null while it stands, and for the admin it was taken on. */
    cancelledBy: adminAccountActorSchema.nullable(),
    cancelReason: z.string().nullable(),
    removed: removedProfileItemSchema.nullable(),
    /** How many reports it resolved. */
    reportCount: z.number().int().min(0),
    aboutViewer: aboutViewerSchema,
  })
  .meta({ id: 'AdminModerationAction' });
export type AdminModerationAction = z.infer<typeof adminModerationActionSchema>;

/** How many reports of one reason, in a queue entry. */
export const reasonCountSchema = z
  .object({ reason: reportReasonSchema, count: z.number().int().positive() })
  .meta({ id: 'ReportReasonCount' });

/**
 * One entry of the report queue (`GET /admin/reports`): the reports on one target together (#50
 * guidance: grouped by target), with what the target is now — a post's title and the start of its
 * text, a comment's start, a profile's nickname — the member reported, the counts and the times.
 * The counts are operators' to read; nothing acts on them (#45-10).
 */
export const adminReportGroupSchema = z
  .object({
    target: moderationTargetSchema,
    user: moderationUserSchema,
    state: moderationItemStateSchema,
    /** A post's title; null for the rest and for a post without one. */
    title: z.string().nullable(),
    /** The start of a post's or a comment's text, a profile's nickname. */
    excerpt: z.string(),
    pendingCount: z.number().int().min(0),
    reportCount: z.number().int().positive(),
    reporterCount: z.number().int().positive(),
    /** Per reason, the pending reports' (or every report's, once none is pending). */
    reasons: z.array(reasonCountSchema),
    /** The oldest pending report's intake; null once none is pending. */
    firstPendingAt: z.iso.datetime().nullable(),
    latestReportAt: z.iso.datetime(),
    /** The latest processing; null while none was processed. */
    lastResolvedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'AdminReportGroup' });
export type AdminReportGroup = z.infer<typeof adminReportGroupSchema>;

/**
 * Which part of the queue: `pending` — targets with a pending report, the oldest waiting first —
 * or `resolved` — targets whose reports were all processed, the latest processing first.
 */
export const ADMIN_REPORT_QUEUES = ['pending', 'resolved'] as const;
export type AdminReportQueue = (typeof ADMIN_REPORT_QUEUES)[number];

/** `GET /admin/reports` (no `.meta`: a query, expanded per field). */
export const adminReportQuerySchema = cursorQuerySchema.extend({
  status: z.enum(ADMIN_REPORT_QUEUES).default('pending'),
});
export type AdminReportQuery = z.infer<typeof adminReportQuerySchema>;

/** One earlier version of a post (`post_revisions`), for operators (#45-4). */
export const adminPostRevisionSchema = z
  .object({
    id: z.number().int(),
    title: z.string().nullable(),
    body: postDocumentSchema,
    writtenAt: z.iso.datetime(),
    replacedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminPostRevision' });

/** One earlier version of a comment (`post_comment_revisions`), for operators (#45-4). */
export const adminCommentRevisionSchema = z
  .object({
    id: z.number().int(),
    body: z.string(),
    writtenAt: z.iso.datetime(),
    replacedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminCommentRevision' });

/**
 * A 댓글 or 대댓글 under a post, for operators: the way to its own moderation page whether it was
 * reported or not (decision 4 #50: an operator acts without a report too; a comment has no address
 * of its own on the public screens). The 댓글 it hangs under (null for a 댓글), its author, its state
 * and the start of its text whatever the state — operators read a deleted original (#45-5).
 */
export const adminPostCommentSchema = z
  .object({
    id: z.uuid(),
    parentId: z.uuid().nullable(),
    author: moderationUserSchema,
    state: moderationItemStateSchema,
    excerpt: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminPostComment' });
export type AdminPostComment = z.infer<typeof adminPostCommentSchema>;

/**
 * `GET /admin/moderation/posts/:postId`: the post whatever its state — the deleted original too
 * (#45-5) — with its earlier versions (#45-4), every comment under it (`AdminPostComment`: each
 * 댓글 oldest first with its 대댓글 after it, oldest first), the reports on it, the actions about it
 * and the author's whole record of actions (#50: «past actions on the user»). Images by media id;
 * operators read them at `adminMediaPath`.
 */
export const adminPostModerationSchema = z
  .object({
    id: z.uuid(),
    state: moderationItemStateSchema,
    title: z.string().nullable(),
    body: postDocumentSchema,
    market: z.object({ id: z.uuid(), slug: z.string(), title: z.string() }),
    author: moderationUserSchema,
    createdAt: z.iso.datetime(),
    editedAt: z.iso.datetime().nullable(),
    deletedAt: z.iso.datetime().nullable(),
    hiddenAt: z.iso.datetime().nullable(),
    revisions: z.array(adminPostRevisionSchema),
    comments: z.array(adminPostCommentSchema),
    reports: z.array(adminReportSchema),
    reporterCount: z.number().int().min(0),
    actions: z.array(adminModerationActionSchema),
    authorActions: z.array(adminModerationActionSchema),
  })
  .meta({ id: 'AdminPostModeration' });
export type AdminPostModeration = z.infer<typeof adminPostModerationSchema>;

/** `GET /admin/moderation/comments/:commentId`: the same for a 댓글 or a 대댓글. */
export const adminCommentModerationSchema = z
  .object({
    id: z.uuid(),
    state: moderationItemStateSchema,
    /** The 댓글 a 대댓글 hangs under; null for a 댓글. */
    parentId: z.uuid().nullable(),
    body: z.string(),
    post: z.object({
      id: z.uuid(),
      title: z.string().nullable(),
      state: moderationItemStateSchema,
    }),
    author: moderationUserSchema,
    createdAt: z.iso.datetime(),
    editedAt: z.iso.datetime().nullable(),
    deletedAt: z.iso.datetime().nullable(),
    hiddenAt: z.iso.datetime().nullable(),
    revisions: z.array(adminCommentRevisionSchema),
    reports: z.array(adminReportSchema),
    reporterCount: z.number().int().min(0),
    actions: z.array(adminModerationActionSchema),
    authorActions: z.array(adminModerationActionSchema),
  })
  .meta({ id: 'AdminCommentModeration' });
export type AdminCommentModeration = z.infer<typeof adminCommentModerationSchema>;

/**
 * `GET /admin/moderation/users/:userId`: a member's public profile as it is now (the image at its
 * operator-only address), the reports on the profile and every action taken on the member — the
 * profile items taken away among them, kept for operators (#37-10).
 */
export const adminUserModerationSchema = z
  .object({
    user: moderationUserSchema,
    bio: z.string().nullable(),
    imageUrl: z.string().nullable(),
    reports: z.array(adminReportSchema),
    reporterCount: z.number().int().min(0),
    actions: z.array(adminModerationActionSchema),
  })
  .meta({ id: 'AdminUserModeration' });
export type AdminUserModeration = z.infer<typeof adminUserModerationSchema>;

/**
 * The reason every action carries (owner decision 2026-10-22 on #51, ADR-0080: «사유 목록 중 하나 +
 * 운영자 설명»): a report reason and the operator's explanation the member reads — optional, and
 * required with `other` as a report's description is (ADR-0081).
 */
const actionReasonShape = {
  reason: reportReasonSchema,
  note: optionalTextSchema(MODERATION_NOTE_MAX_LENGTH).describe(
    `The explanation the member reads, plain text, at most ${String(MODERATION_NOTE_MAX_LENGTH)} ` +
      'characters after trimming; required with the reason other',
  ),
  /** The signed-in admin the screen is showing. */
  expectedAccountId: expectedAccountIdSchema,
};

function noteForOther(body: { reason: ReportReason; note: string | null }, ctx: z.RefinementCtx) {
  if (reasonNeedsText(body.reason) && body.note === null) {
    ctx.addIssue({ code: 'custom', path: ['note'], message: OTHER_NEEDS_TEXT_MESSAGE });
  }
}

/**
 * `POST /admin/moderation/posts/:postId/hide`, `…/comments/:commentId/hide`, and the profile items'
 * `…/users/:userId/nickname-reset`, `…/bio-clear`, `…/image-remove`: the reason.
 */
export const moderationActionBodySchema = z
  .object(actionReasonShape)
  .superRefine(noteForOther)
  .meta({ id: 'ModerationActionBody' });
export type ModerationActionBody = z.input<typeof moderationActionBodySchema>;
export type ParsedModerationActionBody = z.output<typeof moderationActionBodySchema>;

/**
 * What a warning is about, when it is about something: the member's post, comment or profile —
 * whose pending reports the warning then resolves. The ids are lower-cased (`uuidSchema`): the
 * reports are matched on their text key (`reports.target_key`, a uuid printed lower-case), which
 * an upper-case id would never meet.
 */
export const warningSubjectSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('post'), postId: uuidSchema }),
    z.object({ type: z.literal('comment'), commentId: uuidSchema }),
    z.object({ type: z.literal('profile') }),
  ])
  .meta({ id: 'WarningSubject' });
export type WarningSubject = z.infer<typeof warningSubjectSchema>;

/** `POST /admin/moderation/users/:userId/warn`: the reason, and what it is about (optional). */
export const warningBodySchema = z
  .object({ ...actionReasonShape, subject: warningSubjectSchema.nullable().default(null) })
  .superRefine(noteForOther)
  .meta({ id: 'WarningBody' });
export type WarningBody = z.input<typeof warningBodySchema>;
export type ParsedWarningBody = z.output<typeof warningBodySchema>;

/** `POST /admin/moderation/actions/:actionId/cancel`: why (required, operators only). */
export const cancelModerationBodySchema = z
  .object({
    reason: requiredTextSchema(MODERATION_REASON_MAX_LENGTH),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'CancelModerationBody' });
export type CancelModerationBody = z.input<typeof cancelModerationBodySchema>;
export type ParsedCancelModerationBody = z.output<typeof cancelModerationBodySchema>;

/** Reports one dismissal takes at most. */
export const DISMISS_REPORTS_MAX = 100;

/**
 * `POST /admin/reports/dismiss`: the pending reports the operator dismisses (기각) — the ones the
 * screen showed, so one that arrived since stays pending — and why (required, operators only). The
 * ids are lower-cased (`uuidSchema`), so one named twice in two cases is one, and the audit row
 * keeps the rows' own ids. At most DISMISS_REPORTS_MAX: the screen sends the oldest pending ones
 * of a target with more, and the rest wait for the next dismissal (ADR-0081).
 */
export const dismissReportsBodySchema = z
  .object({
    reportIds: z.array(uuidSchema).min(1).max(DISMISS_REPORTS_MAX),
    reason: requiredTextSchema(MODERATION_REASON_MAX_LENGTH),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'DismissReportsBody' });
export type DismissReportsBody = z.input<typeof dismissReportsBodySchema>;
export type ParsedDismissReportsBody = z.output<typeof dismissReportsBodySchema>;

/** The answer of a dismissal: the reports as they are now. */
export const dismissedReportsSchema = z
  .object({ reports: z.array(adminReportSchema) })
  .meta({ id: 'DismissedReports' });
export type DismissedReports = z.infer<typeof dismissedReportsSchema>;

/**
 * Why an operator action or a processing is refused (MODERATION_NOT_ALLOWED):
 * - `own`: it is about the acting operator — their post, comment or profile, or a report on one
 *   (decision 4 #50 «다른 운영자만 처리한다»);
 * - `hidden`: the post or comment is hidden already;
 * - `deleted`: its author deleted it (a hiding would change nothing the public sees);
 * - `nothing_to_remove`: the profile has no 소개 or image, or its nickname is an auto nickname;
 * - `cancelled`: the action was cancelled already;
 * - `resolved`: a report was processed already;
 * - `not_theirs`: a warning's subject is not the member's.
 */
export const MODERATION_REFUSALS = [
  'own',
  'hidden',
  'deleted',
  'nothing_to_remove',
  'cancelled',
  'resolved',
  'not_theirs',
] as const;
export type ModerationRefusal = (typeof MODERATION_REFUSALS)[number];
export const moderationNotAllowedDetailsSchema = z
  .object({ reason: z.enum(MODERATION_REFUSALS).meta({ id: 'ModerationRefusal' }) })
  .meta({ id: 'ModerationNotAllowedDetails' });
export type ModerationNotAllowedDetails = z.infer<typeof moderationNotAllowedDetailsSchema>;

/** Where operators read a stored image, whatever shows it (`GET /admin/media/:mediaId`). */
export function adminMediaPath(mediaId: string): string {
  return `/api/v1/admin/media/${mediaId}`;
}
