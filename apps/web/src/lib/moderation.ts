import {
  ACCOUNT_RESTRICTION_DAYS,
  ACCOUNT_RESTRICTION_REASONS,
  APPROVAL_REASON_MAX_LENGTH,
  APPROVAL_REFUSALS,
  DISMISS_REPORTS_MAX,
  MODERATION_NOTE_MAX_LENGTH,
  MODERATION_REASON_MAX_LENGTH,
  OTHER_NEEDS_TEXT_MESSAGE,
  REPORT_DESCRIPTION_MAX_LENGTH,
  REPORT_REASONS,
  WRITING_RESTRICTION_DAYS,
  appealDeadlineOf,
  appealWindowEndOf,
  codePointLength,
  isNoEmailAddress,
  moderationNotAllowedDetailsSchema,
  nicknameHoldEndOf,
  normaliseCommentBody,
  postExcerpt,
  readPostDocument,
  reasonNeedsText,
  reportLimitedDetailsSchema,
  reportNotAllowedDetailsSchema,
  type AccountRestrictionChange,
  type AccountRestrictionDays,
  type AccountRestrictionMoot,
  type AccountRestrictionReason,
  type AccountRestrictionRequestQueue,
  type AdminReportQueue,
  type ApprovalRefusal,
  type ApprovalStatus,
  type ModerationReason,
  type ModerationRefusal,
  type ReportReason,
  type ReportRefusal,
  type ReportTargetType,
  type RestrictionEndChangeKind,
  type WritingRestrictionDays,
} from '@buddha/shared';
import { copy } from '@/copy';
import { fillBusinessInfo } from '@/legal/business-info';
import {
  type AccountRestrictionRequest,
  type AdminModerationAction,
  type AdminReport,
  type AdminReportGroup,
  type Me,
  type ModerationActionType,
  type ModerationItemState,
  type ModerationTarget,
  type MyActionSubject,
  type MyModerationAction,
  type PostAuthor,
  type PublishedPost,
  type RemovedProfileItem,
  type ReportStatus,
  type ReportTarget,
  type RestrictionEndChange,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { nicknameShown } from './account-closure';
import { hiddenItemName, reportReasonLabel } from './authored';
import { formatKst, kstLocalToIso } from './datetime';
import { formatWait } from './phone-verification';
import { postFirstLine, postPath } from './posts';
import { profilePath } from './profile';

/**
 * 신고와 운영 처리 (#50, ADR-0081) as the screens draw them: the report dialog's rules and
 * refusals, the member's 조치·신고 내역 (`/my/moderation`) with its appeal guidance and each action's
 * '이의 기한' (#186, ADR-0084), the sanction and warning banners, and the operators' queue, pages
 * and dialogs. Pure functions of the API's answers and of what was typed, apart from the
 * components and the hooks so the node test runner reaches them (the rule lib/likes.ts follows).
 *
 * Owner decisions (ADR-0069 decision 2 #45-10…#45-15, decision 3 #37-10, decision 4 #50 rows,
 * decision 7): a 근거 글, a 댓글 or 대댓글 and a member's profile take reports, one reason each and a
 * description with '기타'; never one's own; again only once one's earlier report on it was
 * processed; at most 20 a day. Nothing is hidden by a report. An operator chooses by the weight of
 * the violation (숨김·기각·경고, and for a profile the three items), acts without a report too,
 * cancels with a reason, and never processes what concerns themselves. The member acted on reads
 * the type, the reason, the end (if any) and how to appeal; the reporter reads 접수 and then
 * 조치함 or 기각. Neither reads who reported or which operator acted.
 *
 * 작성 제한 (#185, ADR-0082; ADR-0069 decision 2 #45-12, #45-14, decision 4 #185 rows) joins them:
 * an operator restricts a member's writing for 1, 3, 7 or 30 days or 무기한, from an item's page
 * (its pending reports resolved) or the member's, and lifts it early or brings its end forward
 * (감경), each with a reason. The member reads it on the banner and in 조치·신고 내역 with its end,
 * and every refused write says it (lib/restriction.ts).
 *
 * 계정 제한 (#139, ADR-0085; ADR-0069 decision 1 #57-12…#57-15, decision 4 #50 and #139 rows;
 * ADR-0056 decision 1-7) joins them as a request: an operator asks for a member's account to be
 * restricted — one of the owner's eight reasons with a required explanation, 1, 3, 7 or 30 days or
 * 무기한, from an item's page or the member's — and for its 감경, early lift or cancellation, and
 * nothing is done until an admin who neither asked nor is the member approves; another rejects
 * what is not wanted, or the one who asked retracts it first (owner decision 2026-10-23), with an
 * optional memo for the operators alone. The member reads it as a writing restriction: on
 * the banner of MY 요약 and MY 설정, in 조치·신고 내역 and in the refusal of a public profile item's
 * new value.
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

/**
 * #187's review list of repeated links (ADR-0083), the area's third page: the posts and comments
 * a repetition rule caught, which an operator marks '확인함' — any action on them is this area's
 * (the item's moderation page, `adminTargetPath`).
 */
export const ADMIN_LINK_FLAGS_PATH = '/admin/moderation/link-flags';

/**
 * 계정 제한 요청 (#139): the account restriction requests, the ones waiting for a decision first;
 * `?status=decided` and `?status=retracted` are its other two parts.
 */
export const ADMIN_ACCOUNT_REQUESTS_PATH = '/admin/moderation/account-restriction-requests';

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

/** The requests' part a `?status=` names: `decided`, `retracted`, `pending` for anything else. */
export function adminAccountRequestQueueOf(
  param: string | string[] | null | undefined,
): AccountRestrictionRequestQueue {
  return param === 'decided' || param === 'retracted' ? param : 'pending';
}

export function adminAccountRequestQueuePath(queue: AccountRestrictionRequestQueue): string {
  return queue === 'pending'
    ? ADMIN_ACCOUNT_REQUESTS_PATH
    : `${ADMIN_ACCOUNT_REQUESTS_PATH}?${ADMIN_REPORT_QUEUE_PARAM}=${queue}`;
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

/** The element id of an action's row on its member's page (`ActionRows`), a link's fragment. */
export function adminActionAnchor(actionId: string): string {
  return `moderation-action-${actionId.toLowerCase()}`;
}

/**
 * An action's row on its member's page: where a change request's restriction is read in full
 * (#139, ADR-0085 7-12), from the request's line on 계정 제한 요청 or on that page itself.
 */
export function adminActionPath(userId: string, actionId: string): string {
  return `${adminUserModerationPath(userId)}#${adminActionAnchor(actionId)}`;
}

/**
 * A member's moderation page found by the public id of their profile's address — where a public
 * profile's '운영' link goes (owner decision 2026-10-21): the public screens name no account id.
 */
export function adminProfileModerationPath(publicId: string): string {
  return `/admin/moderation/profiles/${encodeURIComponent(publicId.toLowerCase())}`;
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
 * `/me/moderation/actions`), and the restriction that governs them now (`GET
 * /me/moderation/restriction`, #185 — the banner's): read with their cookie, so the root is in
 * `PRIVATE_QUERY_ROOTS` (market-keys.ts) — never fetched on the server, never dehydrated, reset
 * with every other personal entry when the session changes. No key under it says whose it is.
 */
export const MY_MODERATION_KEY = ['my-moderation'] as const;
export const MY_REPORTS_KEY = [...MY_MODERATION_KEY, 'reports'] as const;
export const MY_ACTIONS_KEY = [...MY_MODERATION_KEY, 'actions'] as const;
export const MY_RESTRICTION_KEY = [...MY_MODERATION_KEY, 'restriction'] as const;

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
export const adminProfileModerationKey = (publicId: string) =>
  [...ADMIN_MODERATION_KEY, 'profile', publicId.toLowerCase()] as const;
export const adminAccountRequestQueueKey = (queue: AccountRestrictionRequestQueue) =>
  [...ADMIN_MODERATION_KEY, 'account-restriction-requests', queue] as const;

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
  writing_restriction: copy.moderationActionWritingRestriction,
  account_restriction: copy.moderationActionAccountRestriction,
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
export function actionReasonText(reason: { code: ModerationReason; note: string | null }): {
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
 * What a report is about, as the report dialog and a card's 신고 name it: a post's title and the
 * start of its text (`postExcerpt` — a card's `excerpt`, or the post page's own text cut the same
 * way, so both name a post alike), a 댓글's or 대댓글's own text, a profile's member by the nickname
 * the profile shows now (owner decision 2026-10-22 (2차) 4).
 */
export type ReportItem =
  | { type: 'post'; title: string | null; excerpt: string }
  | { type: 'comment'; body: string }
  | { type: 'profile'; nickname: string };

/**
 * The post page's item for its report dialog: the post's title and the start of its text cut as
 * its card's preview is (`postExcerpt`, what the API sends a card as `excerpt`), so the post page
 * and the card name one post alike (owner decision 2026-10-22 답 4, `reportItemName`) — its whole
 * text would keep the line break after a long first line and lose the cut's '…'.
 */
export function postReportItem(post: Pick<PublishedPost, 'title' | 'body'>): ReportItem {
  return {
    type: 'post',
    title: post.title,
    excerpt: postExcerpt(readPostDocument(post.body).text),
  };
}

/**
 * What is reported, on one line (owner decision 2026-10-22 답 4: «카드·글 화면·댓글에서 연 신고 창 →
 * 그 글·댓글의 제목이나 첫 줄을 한 줄로 보임»; (2차) 4: the profile's dialog shows the member's current
 * nickname on one line, as the post's and the comment's): a profile by the nickname it shows (at
 * most NICKNAME_MAX_LENGTH, 20 — never cut), a post or a comment as MY's dialog for a hidden item
 * names it — one rule, `hiddenItemName` (lib/authored.ts, ADR-0080, owner decisions 2026-10-22 3rd
 * and 4th; merged at the restack, ADR-0081 결과 5): a post by its title, or the first line of its
 * text when it has none — as its card's heading and the post page's name it — and a 댓글 or 대댓글
 * by the first line of its own text, its post's would name every comment under one post alike; a
 * first line is at most POST_EXCERPT_MAX_LENGTH (300) code points, as a card's preview is, and one
 * cut there ends in '…'. The dialog draws it on one line and cuts what does not fit the width with
 * an ellipsis of its own (CSS); a screen reader hears the whole of it.
 */
export function reportItemName(item: ReportItem): string {
  switch (item.type) {
    case 'profile':
      return item.nickname;
    case 'post':
      return hiddenItemName({ tab: 'posts', title: item.title, excerpt: item.excerpt });
    case 'comment':
      return hiddenItemName({ tab: 'comments', body: item.body });
  }
}

/**
 * The accessible name of a card's 신고 (`CardReportButton`): the item it reports, as the dialog it
 * opens names it (`reportItemName`), then the button's own word — as every repeated per-item
 * button here is named (ADR-0080 7-19's `hiddenDeleteName`, market-search.tsx's 삭제,
 * market-picker.tsx's 고르기). A list holds up to twenty cards, each with its 신고, and '신고' alone
 * would read alike for each in a screen reader's list of buttons and give a spoken command nothing
 * to tell them apart. The words on screen stay '신고', which the name ends with.
 */
export function reportButtonName(item: ReportItem): string {
  return `${reportItemName(item)} ${copy.reportAction}`;
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
 * The member's appeal deadline for the action, as the card writes it (`appealDeadlineOf`, #45-14:
 * «조치 뒤 14일 안» — in time to the end of the minute it shows, `appealWindowOpen`), or null for one
 * an operator cancelled since — there is nothing left to appeal.
 */
export function appealDeadline(action: Pick<MyModerationAction, 'createdAt' | 'cancelledAt'>) {
  return action.cancelledAt === null ? appealDeadlineOf(action.createdAt).toISOString() : null;
}

/**
 * Whether the member may still appeal the action at `now` (#45-14: «조치마다 한 번, 조치 뒤 14일
 * 안»): it stands, and the minute its deadline (`appealDeadline`) shows in has not ended — mail the
 * customer centre's mailbox receives up to that minute's last second (…:59) is in time (owner
 * decision 2026-10-23 답 5, `appealWindowEndOf`), so the window closes as that minute ends, not at
 * the exact instant inside it. The one place the window is judged on the web; nothing on the
 * server reads it, as an appeal goes to the customer centre's email and the app takes none (#186,
 * ADR-0084). The operator judges an appeal by when the customer centre's mailbox received it
 * (owner decision 2026-10-22 답 10, docs/OPERATIONS.md) against the same minute. Whether one was
 * sent already the app cannot know, so «한 번» is the notice's to say and the operator's to check.
 */
export function appealWindowOpen(
  action: Pick<MyModerationAction, 'createdAt' | 'cancelledAt'>,
  // Read in render through this default, as `warningInWindow`'s is: never on the server.
  now: number = Date.now(),
): boolean {
  return action.cancelledAt === null && appealWindowEndOf(action.createdAt).getTime() > now;
}

/**
 * The '이의 기한' line of an action's card on 조치·신고 내역 (#186, ADR-0084), or null when the card
 * has none: an action an operator cancelled since has nothing left to appeal (ADR-0081 7-17). For
 * one that stands, its deadline (`appealDeadline`: APPEAL_WINDOW_DAYS from it, the exact instant —
 * owner decision 2026-10-22 답 1 — which the card writes to the minute) and whether it has passed
 * at `now` (`!appealWindowOpen` — once the minute it shows has ended, owner decision 2026-10-23
 * 답 5). A passed one keeps its line, as '이의 기한이 지났습니다.' and that deadline only (답 2); the
 * card says nothing else of the appeal — the sentence is once above the list (답 4).
 */
export function appealDeadlineView(
  action: Pick<MyModerationAction, 'createdAt' | 'cancelledAt'>,
  // Read in render through this default, as `nicknameHoldShown`'s is: the member's actions are
  // read in the browser alone, so there is no server render to disagree with it.
  now: number = Date.now(),
): { deadline: string; passed: boolean } | null {
  const deadline = appealDeadline(action);
  if (deadline === null) return null;
  return { deadline, passed: !appealWindowOpen(action, now) };
}

/**
 * The appeal guidance with the customer centre's email filled in from the business info (ADR-0069
 * 결과 3: the owner supplies it; until then it reads 미정, as every undecided business fact does,
 * ADR-0044): where appeals go, what to write and from which address (owner decision 2026-10-22
 * 답 6), once per action within the window, the action standing while it is reviewed, and the
 * answer by email (#45-14). Once above 조치·신고 내역's list of actions (답 4) — the banners carry
 * none (답 3) — and each action's own deadline is its card's line (`appealDeadlineView`).
 */
export function appealGuidanceText(): string {
  return fillBusinessInfo(copy.appealGuidance);
}

/**
 * Whether 조치·신고 내역 adds, under the guidance, that an appeal needs an email registered in MY
 * 설정 first (`copy.appealEmailRequired`, owner decision 2026-10-22 (2차) 3): only for an account
 * whose email is the placeholder a Kakao or Naver sign-in without one stores
 * (`…@noemail.buddha.local`, `isNoEmailAddress`) — operators take appeals from the account's
 * current email alone (답 5), and nothing can be sent from that one. Read from `GET /me`'s email
 * (`me`); while it is read, or when it could not be, nothing is known and nothing is added.
 */
export function appealEmailRequired(me: Pick<Me, 'email'> | undefined): boolean {
  return me !== undefined && isNoEmailAddress(me.email);
}

/**
 * The types that restrict the member until they end (#45-12: «제재(작성 제한·계정 제한)»): the
 * writing restriction (#185, ADR-0082) and the account restriction (#139, ADR-0085). Both read
 * alike to the member — the end, '진행 중', '조기 해제됨'·'감경됨' and the end it was given, '취소됨'.
 * #50's actions restrict nothing — a warning is a record and the member's notice only (#45-11),
 * and a hiding or a profile item has no end.
 */
const RESTRICTION_TYPES: ReadonlySet<ModerationActionType> = new Set<ModerationActionType>([
  'writing_restriction',
  'account_restriction',
]);

/** Whether an action of `type` restricts the member until it ends. */
export function isRestriction(type: ModerationActionType): boolean {
  return RESTRICTION_TYPES.has(type);
}

/**
 * Whether an action is an account restriction (#139): its 감경, early lift and cancellation are
 * requests another admin approves (ADR-0056 decision 1-7), never done at once — the server refuses
 * the writing restriction's routes for it (`approval_required`).
 */
export function isAccountRestriction(type: ModerationActionType): boolean {
  return type === 'account_restriction';
}

/**
 * Whether a restriction stands at `now`, as the server counts it (`writingRestrictionOf`): one of
 * the restriction types, not cancelled — a cancellation ends it at once — and with no end (무기한,
 * until an operator lifts it) or an end still ahead. An early lift sets its end to the lift's time
 * and a 감경 to an earlier one (#185): `endsAt` is the end as it stands now.
 */
export function restrictionStanding(
  action: Pick<MyModerationAction, 'type' | 'endsAt' | 'cancelledAt'>,
  // Read in render through this default, as `warningInWindow`'s is: never on the server.
  now: number = Date.now(),
): boolean {
  if (!isRestriction(action.type) || action.cancelledAt !== null) return false;
  return action.endsAt === null || Date.parse(action.endsAt) > now;
}

/**
 * How the member's 조치·신고 내역 tells a writing restriction an operator brought forward (#185,
 * owner decision 2026-10-23 answer 4: «조기 해제·감경 → 회원의 조치·신고 내역에 '조기 해제됨'·'감경됨'과
 * 바뀐 끝, 원래 끝을 보임(사유는 운영자만)»): '조기 해제됨' or '감경됨' — the latest change's kind (a
 * lift ends it, so one shortened and lifted after reads '조기 해제됨') — and the end it was given
 * (`originalEndsAt`, null for 무기한), said under the changed end ('끝나는 때', the action's
 * `endsAt`). Null when its end never changed, for another type, and for a cancelled one: that says
 * '취소됨' and when alone (owner decision 2026-10-23 answer 10). The API sends neither the reason
 * nor the operator (ADR-0082 7-8).
 */
export function myEndChangeView(
  action: Pick<MyModerationAction, 'type' | 'endChange' | 'cancelledAt'>,
): { label: string; originalEndsAt: string | null } | null {
  const change = action.endChange;
  if (!isRestriction(action.type) || action.cancelledAt !== null || change === null) return null;
  return {
    label: change.kind === 'lift' ? copy.moderationEndLifted : copy.moderationEndShortened,
    originalEndsAt: change.originalEndsAt,
  };
}

/**
 * The warning the MY summary's banner speaks of (owner decision 2026-10-21: «경고 → 이의 기한 14일
 * 동안 MY 요약에만 안내 띠»), or null: the newest warning whose appeal window — APPEAL_WINDOW_DAYS
 * from it, `appealWindowOpen` — is still open at `now`. A cancelled one is nothing to tell any
 * more. Only the summary shows it: a warning restricts nothing (#45-11), so the write page's banner
 * stays for restrictions (`SanctionBanner`, which reads the member's restriction on its own —
 * lib/restriction.ts `restrictionShown`).
 */
export function warningInWindow<
  A extends Pick<MyModerationAction, 'type' | 'createdAt' | 'cancelledAt'>,
>(
  actions: readonly A[],
  // Read in render through this default, as `refundAction`'s is (admin-payments.tsx): the
  // member's actions are never read on the server, so there is no hydration to mismatch.
  now: number = Date.now(),
): A | null {
  let found: A | null = null;
  for (const action of actions) {
    if (action.type !== 'warning' || !appealWindowOpen(action, now)) continue;
    if (found === null || Date.parse(action.createdAt) > Date.parse(found.createdAt)) {
      found = action;
    }
  }
  return found;
}

/**
 * Whether the member's 조치·신고 내역 says, on a nickname reset, that the nickname taken away cannot
 * be used again for 30 days (owner decision 2026-10-22 답 3: «조치·신고 내역의 닉네임 초기화에
 * '이전 닉네임은 30일 동안 다시 쓸 수 없습니다.' 덧붙임(취소된 것에는 빼고)»): a reset not cancelled —
 * a cancellation hands the hold to the member (답 2), who may pick the nickname again — whose hold
 * has not ended at `now` (`nicknameHoldEndOf`: 30 days from the reset, the hold's own start). The
 * line never names the nickname: MY shows no former nickname (#37-3).
 */
export function nicknameHoldShown(
  action: Pick<MyModerationAction, 'type' | 'createdAt' | 'cancelledAt'>,
  // Read in render through this default, as `warningInWindow`'s is: never on the server.
  now: number = Date.now(),
): boolean {
  return (
    action.type === 'nickname_reset' &&
    action.cancelledAt === null &&
    nicknameHoldEndOf(action.createdAt).getTime() > now
  );
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

/**
 * Who did something and when, as an operator's page says it: '닉네임 · 시각' — the time alone on a
 * record about the admin reading it (`aboutViewer`), whose operators are withheld from them (owner
 * decision 2026-10-21), and '삭제된 계정' for an operator's account that is gone.
 */
export function operatorLineText(
  actor: { nickname: string | null } | null,
  at: string,
  aboutViewer: boolean,
): string {
  if (aboutViewer) return formatKst(at);
  // An operator who closed the account since (#140, after the role was revoked) has no nickname.
  const name = actor === null ? copy.adminAccountsTargetGone : nicknameShown(actor.nickname);
  return `${name} · ${formatKst(at)}`;
}

/**
 * A decided request's line (#139, ADR-0085): who decided it and when — the time alone on one
 * about the admin reading it (`aboutViewer`) — or, for one the member's closure closed (#140,
 * owner decision 2026-10-23 via ADR-0085 결과 5: «탈퇴 때 그 요청은 저절로 닫음(거절로 기록, 까닭
 * '탈퇴')»), that it closed with the closure and when: no admin decided it, so no admin is named
 * (`decidedBy` is null) and the line never reads as an account that is gone. Null while it is
 * undecided.
 */
export function requestDecisionLine(
  request: Pick<AccountRestrictionRequest, 'decidedBy' | 'decidedAt' | 'closedByAccountClosure'>,
  aboutViewer: boolean,
): { label: string; text: string } | null {
  if (request.decidedAt === null) return null;
  if (request.closedByAccountClosure) {
    return {
      label: copy.adminAccountRequestDecidedAt,
      text: `${copy.adminAccountRequestClosedByClosure} · ${formatKst(request.decidedAt)}`,
    };
  }
  return {
    label: aboutViewer ? copy.adminAccountRequestDecidedAt : copy.adminAccountRequestDecidedBy,
    text: operatorLineText(request.decidedBy, request.decidedAt, aboutViewer),
  };
}

/**
 * Whether the reader is an operator, by the role `GET /me` answers: the public screens' '운영'
 * links show to them alone (owner decision 2026-10-21). Unknown (undefined) is no.
 */
export function isOperator(role: string | undefined): boolean {
  return role === 'admin';
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

/**
 * A queue entry's line: a post by its title (or its text's start), a comment by its start. A post
 * with no title and no text — one of images alone, or a deleted original #184's retention emptied —
 * is '제목 없음', as its moderation page heads it; a comment with no text is one the retention
 * emptied (a comment's text is never blank otherwise — `post_comments_body_check`).
 */
export function queueEntryText(
  group: Pick<AdminReportGroup, 'target' | 'title' | 'excerpt'>,
): string {
  if (group.title !== null) return group.title;
  // The profile of a member who closed the account (#140) has no nickname to show.
  if (group.excerpt === null) return copy.postAuthorFormer;
  const line = postFirstLine(group.excerpt);
  if (line !== '') return line;
  return group.target.type === 'comment'
    ? copy.adminModerationPurgedLine
    : copy.adminModerationUntitled;
}

/**
 * A comment's line in a post's moderation page (`AdminPostComment.excerpt`, the start of its text
 * whatever its state): its first line, or — for a deleted original #184's retention emptied, the
 * only comment with no text (`post_comments_body_check`) — that it was emptied, so the row's link
 * to its own page still has a name.
 */
export function adminCommentLine(excerpt: string): string {
  return postFirstLine(excerpt) || copy.adminModerationPurgedLine;
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

/**
 * The label of what a profile action took away once #184's retention deleted it (`removed` null on
 * a profile action — the item is kept for the removed-items period, the action for the moderation
 * records' period, so the action may outlive it): the line still names the item, and says it is
 * gone. Null for the types that take nothing away.
 */
export function purgedRemovalLabel(type: ModerationActionType): string | null {
  switch (type) {
    case 'nickname_reset':
      return copy.adminModerationRemovedNickname;
    case 'bio_clear':
      return copy.adminModerationRemovedBio;
    case 'image_remove':
      return copy.adminModerationRemovedImage;
    default:
      return null;
  }
}

/** Whether an action still stands and so can be cancelled. */
export function isCancellable(action: Pick<AdminModerationAction, 'cancelledAt'>): boolean {
  return action.cancelledAt === null;
}

/**
 * What the cancellation's dialog says it does, by the action's type: a hiding's item shows again
 * and a profile item is not restored (#37-10) — and for a nickname reset whose hold still runs at
 * `now`, that the nickname is not restored and the nickname taken away becomes the member's alone
 * to pick again, every other member still held for the rest of the 30 days (owner decision
 * 2026-10-22 답 2: «그 보류가 본인의 것이 됨 …, 취소 창에 그렇게 적음. 닉네임을 저절로 되살리지는
 * 않음» — its three sentences approved as built, (2차) 2). Past the hold (`nicknameHoldEndOf`: 30
 * days from the reset, as `nicknameHoldShown` counts them) the cancellation hands nothing — the
 * nickname is anybody's, maybe another's already — and it says so (owner decision 2026-10-22
 * (2차) 3: «닉네임은 되살리지 않습니다. 이전 닉네임의 30일 보류는 끝났습니다.»).
 */
export function cancelDialogBody(
  action: Pick<AdminModerationAction, 'type' | 'createdAt' | 'endsAt' | 'cancelledAt'>,
  // Read when the dialog opens (a click), never on the server.
  now: number = Date.now(),
): string {
  // A writing restriction's cancellation voids it and ends it at once; an early lift keeps it and
  // ends it now (#185, ADR-0082 결정 7) — the dialog says which this is. One that has ended
  // already (its term passed, or lifted) can still be cancelled — an appeal accepted within its
  // 14 days (#45-14) — and then there is nothing to end, and no 조기 해제 on its row to point at.
  // An account restriction's cancellation is a request (#139): the same two cases, once approved
  // — one ended already needs the approval too (ADR-0085 7-4).
  if (isAccountRestriction(action.type)) {
    return restrictionStanding(action, now)
      ? copy.adminModerationAccountCancelBody
      : copy.adminModerationAccountCancelEndedBody;
  }
  if (isRestriction(action.type)) {
    return restrictionStanding(action, now)
      ? copy.adminModerationCancelRestrictionBody
      : copy.adminModerationCancelRestrictionEndedBody;
  }
  if (action.type !== 'nickname_reset') return copy.adminModerationCancelBody;
  return nicknameHoldEndOf(action.createdAt).getTime() > now
    ? copy.adminModerationCancelNicknameResetBody
    : copy.adminModerationCancelNicknameResetEndedBody;
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
 * MODERATION_REASON_MAX_LENGTH, never shown to the member): the text to send, or the error. A
 * reason an approval request keeps (`approval` — an account restriction's requests and decisions,
 * #139) is also held to APPROVAL_REASON_MAX_LENGTH counted as the request keeps it (`approvals.ts`:
 * UTF-16 units, so an emoji counts two), which the server checks as well.
 */
export function recordReasonDraft(
  text: string,
  approval = false,
): { reason: string; error: string | null } {
  const reason = normaliseCommentBody(text);
  const length = codePointLength(reason);
  const over =
    length > MODERATION_REASON_MAX_LENGTH ||
    (approval && reason.length > APPROVAL_REASON_MAX_LENGTH);
  return { reason, error: length === 0 || over ? copy.errModerationRecordRequired : null };
}

/**
 * The draft of an account restriction request's reason (#139, ADR-0069 decision 1 #57-12: «정한
 * 목록에서 하나 … 와 필수 설명»): one of ACCOUNT_RESTRICTION_REASONS and the explanation the member
 * reads — required whatever the reason, at most MODERATION_NOTE_MAX_LENGTH code points and, as the
 * request's reason too (ADR-0085 7-5), APPROVAL_REASON_MAX_LENGTH UTF-16 units — normalised the
 * server's way.
 */
export function accountRestrictionDraft(input: {
  reason: AccountRestrictionReason | null;
  note: string;
}): {
  reason: AccountRestrictionReason | null;
  note: string;
  reasonError: string | null;
  noteError: string | null;
} {
  const note = normaliseCommentBody(input.note);
  let noteError: string | null = null;
  if (note === '') noteError = copy.errModerationAccountNoteRequired;
  else if (
    codePointLength(note) > MODERATION_NOTE_MAX_LENGTH ||
    note.length > APPROVAL_REASON_MAX_LENGTH
  ) {
    noteError = copy.errModerationNoteTooLong;
  }
  return {
    reason: input.reason,
    note,
    reasonError: input.reason === null ? copy.errModerationReasonRequired : null,
    noteError,
  };
}

/**
 * The operators' memo on an account restriction request (owner decision 2026-10-23, ADR-0085):
 * optional, for the operators and never the member — the text to send (null for none,
 * blank included), or the error past MODERATION_REASON_MAX_LENGTH code points, normalised the
 * server's way.
 */
export function accountRequestMemoDraft(text: string): {
  memo: string | null;
  error: string | null;
} {
  const memo = normaliseCommentBody(text);
  if (codePointLength(memo) > MODERATION_REASON_MAX_LENGTH) {
    return { memo, error: copy.errModerationMemoTooLong };
  }
  return { memo: memo === '' ? null : memo, error: null };
}

// ---- operators: the writing restriction (#185, ADR-0082) -------------------------------------

/** One term of a restriction dialog: the radio's value, the days (null: 무기한) and its name. */
export interface RestrictionTermOption<D extends number> {
  value: string;
  days: D | null;
  label: string;
}

/** The days, 24 hours each from the restriction's own time, then 무기한 (`days: null`). */
function termOptions<D extends number>(days: readonly D[]): RestrictionTermOption<D>[] {
  return [
    ...days.map((day) => ({
      value: String(day),
      days: day,
      label: `${String(day)}${copy.adminModerationTermDayUnit}`,
    })),
    { value: 'none', days: null, label: copy.restrictionIndefinite },
  ];
}

/**
 * The terms an operator picks a writing restriction's from (ADR-0069 decision 2 #45-12: «1·3·7·30일과
 * 무기한에서 고른다»), in that order: the days, 24 hours each from the restriction, or 무기한
 * (`days: null`). The radio's value is the days written out, or 'none'.
 */
export const RESTRICTION_TERM_OPTIONS: readonly RestrictionTermOption<WritingRestrictionDays>[] =
  termOptions(WRITING_RESTRICTION_DAYS);

/**
 * The terms of an account restriction (#139, ADR-0069 decision 1 #57-12 «기간제와 무기한» —
 * ACCOUNT_RESTRICTION_DAYS, the writing restriction's four until the owner names others, ADR-0085
 * 7-2), counted from the approval that puts it in force (7-1).
 */
export const ACCOUNT_RESTRICTION_TERM_OPTIONS: readonly RestrictionTermOption<AccountRestrictionDays>[] =
  termOptions(ACCOUNT_RESTRICTION_DAYS);

/**
 * The term a radio's value names among `options`, or undefined for none picked (the dialog then
 * says so).
 */
export function restrictionTermOf<D extends number>(
  value: string,
  options: readonly RestrictionTermOption<D>[],
): { days: D | null } | undefined {
  const found = options.find((option) => option.value === value);
  return found === undefined ? undefined : { days: found.days };
}

/** The term an account restriction request asks for, as its operators' line says it: '7일', '무기한'. */
export function restrictionTermLabel(days: number | null): string {
  return days === null
    ? copy.restrictionIndefinite
    : `${String(days)}${copy.adminModerationTermDayUnit}`;
}

/** A restriction's end on an operator's page: the time in Korean time (ADR-0061), or '무기한'. */
export function adminRestrictionEndText(endsAt: string | null): string {
  return endsAt === null ? copy.restrictionIndefinite : formatKst(endsAt);
}

/**
 * The restriction a 감경, 조기 해제 or 취소 request changes, as its line says it now — when it was given
 * and its end now, '취소됨' once cancelled: '2026. 10. 23. 오후 3:00 · 끝나는 때 무기한'. A member can
 * have several (ADR-0085 7-3), so the approving admin reads which one, and how far a 감경 brings
 * its end forward.
 */
export function accountRequestTargetText(
  target: Pick<
    NonNullable<AccountRestrictionRequest['target']>,
    'createdAt' | 'endsAt' | 'cancelledAt'
  >,
): string {
  const text = `${formatKst(target.createdAt)} · ${copy.moderationEndsAt} ${adminRestrictionEndText(target.endsAt)}`;
  return target.cancelledAt === null ? text : `${text} · ${copy.moderationCancelled}`;
}

const END_CHANGE_LABELS: Readonly<Record<RestrictionEndChangeKind, string>> = {
  shorten: copy.adminModerationEndChangeShorten,
  lift: copy.adminModerationEndChangeLift,
};

/** '감경' · '조기 해제': how an operator brought a restriction's end forward. */
export function endChangeLabel(kind: RestrictionEndChangeKind): string {
  return END_CHANGE_LABELS[kind];
}

/** One change of an end, as the operators' list says it: '감경 · 무기한 → 2026. 10. 25. 오후 3:00'. */
export function endChangeText(
  change: Pick<RestrictionEndChange, 'kind' | 'previousEndsAt' | 'endsAt'>,
): string {
  return `${endChangeLabel(change.kind)} · ${adminRestrictionEndText(change.previousEndsAt)} → ${formatKst(change.endsAt)}`;
}

/**
 * The 감경 dialog's new end as typed (a `datetime-local` read in Korean time, `kstLocalToIso`, as
 * every admin time input is — ADR-0061 #60-8): the instant to send, or what is wrong with it —
 * nothing or nothing readable, not ahead of `now` (a lift ends it now; the server's `end_passed`),
 * not before the end now (the server's `not_earlier`; any instant is, for 무기한). The server
 * judges again by its own clock.
 */
export function shortenEndDraft(
  local: string,
  currentEndsAt: string | null,
  // Read when the dialog is sent (a click), never on the server.
  now: number = Date.now(),
): { endsAt: string | null; error: string | null } {
  const endsAt = kstLocalToIso(local);
  if (endsAt === null) return { endsAt: null, error: copy.errModerationEndRequired };
  if (!(Date.parse(endsAt) > now)) return { endsAt, error: copy.errModerationEndPassed };
  if (currentEndsAt !== null && !(Date.parse(endsAt) < Date.parse(currentEndsAt))) {
    return { endsAt, error: copy.errModerationNotEarlier };
  }
  return { endsAt, error: null };
}

/** Parses a `<select>`'s value into a reason, or null for the empty option. */
export function reportReasonOf(value: string): ReportReason | null {
  return REPORT_REASONS.find((code) => code === value) ?? null;
}

/**
 * An account restriction's reasons in the owner's order (#139, ADR-0069 decision 1 #57-12: 스팸·
 * 괴롭힘·개인정보 노출·사칭·공모·조작 유도·이상 거래·다계정·기타 — '공모·조작 유도' one reason, as the
 * report reasons have it, ADR-0085 7-9), with their names.
 */
export const ACCOUNT_RESTRICTION_REASON_OPTIONS: readonly {
  code: AccountRestrictionReason;
  label: string;
}[] = ACCOUNT_RESTRICTION_REASONS.map((code) => ({ code, label: reportReasonLabel(code) }));

/** Parses a `<select>`'s value into an account restriction's reason, or null for none. */
export function accountRestrictionReasonOf(value: string): AccountRestrictionReason | null {
  return ACCOUNT_RESTRICTION_REASONS.find((code) => code === value) ?? null;
}

// ---- operators: account restriction requests (#139, ADR-0085) ---------------------------------

const REQUEST_CHANGE_LABELS: Readonly<Record<AccountRestrictionChange, string>> = {
  apply: copy.adminAccountRequestChangeApply,
  shorten: copy.adminAccountRequestChangeShorten,
  lift: copy.adminAccountRequestChangeLift,
  cancel: copy.adminAccountRequestChangeCancel,
};

/** What a request asks for: '계정 제한' · '계정 제한 감경' · '… 조기 해제' · '… 취소'. */
export function accountRequestChangeLabel(change: AccountRestrictionChange): string {
  return REQUEST_CHANGE_LABELS[change];
}

const APPROVAL_STATUS_LABELS: Readonly<Record<ApprovalStatus, string>> = {
  pending: copy.approvalStatusPending,
  approved: copy.approvalStatusApproved,
  rejected: copy.approvalStatusRejected,
  retracted: copy.approvalStatusRetracted,
};

/** 승인 대기 · 승인됨 · 거절됨 · 철회됨. */
export function approvalStatusLabel(status: ApprovalStatus): string {
  return APPROVAL_STATUS_LABELS[status];
}

/**
 * A pending request waits (gray); an approved one acted (orange); a rejected or a retracted one did
 * nothing.
 */
export const APPROVAL_STATUS_PALETTE: Readonly<Record<ApprovalStatus, string>> = {
  pending: 'gray',
  approved: 'orange',
  rejected: 'gray',
  retracted: 'gray',
};

const MOOT_TEXTS: Readonly<Record<AccountRestrictionMoot, string>> = {
  cancelled: copy.adminAccountRequestMootCancelled,
  ended: copy.adminAccountRequestMootEnded,
  not_earlier: copy.adminAccountRequestMootNotEarlier,
  end_passed: copy.adminAccountRequestMootEndPassed,
};

/**
 * Why a pending request can no longer be approved (`moot`, ADR-0085 7-3: the restriction was
 * cancelled, ended or passed the end asked for since the request) and that a rejection closes it;
 * null when it can be.
 */
export function accountRequestMootText(moot: AccountRestrictionMoot | null): string | null {
  return moot === null ? null : MOOT_TEXTS[moot];
}

/**
 * What the reading operator may do with a request (ADR-0056 decision 1-7 and 4; decision 4 #50
 * «다른 운영자만»): `decide` — approve, unless it is moot, or reject; `requester` — they asked, so
 * another admin decides (APPROVAL_NOT_ALLOWED `requester` on the server, in every environment) and
 * they may retract it (owner decision 2026-10-23); `own` — it is about them (`own`), its asking and
 * deciding admins withheld from them; `closed` — decided or retracted, nothing more. Undefined
 * while the session is unknown: the screen offers nothing until it knows.
 */
export type RequestStanding = 'decide' | 'requester' | 'own' | 'closed';

export function requestStanding(
  request: Pick<AccountRestrictionRequest, 'status' | 'user' | 'requestedBy' | 'aboutViewer'>,
  operatorId: string | undefined,
): RequestStanding | undefined {
  if (request.status !== 'pending') return 'closed';
  if (operatorId === undefined) return undefined;
  if (request.aboutViewer || request.user.id === operatorId) return 'own';
  if (request.requestedBy?.id === operatorId) return 'requester';
  return 'decide';
}

/**
 * The notice of a moot request (`accountRequestMootText` — why it can no longer be approved, and
 * that a rejection closes it), for the admin who can reject it (`decide`) alone: the one who asked
 * and the admin it is about can do neither, and their lines say another admin decides it.
 */
export function accountRequestMootNotice(
  request: Pick<AccountRestrictionRequest, 'moot'>,
  standing: RequestStanding | undefined,
): string | null {
  return standing === 'decide' ? accountRequestMootText(request.moot) : null;
}

const APPROVAL_REFUSAL_MESSAGES: Readonly<Record<ApprovalRefusal, string>> = {
  requester: copy.errApprovalRequester,
  decided: copy.errApprovalDecided,
  retracted: copy.errApprovalRetracted,
  not_requester: copy.errApprovalNotRequester,
};

const MODERATION_REFUSAL_MESSAGES: Readonly<Record<ModerationRefusal, string>> = {
  own: copy.errModerationOwn,
  hidden: copy.errModerationHidden,
  deleted: copy.errModerationDeleted,
  nothing_to_remove: copy.errModerationNothingToRemove,
  cancelled: copy.errModerationCancelled,
  resolved: copy.errModerationResolved,
  not_theirs: copy.errModerationNotTheirs,
  not_restriction: copy.errModerationNotRestriction,
  ended: copy.errModerationEnded,
  not_earlier: copy.errModerationNotEarlier,
  end_passed: copy.errModerationEndPassed,
  approval_required: copy.errModerationApprovalRequired,
  not_account_restriction: copy.errModerationNotAccountRestriction,
  no_decider: copy.errModerationNoDecider,
  closed: copy.errModerationClosed,
};

/**
 * What a refused operator action says: under the field it is about (the explanation, the record's
 * reason), or in the dialog — MODERATION_NOT_ALLOWED by its reason (the page is out of date for
 * all but `own`, and the hook reads it again either way), the target gone, the cookie of another
 * account, a session that ended or an account no longer an admin (sending again cannot help, as
 * the admin role dialogs say, `adminRoleChangeRefusal`), more reports named than one dismissal
 * takes, a 감경's end the server could not read or a term it does not take (#185), a request that
 * never reached the API. A 감경 or a lift refused by the restriction's state (`not_restriction`,
 * `ended`, `not_earlier`, `end_passed`) is MODERATION_NOT_ALLOWED's with the rest.
 */
export type ModerationFailure =
  | { kind: 'field'; field: 'note' | 'reason' | 'endsAt' | 'memo'; message: string }
  | { kind: 'alert'; message: string };

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
  // The two-person rule's refusal (#139, ADR-0056 decision 4): the admin who asked decides
  // nothing, a request is decided once, a retracted one by no one, and only the one who asked
  // retracts it — `details[0].message` says which.
  if (isApiError(error, 'APPROVAL_NOT_ALLOWED')) {
    const refusal = APPROVAL_REFUSALS.find((reason) => reason === validationMessage(error));
    return alert(refusal === undefined ? copy.errUnknown : APPROVAL_REFUSAL_MESSAGES[refusal]);
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
    if (field === 'endsAt') {
      return { kind: 'field', field: 'endsAt', message: copy.errModerationEndRequired };
    }
    if (field === 'memo') {
      return { kind: 'field', field: 'memo', message: copy.errModerationMemoTooLong };
    }
    if (field === 'days') return alert(copy.errModerationTermRequired);
    if (field === 'reportIds') return alert(copy.errModerationReportIds);
    return alert(copy.errPostInvalid);
  }
  return alert(isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown);
}
