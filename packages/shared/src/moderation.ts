import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
import { uuidSchema } from './api/uuid.js';
import { adminAccountActorSchema } from './admin-accounts.js';
import { APPROVAL_REASON_MAX_LENGTH, approvalReasonSchema } from './approvals.js';
import { commentedPostSchema } from './authored.js';
import { normaliseCommentBody } from './comment.js';
import {
  accountRestrictionReasonSchema,
  approvalStatusSchema,
  moderationActionTypeSchema,
  moderationReasonSchema,
  reportReasonSchema,
  reportStatusSchema,
  restrictionEndChangeKindSchema,
  roleSchema,
  type ModerationReason,
} from './enums.js';
import { NICKNAME_HOLD_DAYS } from './nickname.js';
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
 * - 작성 제한 (#185, ADR-0082; ADR-0069 decision 2 #45-12, #45-14, decision 3 #37-9, decision 4 #185
 *   rows): an operator restricts a member's writing for WRITING_RESTRICTION_DAYS — 1, 3, 7 or 30
 *   days — or 무기한, from the report queue or directly, with a reason. Under it the member writes
 *   no post, comment or 대댓글, edits none of their own and gives no public profile item a new value
 *   (RESTRICTED, with the end); deleting their own, likes, reports and private settings stay open.
 *   A term ends by itself — the time is compared, nothing runs — and an operator lifts it early or
 *   brings its end forward (감경, 무기한 to a term included), each with a reason. Restricted again
 *   while one stands, the one that ends later governs (#45-12 «더 늦게 끝나는 쪽»): every
 *   restriction is its own record, and the latest end among those standing is the member's.
 * - 계정 제한 (#139, ADR-0085; ADR-0069 decision 1 #57-12…#57-15, decision 3 #37-8, #37-9, decision
 *   4 #139 and #140 rows; ADR-0056 decision 1-7): an operator asks for a member's account to be
 *   restricted for ACCOUNT_RESTRICTION_DAYS or 무기한, with one of ACCOUNT_RESTRICTION_REASONS and
 *   an explanation the member reads (required), from the report queue or directly — and nothing is
 *   in force until another admin approves the request (approval_requests). The same holds for
 *   lifting it early, bringing its end forward (감경) and cancelling it. Under it the member places
 *   no new order (the check #119 calls), proposes no market (#77), gives no public profile item a
 *   new value and does not withdraw (#140); writing, likes, reports, the 관심 등록, the balance and
 *   every record stay as they were. The member reads the fact, the reason, the end and the way to
 *   appeal — never which operators asked or approved (#139 «건 운영자는 보이지 않는다»).
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
 * 14일 안»). The screens count them from the action's time (`appealDeadlineOf`) and word the notice
 * (#186, ADR-0084).
 *
 * Nothing on the server reads it: an appeal goes to the customer centre's email and the app neither
 * takes nor records one (ADR-0069 decision 2 #45-14 «앱에는 이의를 받거나 기록하는 화면이 없고»). An
 * operator who accepts one uses the action's own cancellation — and, once #185 and #139 add the
 * restrictions, their lifting or shortening (감경) — which keeps its reason like any other. So the
 * window lives in the member's notice alone — each action's '이의 기한', the exact instant (owner
 * decision 2026-10-22 답 1), in time to the end of the minute it shows (owner decision 2026-10-23
 * 답 5, `appealWindowEndOf`) — and the operator's procedure, which judges an appeal by when the
 * customer centre's mailbox received it (답 10, docs/OPERATIONS.md); no route enforces it.
 */
export const APPEAL_WINDOW_DAYS = 14;

/**
 * An action taken at `createdAt`'s appeal deadline, the one every screen shows (APPEAL_WINDOW_DAYS ×
 * 24 hours later, owner decision 2026-10-22 답 1). The screens show it to the minute; the window
 * runs to the end of that minute (`appealWindowEndOf`).
 */
export function appealDeadlineOf(createdAt: string | Date): Date {
  const start = typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
  return new Date(start.getTime() + APPEAL_WINDOW_DAYS * 24 * 60 * 60 * 1_000);
}

/**
 * The first instant an appeal of an action taken at `createdAt` is late: the end of the minute its
 * deadline (`appealDeadlineOf`) shows in. Every screen writes that deadline to the minute, and mail
 * the customer centre's mailbox receives up to that minute's last second (…:59) is in time (owner
 * decision 2026-10-23 답 5) — so the member's card turns to '이의 기한이 지났습니다.' here, not at
 * the exact instant inside the minute. The minute is cut in UTC: every zone a member may pick is a
 * whole number of minutes from it, so it is the minute the member's own zone shows (and KST's, which
 * the operator's lookup writes).
 */
export function appealWindowEndOf(createdAt: string | Date): Date {
  const minute = 60 * 1_000;
  return new Date(Math.floor(appealDeadlineOf(createdAt).getTime() / minute) * minute + minute);
}

/**
 * When the hold of the nickname a reset taken at `createdAt` took away ends (NICKNAME_HOLD_DAYS
 * later): the hold starts at the action's own time (ModerationService), and `nickname_held()` holds
 * it while `released_at` is less than 30 days back — so up to this instant, not at it. The member's
 * 조치·신고 내역 tells them of it until then, unless the reset was cancelled (owner decision
 * 2026-10-22, ADR-0081): a cancellation hands the hold to the member.
 */
export function nicknameHoldEndOf(createdAt: string | Date): Date {
  const start = typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
  return new Date(start.getTime() + NICKNAME_HOLD_DAYS * 24 * 60 * 60 * 1_000);
}

/**
 * The terms of a writing restriction, in days (ADR-0069 decision 2 #45-12 «1·3·7·30일과 무기한에서
 * 고른다»); 무기한 is none (`days: null`). A day is 24 hours from the restriction's own time.
 */
export const WRITING_RESTRICTION_DAYS = [1, 3, 7, 30] as const;
export type WritingRestrictionDays = (typeof WRITING_RESTRICTION_DAYS)[number];

/**
 * When a writing restriction given at `createdAt` for `days` ends (null: 무기한, no end). The
 * restriction holds while the clock is before this instant, and not at it.
 */
export function writingRestrictionEndOf(
  createdAt: string | Date,
  days: WritingRestrictionDays | null,
): Date | null {
  if (days === null) return null;
  const start = typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1_000);
}

/**
 * The terms of an account restriction, in days (#139, ADR-0069 decision 1 #57-12 «기간제와 무기한»);
 * 무기한 is none (`days: null`). The writing restriction's four (#45-12), as the owner decided
 * (owner decision 2026-10-23, ADR-0085 decision 1 and 7-2). A day is 24 hours from the
 * restriction's own time — its approval, when it comes into force.
 */
export const ACCOUNT_RESTRICTION_DAYS = [1, 3, 7, 30] as const;
export type AccountRestrictionDays = (typeof ACCOUNT_RESTRICTION_DAYS)[number];

/**
 * When an account restriction in force from `createdAt` (its approval) for `days` ends — null for
 * 무기한. It holds while the clock is before this instant, and not at it, as a writing restriction.
 */
export function accountRestrictionEndOf(
  createdAt: string | Date,
  days: AccountRestrictionDays | null,
): Date | null {
  if (days === null) return null;
  const start = typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1_000);
}

/**
 * The restrictions that refuse a member's action (RESTRICTED): `writing` (작성 제한, #185) and
 * `account` (계정 제한, #139). A refusal both refuse — a public profile item's new value, a market
 * proposal, 탈퇴 — names the one that ends later (ADR-0085 7-6).
 */
export const RESTRICTION_KINDS = ['writing', 'account'] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

/**
 * RESTRICTED (#185, owner decision 2026-10-21 on #41: a code of its own carrying the end): which
 * restriction refused the action and when it ends — null for 무기한, which ends only when an
 * operator lifts it. Restricted more than once, the end is the latest among the standing ones
 * (#45-12). Only ever the requester's own: nothing public carries it (#45-12, #37-8).
 */
export const restrictedDetailsSchema = z
  .object({
    kind: z.enum(RESTRICTION_KINDS).meta({ id: 'RestrictionKind' }),
    endsAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'RestrictedDetails' });
export type RestrictedDetails = z.infer<typeof restrictedDetailsSchema>;

/**
 * `GET /me/moderation/restriction` (#185, #139): the restrictions that govern the member now, each
 * as a refusal names it (RESTRICTED's details) or null when none of that kind stands —
 * `restriction`, the writing restriction (#185: what a refused post, comment or edit names), and
 * `accountRestriction`, the account restriction (#139: what a refused order names). What the
 * banners read (ADR-0069 decision 4 #50 «진행 중인 제재가 있으면 MY 요약·글쓰기 화면의 안내 띠»),
 * apart from the paged list of actions, so no number of later actions keeps one from a banner.
 * The member's own: never the operator, the reason nor a report (#45-13, #139).
 */
export const myRestrictionSchema = z
  .object({
    /** The writing restriction in force (kind `writing`), or null. */
    restriction: restrictedDetailsSchema.nullable(),
    /** The account restriction in force (kind `account`), or null. */
    accountRestriction: restrictedDetailsSchema.nullable(),
  })
  .meta({ id: 'MyRestriction' });
export type MyRestriction = z.infer<typeof myRestrictionSchema>;

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
export function reasonNeedsText(reason: ModerationReason): boolean {
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
 * The reason an action carries (owner decision 2026-10-22 on #51, ADR-0080: «사유 목록 중 하나 + 운영자
 * 설명»): the reason the operator picked — a report reason (#45-10), or for an account restriction
 * one of ACCOUNT_RESTRICTION_REASONS (#57-12) — and the explanation they wrote, null when none.
 * `HiddenReason`'s shape: a hiding's is one of these.
 */
export const actionReasonSchema = z
  .object({
    code: moderationReasonSchema,
    /** The operator's explanation, as they wrote it; null when they wrote none. */
    note: z.string().nullable(),
  })
  .meta({ id: 'ActionReason' });
export type ActionReason = z.infer<typeof actionReasonSchema>;

/**
 * How an operator brought a writing restriction's end forward, as the member reads it (#185, owner
 * decision 2026-10-23 answer 4: «조기 해제·감경 → 회원의 조치·신고 내역에 '조기 해제됨'·'감경됨'과 바뀐
 * 끝, 원래 끝을 보임(사유는 운영자만)»): the kind of the latest change — `lift` (조기 해제됨, which
 * ends it: nothing changes it after) or `shorten` (감경됨) — and the end it was given
 * (`originalEndsAt`, null for 무기한). The changed end is the action's `endsAt`. Never the reason,
 * the operator, nor when or how many times it changed (operators' record, `RestrictionEndChange`).
 */
export const myRestrictionEndChangeSchema = z
  .object({
    kind: restrictionEndChangeKindSchema,
    originalEndsAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MyRestrictionEndChange' });
export type MyRestrictionEndChange = z.infer<typeof myRestrictionEndChangeSchema>;

/**
 * One action an operator took on the member (`GET /me/moderation/actions`, #45-13: «조치 종류·사유·
 * 기간·이의 방법»; #139: «제한 사실·사유·종료 시각·이의 경로»): its type, the reason — the reason the
 * operator picked and the explanation they wrote (`ActionReason`, ADR-0080) — when (an account
 * restriction's: when its approval put it in force), its end (`endsAt`: a writing or an account
 * restriction's as it stands now — brought forward when an operator lifted it or shortened it
 * (#185, #139) — and null for 무기한; null for every type #50 takes, which have no end), how it was
 * brought forward (`endChange`) and whether it was cancelled since. The appeal deadline is
 * `appealDeadlineOf(createdAt)`, in time to the end of its minute (`appealWindowEndOf`). Never the
 * operator, nor a report or its reporter, nor who changed the end or why, nor who asked for or
 * approved an account restriction (operators' record, ADR-0082, ADR-0085).
 */
export const myModerationActionSchema = z
  .object({
    id: z.uuid(),
    type: moderationActionTypeSchema,
    reason: actionReasonSchema,
    subject: myActionSubjectSchema.nullable(),
    createdAt: z.iso.datetime(),
    endsAt: z.iso.datetime().nullable(),
    /**
     * A writing or an account restriction an operator lifted early or shortened: the latest
     * change's kind and the end it was given. Null when its end never changed, and for every type
     * #50 takes.
     */
    endChange: myRestrictionEndChangeSchema.nullable(),
    /** When an operator cancelled it; null while it stands. */
    cancelledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MyModerationAction' });
export type MyModerationAction = z.infer<typeof myModerationActionSchema>;

// ---- operators -----------------------------------------------------------------------------------

/**
 * An account as the moderation screens name it: the account id, the public face and the role. The
 * nickname is null for an account its member closed (#140, ADR-0069 decision 3 #37-16: the public
 * items went with the closure, and its profile answers as for no account) — its reports, actions
 * and posts stay for operators (#57-18).
 */
export const moderationUserSchema = z
  .object({
    id: z.string(),
    publicId: publicIdSchema,
    nickname: z.string().nullable(),
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
 * Another admin's approval that put an account restriction's step in force (#139, ADR-0056
 * decision 1-7): the request it decided (`approval_requests`), the approving admin — withheld for
 * the admin the restriction is on (`aboutViewer`) — their reason and when. The step itself was
 * asked for by the operator its record names (`createdBy`, `cancelledBy`), with that operator's
 * reason.
 */
export const moderationApprovalSchema = z
  .object({
    requestId: z.uuid(),
    /** Null for the admin the restriction is on (`aboutViewer`). */
    decidedBy: adminAccountActorSchema.nullable(),
    reason: z.string(),
    decidedAt: z.iso.datetime(),
  })
  .meta({ id: 'ModerationApproval' });
export type ModerationApproval = z.infer<typeof moderationApprovalSchema>;

/**
 * One change of a writing or an account restriction's end, for operators (#185, ADR-0082; #139,
 * ADR-0085): a shortening (감경) or an early lift (조기 해제), the end before it (null for 무기한)
 * and after it, the operator's reason (operators only, as a cancellation's), who and when — the
 * operator withheld for the admin the restriction is on (`aboutViewer`). An account restriction's
 * change is the asking operator's and comes into force with another admin's approval
 * (`approval`); a writing restriction's has none.
 */
export const restrictionEndChangeSchema = z
  .object({
    kind: restrictionEndChangeKindSchema,
    previousEndsAt: z.iso.datetime().nullable(),
    endsAt: z.iso.datetime(),
    reason: z.string(),
    /** Null for the admin the restriction is on (`aboutViewer`). */
    createdBy: adminAccountActorSchema.nullable(),
    createdAt: z.iso.datetime(),
    /** The approval it came into force by (an account restriction's); null for a writing one. */
    approval: moderationApprovalSchema.nullable(),
  })
  .meta({ id: 'RestrictionEndChange' });
export type RestrictionEndChange = z.infer<typeof restrictionEndChangeSchema>;

/**
 * One moderation action, for operators: everything recorded with it — but the operators, for the
 * admin it was taken on (`aboutViewer`).
 */
export const adminModerationActionSchema = z
  .object({
    id: z.uuid(),
    type: moderationActionTypeSchema,
    user: moderationUserSchema,
    /** The item it was about (a hiding's, a warning's or a restriction's when given), or null. */
    subject: moderationTargetSchema.nullable(),
    reason: actionReasonSchema,
    /**
     * The operator who took it — for an account restriction, the one who asked for it; null for
     * the admin it was taken on (`aboutViewer`).
     */
    createdBy: adminAccountActorSchema.nullable(),
    /** When it was taken — an account restriction's: when its approval put it in force. */
    createdAt: z.iso.datetime(),
    /**
     * An account restriction's approval by another admin (#139); null for the other types.
     */
    approval: moderationApprovalSchema.nullable(),
    /**
     * A writing or an account restriction's end as it stands now (null: 무기한); null for the
     * other types. The changes that brought it forward are `endChanges`.
     */
    endsAt: z.iso.datetime().nullable(),
    cancelledAt: z.iso.datetime().nullable(),
    /**
     * Who cancelled it — an account restriction's: who asked for the cancellation; null while it
     * stands, and for the admin it was taken on.
     */
    cancelledBy: adminAccountActorSchema.nullable(),
    cancelReason: z.string().nullable(),
    /** The approval an account restriction's cancellation came into force by; null otherwise. */
    cancelApproval: moderationApprovalSchema.nullable(),
    removed: removedProfileItemSchema.nullable(),
    /** How many reports it resolved. */
    reportCount: z.number().int().min(0),
    /**
     * A writing or an account restriction's shortenings and lift, oldest first; empty for the
     * other types.
     */
    endChanges: z.array(restrictionEndChangeSchema),
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
    /**
     * The start of a post's or a comment's text, a profile's nickname — null for the profile of a
     * member who closed the account (#140: the nickname went with the closure).
     */
    excerpt: z.string().nullable(),
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
    /**
     * When #184's retention emptied it: a deleted original once its period had passed since the
     * deletion, or a withdrawn member's post an operator still hides once the 신고·제재 period had
     * passed since the later of the withdrawal and the hiding (owner decision 2026-10-24 3 — it
     * stays hidden, `state` 'hidden', and its hiding's action is deleted, as are its earlier
     * versions, `revisions` empty: owner decision 2026-10-24 (2차) 2), so it does not imply
     * `deletedAt`. Then `title` is null and `body` empty, and the images it alone used are gone.
     * Null otherwise.
     */
    purgedAt: z.iso.datetime().nullable(),
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
    /**
     * When #184's retention emptied it, as a post's (`AdminPostModeration.purgedAt`): a deleted
     * original, or a withdrawn member's comment an operator still hides (it stays hidden, its
     * hiding's action and its earlier versions deleted — owner decisions 2026-10-24 3 and (2차) 2),
     * so it does not imply `deletedAt`. Then `body` is empty. Null otherwise.
     */
    purgedAt: z.iso.datetime().nullable(),
    revisions: z.array(adminCommentRevisionSchema),
    reports: z.array(adminReportSchema),
    reporterCount: z.number().int().min(0),
    actions: z.array(adminModerationActionSchema),
    authorActions: z.array(adminModerationActionSchema),
  })
  .meta({ id: 'AdminCommentModeration' });
export type AdminCommentModeration = z.infer<typeof adminCommentModerationSchema>;

// ---- account restriction requests (#139, ADR-0085) ----------------------------------------------

/**
 * What an account restriction request asks for (#139, ADR-0056 decision 1-7 «계정 제한·해제는 다른
 * 운영자의 승인»; ADR-0069 decision 1 #57-12 and decision 2 #45-14): `apply` — restrict the member's
 * account; `shorten` — bring a standing restriction's end forward (감경, 무기한 to a term included);
 * `lift` — end it now (조기 해제); `cancel` — void it (취소, #50). Each is done only once another
 * admin approves the request, and then in the approval's transaction.
 */
export const ACCOUNT_RESTRICTION_CHANGES = ['apply', 'shorten', 'lift', 'cancel'] as const;
export type AccountRestrictionChange = (typeof ACCOUNT_RESTRICTION_CHANGES)[number];
export const accountRestrictionChangeSchema = z
  .enum(ACCOUNT_RESTRICTION_CHANGES)
  .meta({ id: 'AccountRestrictionChange' });

/**
 * The two-person rule's `kind` of each change (approvals.ts: lower-case words joined by `_`) — the
 * names `approval_requests.kind` holds for #139 (migration 0042's triggers match them).
 */
export const ACCOUNT_RESTRICTION_APPROVAL_KINDS = {
  apply: 'account_restriction',
  shorten: 'account_restriction_shorten',
  lift: 'account_restriction_lift',
  cancel: 'account_restriction_cancel',
} as const satisfies Record<AccountRestrictionChange, string>;
export type AccountRestrictionApprovalKind =
  (typeof ACCOUNT_RESTRICTION_APPROVAL_KINDS)[AccountRestrictionChange];

/** The change an approval request's `kind` names, or null for another consumer's request. */
export function accountRestrictionChangeOf(kind: string): AccountRestrictionChange | null {
  const found = ACCOUNT_RESTRICTION_CHANGES.find(
    (change) => ACCOUNT_RESTRICTION_APPROVAL_KINDS[change] === kind,
  );
  return found ?? null;
}

/**
 * What an `apply` request asks for: the reason (one of ACCOUNT_RESTRICTION_REASONS and the
 * explanation the member will read), the term (`days`, null for 무기한), what it is about (the
 * member's post, comment or profile, whose pending reports its approval resolves; null for none)
 * and the operators' own memo (owner decision 2026-10-23, ADR-0085: optional, for every operator —
 * the one who asked included — never the member's: null for none, and for the admin it is about).
 */
export const accountRestrictionApplySchema = z
  .object({
    reason: actionReasonSchema,
    days: z.number().int().positive().nullable(),
    subject: moderationTargetSchema.nullable(),
    memo: z.string().nullable(),
  })
  .meta({ id: 'AccountRestrictionApply' });
export type AccountRestrictionApply = z.infer<typeof accountRestrictionApplySchema>;

/**
 * Why a pending request can no longer be approved (MODERATION_NOT_ALLOWED's reasons an approval
 * re-checks): the restriction was cancelled (`cancelled`) or has ended (`ended`) since — the
 * change it asks for has nothing left to change — or a 감경's end is not before the end now
 * (`not_earlier`) or no longer to come (`end_passed`).
 */
export const ACCOUNT_RESTRICTION_MOOTS = [
  'cancelled',
  'ended',
  'not_earlier',
  'end_passed',
] as const;
export type AccountRestrictionMoot = (typeof ACCOUNT_RESTRICTION_MOOTS)[number];

/**
 * The restriction a `shorten`, `lift` or `cancel` request is about, as it stands now: when it was
 * given (its approval's time), its end now (null: 무기한), its reason and its cancellation. A member
 * can have several account restrictions (ADR-0085 7-3), so the approving admin reads which one the
 * request changes and how far a 감경 brings its end forward.
 */
export const accountRestrictionTargetSchema = z
  .object({
    createdAt: z.iso.datetime(),
    endsAt: z.iso.datetime().nullable(),
    reason: actionReasonSchema,
    cancelledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'AccountRestrictionTarget' });
export type AccountRestrictionTarget = z.infer<typeof accountRestrictionTargetSchema>;

/**
 * One account restriction request, for operators (#139, ADR-0085): what it asks for, the member it
 * is about, who asked, why and when, and how it closed — `pending` until an admin other than the
 * one who asked approves or rejects it, once (`approval_requests`), or until the one who asked
 * retracts it (`retracted`, `retractedAt` — owner decision 2026-10-23: theirs alone, before any
 * decision, recorded; a retracted request is decided by no one). There is no expiry. One about an
 * operator is decided by a third admin, neither the one who asked nor that operator (7-15), and is
 * not taken at all when no such admin exists (MODERATION_NOT_ALLOWED `no_decider`, owner decision
 * 2026-10-23). `moot` says what an approval would be refused for now — the restriction cancelled,
 * ended or past the end asked for since the request (MODERATION_NOT_ALLOWED's reason) — so the
 * screen offers only a rejection; null when it can be approved, and once closed. For the admin the
 * request is about (`aboutViewer`) the asking and the deciding admins and the operators' memo are
 * withheld (owner decision 2026-10-21, ADR-0081; 2026-10-23), and they decide nothing about
 * themselves (`own`).
 */
export const accountRestrictionRequestSchema = z
  .object({
    id: z.uuid(),
    change: accountRestrictionChangeSchema,
    user: moderationUserSchema,
    /**
     * The restriction a `shorten`, `lift` or `cancel` is about; for an `apply`, the restriction
     * its approval put in force (null while pending, and once rejected).
     */
    actionId: z.uuid().nullable(),
    /** The restriction a `shorten`, `lift` or `cancel` changes, as it stands now; null for `apply`. */
    target: accountRestrictionTargetSchema.nullable(),
    /** What an `apply` asks for; null for the other changes. */
    apply: accountRestrictionApplySchema.nullable(),
    /** The end a `shorten` asks for; null for the other changes. */
    endsAt: z.iso.datetime().nullable(),
    /**
     * Why it was asked for: an `apply`'s explanation (the one the member reads), the reason of a
     * change (operators only).
     */
    requestReason: z.string(),
    /** Null for the admin the request is about (`aboutViewer`). */
    requestedBy: adminAccountActorSchema.nullable(),
    requestedAt: z.iso.datetime(),
    status: approvalStatusSchema,
    /**
     * Who decided it; null while pending, once retracted, for the admin it is about, and for one
     * the member's closure closed (`closedByAccountClosure`).
     */
    decidedBy: adminAccountActorSchema.nullable(),
    decisionReason: z.string().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    /**
     * Whether the member it is about closed their account while it waited (#140, owner decision
     * 2026-10-23, ADR-0085 결과 5): then it is `rejected` by no admin, at the closure, with the
     * reason '탈퇴' (ACCOUNT_CLOSURE_DECISION_REASON) — a pending request never keeps a closure
     * from going ahead.
     */
    closedByAccountClosure: z.boolean(),
    /**
     * When the one who asked retracted it (`retracted`); null otherwise. Who retracted it is who
     * asked (`requestedBy`) — no one else can.
     */
    retractedAt: z.iso.datetime().nullable(),
    /** What approving it would be refused for now; null when it can be approved, or decided. */
    moot: z.enum(ACCOUNT_RESTRICTION_MOOTS).meta({ id: 'AccountRestrictionMoot' }).nullable(),
    aboutViewer: aboutViewerSchema,
  })
  .meta({ id: 'AccountRestrictionRequest' });
export type AccountRestrictionRequest = z.infer<typeof accountRestrictionRequestSchema>;

/**
 * Which requests (`GET /admin/moderation/account-restriction-requests`): `pending` — those waiting
 * for a decision, the one waiting longest first — `decided` — approved or rejected, the latest
 * decision first — or `retracted` — retracted by the one who asked, the latest first.
 */
export const ACCOUNT_RESTRICTION_REQUEST_QUEUES = ['pending', 'decided', 'retracted'] as const;
export type AccountRestrictionRequestQueue = (typeof ACCOUNT_RESTRICTION_REQUEST_QUEUES)[number];

/** `GET /admin/moderation/account-restriction-requests` (no `.meta`: a query, expanded per field). */
export const accountRestrictionRequestQuerySchema = cursorQuerySchema.extend({
  status: z.enum(ACCOUNT_RESTRICTION_REQUEST_QUEUES).default('pending'),
});
export type AccountRestrictionRequestQuery = z.infer<typeof accountRestrictionRequestQuerySchema>;

/**
 * The answer of an approval or a rejection: the request as decided, and the restriction as it
 * stands after — the one given or changed by an approval, the one a rejected change was about —
 * or null for a rejected `apply`.
 */
export const accountRestrictionDecisionSchema = z
  .object({
    request: accountRestrictionRequestSchema,
    action: adminModerationActionSchema.nullable(),
  })
  .meta({ id: 'AccountRestrictionDecision' });
export type AccountRestrictionDecision = z.infer<typeof accountRestrictionDecisionSchema>;

/**
 * `GET /admin/moderation/users/:userId`: a member's public profile as it is now (the image at its
 * operator-only address), the reports on the profile and every action taken on the member — the
 * profile items taken away among them, kept for operators (#37-10) — and the account restriction
 * requests about the member that wait for a decision (#139), the oldest first.
 */
export const adminUserModerationSchema = z
  .object({
    user: moderationUserSchema,
    bio: z.string().nullable(),
    imageUrl: z.string().nullable(),
    reports: z.array(adminReportSchema),
    reporterCount: z.number().int().min(0),
    actions: z.array(adminModerationActionSchema),
    accountRestrictionRequests: z.array(accountRestrictionRequestSchema),
  })
  .meta({ id: 'AdminUserModeration' });
export type AdminUserModeration = z.infer<typeof adminUserModerationSchema>;

/**
 * The reason every action carries (owner decision 2026-10-22 on #51, ADR-0080: «사유 목록 중 하나 +
 * 운영자 설명»): a report reason and the operator's explanation the member reads — optional, and
 * required with `other` as a report's description is (ADR-0081). An account restriction's is its
 * own (`accountRestrictionBodySchema`).
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

function noteForOther(
  body: { reason: ModerationReason; note: string | null },
  ctx: z.RefinementCtx,
) {
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

/**
 * `POST /admin/moderation/users/:userId/writing-restriction` (#185): the reason (a report reason
 * and the explanation the member reads), the term — `days` of WRITING_RESTRICTION_DAYS, or null for
 * 무기한, always said — and what it is about (optional, a warning's `subject`: the member's post,
 * comment or profile, whose pending reports it resolves — the report queue's way to it).
 */
export const writingRestrictionBodySchema = z
  .object({
    ...actionReasonShape,
    days: z
      .literal(WRITING_RESTRICTION_DAYS)
      .nullable()
      .describe('The term in days, 24 hours each from the restriction; null for 무기한 (no end)'),
    subject: warningSubjectSchema.nullable().default(null),
  })
  .superRefine(noteForOther)
  .meta({ id: 'WritingRestrictionBody' });
export type WritingRestrictionBody = z.input<typeof writingRestrictionBodySchema>;
export type ParsedWritingRestrictionBody = z.output<typeof writingRestrictionBodySchema>;

/**
 * `POST /admin/moderation/actions/:actionId/shorten` (감경, #45-14): the new end — earlier than the
 * restriction's end now (any, for 무기한) and still to come (a lift ends it now) — and why
 * (required, operators only, as a cancellation's).
 */
export const shortenRestrictionBodySchema = z
  .object({
    endsAt: z.iso.datetime(),
    reason: requiredTextSchema(MODERATION_REASON_MAX_LENGTH),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'ShortenRestrictionBody' });
export type ShortenRestrictionBody = z.input<typeof shortenRestrictionBodySchema>;
export type ParsedShortenRestrictionBody = z.output<typeof shortenRestrictionBodySchema>;

/** `POST /admin/moderation/actions/:actionId/lift` (조기 해제, #45-12): why (required, operators only). */
export const liftRestrictionBodySchema = z
  .object({
    reason: requiredTextSchema(MODERATION_REASON_MAX_LENGTH),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'LiftRestrictionBody' });
export type LiftRestrictionBody = z.input<typeof liftRestrictionBodySchema>;
export type ParsedLiftRestrictionBody = z.output<typeof liftRestrictionBodySchema>;

/**
 * `POST /admin/moderation/users/:userId/account-restriction` (계정 제한, #139): a request, in force
 * once another admin approves it — the reason, one of ACCOUNT_RESTRICTION_REASONS, and the
 * explanation the member reads, required whatever the reason (ADR-0069 decision 1 #57-12 «정한
 * 목록에서 하나 … 와 필수 설명»), which is also the request's reason the approving admin reads (at
 * most APPROVAL_REASON_MAX_LENGTH UTF-16 units, as the request keeps it); the term — `days` of
 * ACCOUNT_RESTRICTION_DAYS, or null for 무기한, always said — what it is about (optional, a
 * warning's `subject`: the member's post, comment or profile, whose pending reports the approval
 * resolves — the report queue's way to it) and the operators' own memo (optional, for the operators
 * and never the member — owner decision 2026-10-23, ADR-0085).
 */
export const accountRestrictionBodySchema = z
  .object({
    reason: accountRestrictionReasonSchema,
    note: requiredTextSchema(MODERATION_NOTE_MAX_LENGTH)
      .superRefine((text, ctx) => {
        if (text.length > APPROVAL_REASON_MAX_LENGTH) {
          ctx.addIssue({
            code: 'custom',
            message: textTooLongMessage(APPROVAL_REASON_MAX_LENGTH, text.length),
          });
        }
      })
      .describe(
        `The explanation the member reads, plain text, at most ${String(MODERATION_NOTE_MAX_LENGTH)} ` +
          'characters after trimming; required. Also the reason the approving admin reads',
      ),
    days: z
      .literal(ACCOUNT_RESTRICTION_DAYS)
      .nullable()
      .describe(
        'The term in days, 24 hours each from the approval that puts it in force; null for 무기한',
      ),
    subject: warningSubjectSchema.nullable().default(null),
    memo: optionalTextSchema(MODERATION_REASON_MAX_LENGTH).describe(
      'The operators’ own memo, read by the admins (not one the request is about), plain text, at most ' +
        `${String(MODERATION_REASON_MAX_LENGTH)} characters after trimming; optional, never ` +
        'shown to the member',
    ),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'AccountRestrictionBody' });
export type AccountRestrictionBody = z.input<typeof accountRestrictionBodySchema>;
export type ParsedAccountRestrictionBody = z.output<typeof accountRestrictionBodySchema>;

/**
 * `POST /admin/moderation/account-restriction-requests/:requestId/approve` and `…/reject`: the
 * deciding admin's reason, required (approvals.ts), and the account the screen shows.
 */
export const approvalDecisionBodySchema = z
  .object({ reason: approvalReasonSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'ApprovalDecisionBody' });
export type ApprovalDecisionBody = z.input<typeof approvalDecisionBodySchema>;
export type ParsedApprovalDecisionBody = z.output<typeof approvalDecisionBodySchema>;

/**
 * `POST /admin/moderation/account-restriction-requests/:requestId/retract` (owner decision
 * 2026-10-23, ADR-0085): the account the screen shows, which must be the one who asked. No reason
 * is asked: the record is who retracted it and when.
 */
export const approvalRetractionBodySchema = z
  .object({ expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'ApprovalRetractionBody' });
export type ApprovalRetractionBody = z.input<typeof approvalRetractionBodySchema>;
export type ParsedApprovalRetractionBody = z.output<typeof approvalRetractionBodySchema>;

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
 * - `not_theirs`: a warning's or a restriction's subject is not the member's;
 * - `not_restriction`: a shortening or a lift of an action that is no writing restriction (#185);
 * - `ended`: a shortening or a lift of a restriction that has ended already;
 * - `not_earlier`: a shortening whose end is not before the restriction's end now;
 * - `end_passed`: a shortening whose end is not to come — a lift ends it now;
 * - `approval_required`: a direct shortening, lift or cancellation of an account restriction, which
 *   only another admin's approval of a request does (#139, ADR-0056 decision 1-7);
 * - `not_account_restriction`: a request to shorten, lift or cancel an action that is no account
 *   restriction (#139);
 * - `no_decider`: an account restriction request no admin could decide — there is none but the one
 *   asking and the member it is about (#139, owner decision 2026-10-23: refused when asked);
 * - `closed`: a new action against an account its member closed (탈퇴 #140, owner decision
 *   2026-10-23 (2차) 1, ADR-0086) — a warning, a writing restriction, an account restriction
 *   request and the approval of one. Hiding a post or a comment of theirs is not refused (it stays
 *   public), nor is the cancellation of an earlier action; a nickname reset, a 소개 cleared and an
 *   image removed have nothing to take away (`nothing_to_remove`).
 */
export const MODERATION_REFUSALS = [
  'own',
  'hidden',
  'deleted',
  'nothing_to_remove',
  'cancelled',
  'resolved',
  'not_theirs',
  'not_restriction',
  'ended',
  'not_earlier',
  'end_passed',
  'approval_required',
  'not_account_restriction',
  'no_decider',
  'closed',
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
