import {
  DISMISS_REPORTS_MAX,
  MODERATION_NOTE_MAX_LENGTH,
  MODERATION_REASON_MAX_LENGTH,
  OTHER_NEEDS_TEXT_MESSAGE,
  REPORT_DESCRIPTION_MAX_LENGTH,
  REPORT_REASONS,
  appealDeadlineOf,
  codePointLength,
  moderationNotAllowedDetailsSchema,
  normaliseCommentBody,
  reasonNeedsText,
  reportLimitedDetailsSchema,
  reportNotAllowedDetailsSchema,
  type AdminReportQueue,
  type ModerationRefusal,
  type ReportReason,
  type ReportRefusal,
  type ReportTargetType,
} from '@buddha/shared';
import { copy } from '@/copy';
import {
  type AdminModerationAction,
  type AdminReport,
  type AdminReportGroup,
  type ModerationActionType,
  type ModerationItemState,
  type ModerationTarget,
  type MyActionSubject,
  type MyModerationAction,
  type PostAuthor,
  type RemovedProfileItem,
  type ReportStatus,
  type ReportTarget,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { reportReasonLabel } from './authored';
import { formatWait } from './phone-verification';
import { postFirstLine, postPath } from './posts';
import { profilePath } from './profile';

/**
 * 신고와 운영 처리 (#50, ADR-0081) as the screens draw them: the report dialog's rules and
 * refusals, the member's 조치·신고 내역 (`/my/moderation`), the sanction banner, and the operators'
 * queue, pages and dialogs. Pure functions of the API's answers and of what was typed, apart from
 * the components and the hooks so the node test runner reaches them (the rule lib/likes.ts
 * follows).
 *
 * Owner decisions (ADR-0069 decision 2 #45-10…#45-15, decision 3 #37-10, decision 4 #50 rows,
 * decision 7): a 근거 글, a 댓글 or 대댓글 and a member's profile take reports, one reason each and a
 * description with '기타'; never one's own; again only once one's earlier report on it was
 * processed; at most 20 a day. Nothing is hidden by a report. An operator chooses by the weight of
 * the violation (숨김·기각·경고, and for a profile the three items), acts without a report too,
 * cancels with a reason, and never processes what concerns themselves. The member acted on reads
 * the type, the reason, the end (if any) and how to appeal; the reporter reads 접수 and then
 * 조치함 or 기각. Neither reads who reported or which operator acted.
 */

// ---- addresses ---------------------------------------------------------------------------------

/**
 * The member's 조치·신고 내역 (ADR-0069 decision 4 #50: «MY 아래 별도 화면(MY 탭은 더하지 않고 MY
 * 설정에서 연결)»). Under `/my`, so MY's session gate and layout hold it, and no tab is lit there —
 * it is not one (the summary at `/my` lights none either).
 */
export const MY_MODERATION_PATH = '/my/moderation';

/** The report queue, the area's first page; `?status=resolved` is its other half. */
export const ADMIN_REPORTS_PATH = '/admin/reports';

/** Every action, newest first, with its cancellation. */
export const ADMIN_MODERATION_ACTIONS_PATH = '/admin/moderation/actions';

/** The query parameter of the queue's half; `pending` is the page without it. */
export const ADMIN_REPORT_QUEUE_PARAM = 'status';

/** The queue's half a `?status=` names: `resolved` alone, `pending` for anything else. */
export function adminReportQueueOf(param: string | string[] | null | undefined): AdminReportQueue {
  return param === 'resolved' ? 'resolved' : 'pending';
}

export function adminReportQueuePath(queue: AdminReportQueue): string {
  return queue === 'pending'
    ? ADMIN_REPORTS_PATH
    : `${ADMIN_REPORTS_PATH}?${ADMIN_REPORT_QUEUE_PARAM}=${queue}`;
}

export function adminPostModerationPath(postId: string): string {
  return `/admin/moderation/posts/${postId.toLowerCase()}`;
}

export function adminCommentModerationPath(commentId: string): string {
  return `/admin/moderation/comments/${commentId.toLowerCase()}`;
}

export function adminUserModerationPath(userId: string): string {
  return `/admin/moderation/users/${encodeURIComponent(userId)}`;
}

/** The moderation page of what a report or an action is about. */
export function adminTargetPath(target: ModerationTarget): string {
  switch (target.type) {
    case 'post':
      return adminPostModerationPath(target.postId);
    case 'comment':
      return adminCommentModerationPath(target.commentId);
    case 'profile':
      return adminUserModerationPath(target.userId);
  }
}

// ---- cache keys --------------------------------------------------------------------------------

/**
 * The member's own reports and the actions taken on them (`GET /me/reports`,
 * `/me/moderation/actions`): read with their cookie, so the root is in `PRIVATE_QUERY_ROOTS`
 * (market-keys.ts) — never fetched on the server, never dehydrated, reset with every other
 * personal entry when the session changes. No key under it says whose it is.
 */
export const MY_MODERATION_KEY = ['my-moderation'] as const;
export const MY_REPORTS_KEY = [...MY_MODERATION_KEY, 'reports'] as const;
export const MY_ACTIONS_KEY = [...MY_MODERATION_KEY, 'actions'] as const;

/**
 * The operators' reads, under the `admin` root (`PRIVATE_QUERY_ROOTS`). One prefix, so an action
 * re-reads the queue, the action log and every moderation page it may have changed at once.
 */
export const ADMIN_MODERATION_KEY = ['admin', 'moderation'] as const;
export const adminReportQueueKey = (queue: AdminReportQueue) =>
  [...ADMIN_MODERATION_KEY, 'queue', queue] as const;
export const ADMIN_ACTIONS_KEY = [...ADMIN_MODERATION_KEY, 'actions'] as const;
export const adminPostModerationKey = (postId: string) =>
  [...ADMIN_MODERATION_KEY, 'post', postId.toLowerCase()] as const;
export const adminCommentModerationKey = (commentId: string) =>
  [...ADMIN_MODERATION_KEY, 'comment', commentId.toLowerCase()] as const;
export const adminUserModerationKey = (userId: string) =>
  [...ADMIN_MODERATION_KEY, 'user', userId] as const;

/** One page of a cursor list as `useInfiniteQuery` holds it. */
export interface ModerationPage<Row> {
  items: Row[];
  nextCursor: string | null;
}

// ---- names -------------------------------------------------------------------------------------

/** The reasons in the owner's order (#45-10), with their names: the radio list and the select. */
export const REPORT_REASON_OPTIONS: readonly { code: ReportReason; label: string }[] =
  REPORT_REASONS.map((code) => ({ code, label: reportReasonLabel(code) }));

const REPORT_STATUS_LABELS: Readonly<Record<ReportStatus, string>> = {
  pending: copy.reportStatusPending,
  actioned: copy.reportStatusActioned,
  dismissed: copy.reportStatusDismissed,
};

/** 접수 · 조치함 · 기각 (#45-13: «접수 확인과 처리 결과(조치함·기각)»). */
export function reportStatusLabel(status: ReportStatus): string {
  return REPORT_STATUS_LABELS[status];
}

/** The badge colours: a pending report waits (gray), a processed one is done either way. */
export const REPORT_STATUS_PALETTE: Readonly<Record<ReportStatus, string>> = {
  pending: 'gray',
  actioned: 'orange',
  dismissed: 'gray',
};

const ACTION_LABELS: Readonly<Record<ModerationActionType, string>> = {
  hide: copy.moderationActionHide,
  warning: copy.moderationActionWarning,
  nickname_reset: copy.moderationActionNicknameReset,
  bio_clear: copy.moderationActionBioClear,
  image_remove: copy.moderationActionImageRemove,
};

/** An action's name, the same for the member and the operators. */
export function moderationActionLabel(type: ModerationActionType): string {
  return ACTION_LABELS[type];
}

const TARGET_TYPE_LABELS: Readonly<Record<ReportTargetType, string>> = {
  post: copy.reportTargetPost,
  comment: copy.reportTargetComment,
  profile: copy.reportTargetProfile,
};

/** 글 · 댓글 · 프로필: what a report or a queue entry is about. */
export function reportTargetTypeLabel(type: ReportTargetType): string {
  return TARGET_TYPE_LABELS[type];
}

const ITEM_STATE_LABELS: Readonly<Record<ModerationItemState, string>> = {
  published: copy.adminModerationStatePublished,
  hidden: copy.adminModerationStateHidden,
  deleted: copy.adminModerationStateDeleted,
  gone: copy.adminModerationStateGone,
};

/** An item's state on the operators' pages: the public's three, and gone from every view. */
export function moderationItemStateLabel(state: ModerationItemState): string {
  return ITEM_STATE_LABELS[state];
}

/** A report reason, and the operator's explanation after it when there is one. */
export function actionReasonText(reason: { code: ReportReason; note: string | null }): {
  reason: string;
  note: string | null;
} {
  const note = reason.note?.trim() ?? '';
  return { reason: reportReasonLabel(reason.code), note: note === '' ? null : note };
}

// ---- the report dialog -------------------------------------------------------------------------

/**
 * The public id of whoever wrote an item, which tells the reader's own apart (`ReportButton`
 * offers nothing there, #45-10); null for a withdrawn member's, never the reader's.
 */
export function authorPublicIdOf(author: PostAuthor): string | null {
  return author.kind === 'member' ? author.publicId : null;
}

/** What the report dialog holds: the reason picked (none yet) and the description typed. */
export interface ReportDraftInput {
  reason: ReportReason | null;
  description: string;
}

/**
 * The dialog's draft as the server will read it: the description normalised the way the server
 * normalises it (`normaliseCommentBody`: line breaks kept, controls dropped, trimmed), its length
 * in code points, and what is wrong with it — no reason, '기타' without a description (#45-10), a
 * description over REPORT_DESCRIPTION_MAX_LENGTH. Nothing is sent while either is set.
 */
export interface ReportDraft {
  reason: ReportReason | null;
  description: string | null;
  length: number;
  reasonError: string | null;
  descriptionError: string | null;
}

export function reportDraft(input: ReportDraftInput): ReportDraft {
  const text = normaliseCommentBody(input.description);
  const length = codePointLength(text);
  const description = text === '' ? null : text;
  let descriptionError: string | null = null;
  if (length > REPORT_DESCRIPTION_MAX_LENGTH) descriptionError = copy.errReportDescriptionTooLong;
  else if (input.reason !== null && reasonNeedsText(input.reason) && description === null) {
    descriptionError = copy.errReportDescriptionRequired;
  }
  return {
    reason: input.reason,
    description,
    length,
    reasonError: input.reason === null ? copy.errReportReasonRequired : null,
    descriptionError,
  };
}

/** The count under the description: '12 / 500자'. */
export function reportLengthText(length: number): string {
  return `${length.toLocaleString('ko-KR')} / ${REPORT_DESCRIPTION_MAX_LENGTH.toLocaleString('ko-KR')}${copy.reportLengthUnit}`;
}

/** The dialog's title by what is reported. */
export function reportDialogTitle(type: ReportTargetType): string {
  switch (type) {
    case 'post':
      return copy.reportPostTitle;
    case 'comment':
      return copy.reportCommentTitle;
    case 'profile':
      return copy.reportProfileTitle;
  }
}

/**
 * What a refused report says, and where:
 * - `field`: the description, under its box — over the limit, or '기타' without one (the server's
 *   VALIDATION_ERROR on `description`);
 * - `alert`: in the dialog, which stays open with what was typed — the reporter's own target, a
 *   pending report of theirs on it (decision 7), the daily limit with the wait (#45-15), the
 *   address bucket, the onboarding (a consent a revision asked for again), the cookie of another
 *   account, a request that never reached the API. `stale` when the target became a placeholder or
 *   left every view meanwhile, so the page reads it again and shows what it is now.
 */
export type ReportFailure =
  { kind: 'field'; message: string } | { kind: 'alert'; message: string; stale: boolean };

const REPORT_REFUSAL_MESSAGES: Readonly<Record<ReportRefusal, string>> = {
  own: copy.errReportOwn,
  duplicate: copy.errReportDuplicate,
  deleted: copy.errReportDeleted,
  hidden: copy.errReportHidden,
};

function goneMessage(type: ReportTargetType): string {
  switch (type) {
    case 'post':
      return copy.errPostGone;
    case 'comment':
      return copy.errCommentGone;
    case 'profile':
      return copy.profileNotFound;
  }
}

export function reportFailure(error: unknown, type: ReportTargetType): ReportFailure {
  const alert = (message: string, stale = false): ReportFailure => ({
    kind: 'alert',
    message,
    stale,
  });
  if (isForAnotherAccount(error)) return alert(copy.sessionChanged);
  if (isApiError(error, 'REPORT_NOT_ALLOWED')) {
    const details = reportNotAllowedDetailsSchema.safeParse(error.details);
    if (!details.success) return alert(copy.errUnknown);
    const { reason } = details.data;
    return alert(REPORT_REFUSAL_MESSAGES[reason], reason === 'deleted' || reason === 'hidden');
  }
  if (isApiError(error, 'REPORT_LIMITED')) {
    const details = reportLimitedDetailsSchema.safeParse(error.details);
    return alert(
      details.success
        ? `${copy.errReportLimited} ${formatWait(details.data.retryAfterSeconds)} ${copy.verificationRetryAfter}`
        : copy.errReportLimited,
    );
  }
  if (isApiError(error, 'RATE_LIMITED')) return alert(copy.errTooManyRequests);
  if (isApiError(error, 'NOT_FOUND')) return alert(goneMessage(type), true);
  if (isApiError(error, 'ONBOARDING_REQUIRED')) return alert(copy.errPostOnboarding);
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'description') {
      return {
        kind: 'field',
        message:
          validationMessage(error) === OTHER_NEEDS_TEXT_MESSAGE
            ? copy.errReportDescriptionRequired
            : copy.errReportDescriptionTooLong,
      };
    }
    if (field === 'reason') return alert(copy.errReportReasonRequired);
    return alert(copy.errPostInvalid);
  }
  return alert(isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown);
}

// ---- the member's 조치·신고 내역 ----------------------------------------------------------------

/** A line naming something, and where it leads (null: nowhere to go). */
export interface NamedLink {
  text: string;
  href: string | null;
}

/**
 * What one of the member's reports was about, as the public sees it now (`ReportTarget`): a post
 * by its title or the first line of its text, a comment by the first line of its text, a profile
 * by its member's nickname — and a placeholder by the words its page shows (#45-5), since the
 * answer carries nothing more of it. A published or hidden one leads to its page (a comment to
 * its post, which shows while the comment does). A deleted one leads nowhere: the answer does not
 * tell a deleted post that keeps its page (comments under it) from one gone from every view — a
 * 404 — nor whether a deleted comment's post is still there, and a link that may end on 'not
 * found' says less than the words alone (ADR-0081 7-16). A withdrawn member's profile leads
 * nowhere (#37-16).
 */
export function reportTargetView(target: ReportTarget): NamedLink {
  switch (target.type) {
    case 'post':
      return {
        text: reportedPostText(target.post),
        href: target.post.state === 'deleted' ? null : postPath(target.post.id),
      };
    case 'comment':
      return {
        text: reportedCommentText(target.comment),
        href: target.comment.state === 'deleted' ? null : postPath(target.postId),
      };
    case 'profile':
      return target.member.kind === 'member'
        ? { text: target.member.nickname, href: profilePath(target.member.publicId) }
        : { text: copy.postAuthorFormer, href: null };
  }
}

function reportedPostText(post: Extract<ReportTarget, { type: 'post' }>['post']): string {
  switch (post.state) {
    case 'published':
      return post.title ?? postFirstLine(post.excerpt);
    case 'deleted':
      return copy.postDeletedPlaceholder;
    case 'hidden':
      return copy.postHiddenPlaceholder;
  }
}

function reportedCommentText(
  comment: Extract<ReportTarget, { type: 'comment' }>['comment'],
): string {
  switch (comment.state) {
    case 'published':
      return postFirstLine(comment.excerpt);
    case 'deleted':
      return copy.commentDeletedPlaceholder;
    case 'hidden':
      return copy.commentHiddenPlaceholder;
  }
}

/**
 * What an action taken on the member was about (`MyActionSubject`): their post by its title or
 * the first line of its text, their comment by its first line — or, once they deleted it, that it
 * was a post or a comment they deleted (MY shows nothing of a deleted item, #45-5) — or their
 * profile. Null for a warning about nothing in particular.
 */
export function actionSubjectView(subject: MyActionSubject | null): NamedLink | null {
  if (subject === null) return null;
  switch (subject.type) {
    case 'post': {
      const text =
        subject.title ?? (subject.excerpt === null ? null : postFirstLine(subject.excerpt));
      return text === null
        ? { text: copy.moderationSubjectDeletedPost, href: null }
        : { text, href: postPath(subject.id) };
    }
    case 'comment':
      return subject.excerpt === null
        ? { text: copy.moderationSubjectDeletedComment, href: null }
        : { text: postFirstLine(subject.excerpt), href: postPath(subject.postId) };
    case 'profile':
      return { text: copy.moderationSubjectProfile, href: null };
  }
}

/**
 * The last instant the member may appeal the action (`appealDeadlineOf`, #45-14: «조치 뒤 14일
 * 안»), or null for one an operator cancelled since — there is nothing left to appeal.
 */
export function appealDeadline(action: Pick<MyModerationAction, 'createdAt' | 'cancelledAt'>) {
  return action.cancelledAt === null ? appealDeadlineOf(action.createdAt).toISOString() : null;
}

/**
 * The sanction in force the banner speaks of (ADR-0069 decision 4 #50: «진행 중인 제재가 있으면
 * MY 요약·글쓰기 화면의 안내 띠»), or null: an action not cancelled whose end (`endsAt`) is still
 * ahead of `now` — the latest-ending of them. A sanction is a restriction (#45-12: «제재(작성
 * 제한·계정 제한)»), which #185 and #139 add with their end; none of #50's actions is one — a
 * warning is a record and the member's notice only (#45-11), and a hiding or a profile item has no
 * end — so with #50 alone this is always null. A restriction without an end (#139's 무기한) is
 * that issue's to add here.
 */
export function sanctionInForce<A extends Pick<MyModerationAction, 'endsAt' | 'cancelledAt'>>(
  actions: readonly A[],
  // Read in render through this default, as `refundAction`'s is (admin-payments.tsx): the
  // member's actions are never read on the server, so there is no hydration to mismatch.
  now: number = Date.now(),
): A | null {
  let found: A | null = null;
  for (const action of actions) {
    if (action.cancelledAt !== null || action.endsAt === null) continue;
    const end = Date.parse(action.endsAt);
    if (!(end > now)) continue;
    if (found === null || end > Date.parse(found.endsAt ?? '')) found = action;
  }
  return found;
}

/** Every row of the pages held, in order. */
export function moderationRows<Row>(
  pages: readonly { items: readonly Row[] }[] | undefined,
): Row[] {
  return (pages ?? []).flatMap((page) => page.items);
}

// ---- operators ---------------------------------------------------------------------------------

/**
 * Whether what a page is about concerns the signed-in operator — their post, comment or profile:
 * its reports and actions are another operator's (decision 4 #50 «다른 운영자만»). Unknown
 * (undefined) while the session is; the screen offers nothing until it knows. The server refuses
 * it whatever the screen thinks (`own`).
 */
export function concernsOperator(
  userId: string,
  operatorId: string | undefined,
): boolean | undefined {
  return operatorId === undefined ? undefined : userId === operatorId;
}

/** The pending reports among `reports`: what the page offers 신고 기각 for. */
export function pendingReportIds(reports: readonly AdminReport[]): string[] {
  return reports.filter((report) => report.status === 'pending').map((report) => report.id);
}

/**
 * What one dismissal takes of the reports a page shows: the pending ones, oldest first, at most
 * DISMISS_REPORTS_MAX — the most one request names (`dismissReportsBodySchema`) — and how many are
 * pending in all. A target with more (a brigade of reporters) is dismissed in turns: the rest stay
 * pending, and the page, read again after the dismissal, offers 신고 기각 for them. Never the ones
 * the page does not show: a report that arrived since stays pending (ADR-0081 7-7).
 */
export function dismissBatch(reports: readonly AdminReport[]): {
  reports: AdminReport[];
  pendingCount: number;
} {
  const pending = reports
    .filter((report) => report.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { reports: pending.slice(0, DISMISS_REPORTS_MAX), pendingCount: pending.length };
}

/**
 * The dismissal dialog's line when it takes only part of the pending reports, with how many wait
 * in all ('대기 101건'); null otherwise.
 */
export function dismissBatchText(batch: {
  reports: readonly unknown[];
  pendingCount: number;
}): string | null {
  if (batch.reports.length >= batch.pendingCount) return null;
  const waiting = countText(
    copy.adminReportPendingCount,
    batch.pendingCount,
    copy.adminCountUnitReports,
  );
  return `${copy.adminModerationDismissPartial} (${waiting})`;
}

/** '신고 3건' · '신고자 2명' · '대기 1건': a count with its unit, never a score (N04 §4). */
export function countText(label: string, count: number, unit: string): string {
  return `${label} ${String(count)}${unit}`;
}

/** A queue entry's reasons with their counts: '스팸 2 · 기타 1', in the owner's order. */
export function reasonCountsText(reasons: AdminReportGroup['reasons']): string {
  return REPORT_REASONS.flatMap((code) => {
    const found = reasons.find((entry) => entry.reason === code);
    return found === undefined ? [] : [`${reportReasonLabel(code)} ${String(found.count)}`];
  }).join(' · ');
}

/** A queue entry's line: a post by its title (or its text's start), a comment by its start. */
export function queueEntryText(group: Pick<AdminReportGroup, 'title' | 'excerpt'>): string {
  return group.title ?? postFirstLine(group.excerpt);
}

/** What a profile action took away, as the operators' pages name it (kept, never restored). */
export function removedItemLabel(removed: RemovedProfileItem): string {
  switch (removed.item) {
    case 'nickname':
      return copy.adminModerationRemovedNickname;
    case 'bio':
      return copy.adminModerationRemovedBio;
    case 'image':
      return copy.adminModerationRemovedImage;
  }
}

/** Whether an action still stands and so can be cancelled. */
export function isCancellable(action: Pick<AdminModerationAction, 'cancelledAt'>): boolean {
  return action.cancelledAt === null;
}

/**
 * The operator's draft of an action's reason (owner decision 2026-10-22, ADR-0080: «사유 목록 중
 * 하나 + 운영자 설명»): the report reason picked and the explanation the member reads — optional,
 * and required with '기타' as a report's description is — normalised the server's way.
 */
export interface ActionReasonDraft {
  reason: ReportReason | null;
  note: string | null;
  reasonError: string | null;
  noteError: string | null;
}

export function actionReasonDraft(input: { reason: ReportReason | null; note: string }) {
  const text = normaliseCommentBody(input.note);
  const note = text === '' ? null : text;
  let noteError: string | null = null;
  if (codePointLength(text) > MODERATION_NOTE_MAX_LENGTH) noteError = copy.errModerationNoteTooLong;
  else if (input.reason !== null && reasonNeedsText(input.reason) && note === null) {
    noteError = copy.errModerationNoteRequired;
  }
  return {
    reason: input.reason,
    note,
    reasonError: input.reason === null ? copy.errModerationReasonRequired : null,
    noteError,
  } satisfies ActionReasonDraft;
}

/**
 * The operators' own reason for a cancellation or a dismissal (required, at most
 * MODERATION_REASON_MAX_LENGTH, never shown to the member): the text to send, or the error.
 */
export function recordReasonDraft(text: string): { reason: string; error: string | null } {
  const reason = normaliseCommentBody(text);
  const length = codePointLength(reason);
  return {
    reason,
    error:
      length === 0 || length > MODERATION_REASON_MAX_LENGTH
        ? copy.errModerationRecordRequired
        : null,
  };
}

/** Parses a `<select>`'s value into a reason, or null for the empty option. */
export function reportReasonOf(value: string): ReportReason | null {
  return REPORT_REASONS.find((code) => code === value) ?? null;
}

const MODERATION_REFUSAL_MESSAGES: Readonly<Record<ModerationRefusal, string>> = {
  own: copy.errModerationOwn,
  hidden: copy.errModerationHidden,
  deleted: copy.errModerationDeleted,
  nothing_to_remove: copy.errModerationNothingToRemove,
  cancelled: copy.errModerationCancelled,
  resolved: copy.errModerationResolved,
  not_theirs: copy.errModerationNotTheirs,
};

/**
 * What a refused operator action says: under the field it is about (the explanation, the record's
 * reason), or in the dialog — MODERATION_NOT_ALLOWED by its reason (the page is out of date for
 * all but `own`, and the hook reads it again either way), the target gone, the cookie of another
 * account, a session that ended or an account no longer an admin (sending again cannot help, as
 * the admin role dialogs say, `adminRoleChangeRefusal`), more reports named than one dismissal
 * takes, a request that never reached the API.
 */
export type ModerationFailure =
  { kind: 'field'; field: 'note' | 'reason'; message: string } | { kind: 'alert'; message: string };

export function moderationFailure(error: unknown): ModerationFailure {
  const alert = (message: string): ModerationFailure => ({ kind: 'alert', message });
  if (isForAnotherAccount(error)) return alert(copy.sessionChanged);
  if (isApiError(error, 'UNAUTHENTICATED')) return alert(copy.errUnauthenticated);
  // Not the account check above: AdminGuard's, once another admin revoked this one's role.
  if (isApiError(error, 'FORBIDDEN')) return alert(copy.adminOnly);
  if (isApiError(error, 'MODERATION_NOT_ALLOWED')) {
    const details = moderationNotAllowedDetailsSchema.safeParse(error.details);
    return alert(
      details.success ? MODERATION_REFUSAL_MESSAGES[details.data.reason] : copy.errUnknown,
    );
  }
  if (isApiError(error, 'NOT_FOUND')) return alert(copy.adminModerationNotFound);
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'note') {
      return {
        kind: 'field',
        field: 'note',
        message:
          validationMessage(error) === OTHER_NEEDS_TEXT_MESSAGE
            ? copy.errModerationNoteRequired
            : copy.errModerationNoteTooLong,
      };
    }
    if (field === 'reason') {
      return { kind: 'field', field: 'reason', message: copy.errModerationRecordRequired };
    }
    if (field === 'reportIds') return alert(copy.errModerationReportIds);
    return alert(copy.errPostInvalid);
  }
  return alert(isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown);
}
