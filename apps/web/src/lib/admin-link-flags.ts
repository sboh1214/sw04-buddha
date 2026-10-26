import {
  LINK_FLAG_REVIEW_NOTE_MAX_LENGTH,
  type LinkFlagReason,
  type LinkFlagReviewOutcome,
  type LinkFlagTargetKind,
} from '@buddha/shared';
import { copy } from '@/copy';
import {
  type AdminLinkFlag,
  type AdminLinkFlagGroup,
  type AdminLinkFlagReviewBody,
  isApiError,
  isForAnotherAccount,
} from './api';
import { nicknameShown } from './account-closure';
import { formatKst } from './datetime';
import { adminTargetPath } from './moderation';

/*
 * 반복 링크 검토 목록 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187; owner decision
 * 2026-10-22) as the admin screen reads `GET /admin/link-flags` and `GET /admin/link-flags/items`:
 * the groups of one link and rule — how many entries, the latest time, and in the reviewed list
 * the mark '확인함' with what came of it — and a group's entries: each post or comment a rule
 * caught, the link as the rules compared it, the rule, and the item as it is now. Kept out of the
 * component so vitest runs it under node (admin-link-flags.test.ts). Times are Korean time, as on
 * every admin screen (ADR-0061 #60-8).
 */

/** The note an operator may leave with a mark, at most (the server's limit). */
export const LINK_FLAG_NOTE_MAX_LENGTH = LINK_FLAG_REVIEW_NOTE_MAX_LENGTH;

const REASON_LABELS: Readonly<Record<LinkFlagReason, string>> = {
  same_account: copy.adminLinkFlagSameAccount,
  many_accounts: copy.adminLinkFlagManyAccounts,
};

/** Which rule put the item on the list, in a few words: '한 사람이 3번 이상', '3명 이상이 사용'. */
export function linkFlagReasonLabel(reason: LinkFlagReason): string {
  return REASON_LABELS[reason];
}

const KIND_LABELS: Readonly<Record<LinkFlagTargetKind, string>> = {
  post: copy.adminLinkFlagPost,
  comment: copy.adminLinkFlagComment,
};

/** What carries the link: '근거 글', or '댓글' for a 댓글 and a 대댓글 alike. */
export function linkFlagKindLabel(kind: LinkFlagTargetKind): string {
  return KIND_LABELS[kind];
}

/**
 * Where an operator reads the item and acts on it: its moderation page in the 신고·조치 area (#50,
 * ADR-0081) — the post's or the comment's own, with what it says (a deleted or hidden one's
 * original too), its reports and the actions taken on it, and the hiding, the warning and the
 * writing restriction an operator may take. '조치함' records that one was taken there (owner
 * decision 2026-10-22 answer 2, ADR-0083 7-12).
 */
export function linkFlagItemPath(target: AdminLinkFlag['target']): string {
  return target.kind === 'comment' && target.commentId !== null
    ? adminTargetPath({ type: 'comment', commentId: target.commentId, postId: target.postId })
    : adminTargetPath({ type: 'post', postId: target.postId });
}

/**
 * The name of the entry's link to that page: the item as it is now — a post's title or the start
 * of its text, a comment's start (`target.excerpt`). A post or a comment #184's retention emptied
 * (a deleted original, or a withdrawn member's still-hidden one — owner decision 2026-10-24 3) has
 * none, while its entry stays until the 신고·제재 period from its flag or its mark (ADR-0087 7-26);
 * it is named as #50's report queue names it (`queueEntryText`) — a post '제목 없음', a comment
 * '보존기간이 지나 지운 원문' — so the link, the entry's only way to the item, still has a name. A
 * live item's text is never blank (a post must have some, a comment `post_comments_body_check`).
 */
export function linkFlagItemText(target: AdminLinkFlag['target']): string {
  if (target.excerpt !== '') return target.excerpt;
  return target.kind === 'comment' ? copy.adminModerationPurgedLine : copy.adminModerationUntitled;
}

/**
 * A group's key on the screen: its mark in the reviewed list (one row per mark), its link and rule
 * in the default list (one row per both).
 */
export function linkFlagGroupKey(group: AdminLinkFlagGroup): string {
  return group.review === null ? `${group.reason} ${group.url}` : group.review.id;
}

/** How many entries the group holds: '항목 3개'. */
export function linkFlagGroupCount(group: AdminLinkFlagGroup): string {
  return `${copy.adminLinkFlagItems} ${String(group.itemCount)}${copy.adminLinkFlagItemsUnit}`;
}

const OUTCOME_LABELS: Readonly<Record<LinkFlagReviewOutcome, string>> = {
  no_issue: copy.adminLinkFlagNoIssue,
  actioned: copy.adminLinkFlagActioned,
};

/** What came of a group the operator marked: '문제 없음', '조치함' (owner decision 2026-10-22). */
export function linkFlagOutcomeLabel(outcome: LinkFlagReviewOutcome): string {
  return OUTCOME_LABELS[outcome];
}

/**
 * The body of the mark '확인함' on a group of the default list: its link and rule, what came of it,
 * the note when one is written (trimmed; none when blank), `through` — the group's latest time
 * as the screen shows it, so an entry that arrived after the operator looked stays on the list —
 * and the admin on screen (`useOperatorId`, ADR-0092: the server refuses another account's).
 */
export function toLinkFlagReviewBody(
  group: AdminLinkFlagGroup,
  outcome: LinkFlagReviewOutcome,
  note: string,
  operatorId: string,
): AdminLinkFlagReviewBody {
  const trimmed = note.trim();
  return {
    url: group.url,
    reason: group.reason,
    outcome,
    through: group.latestFlaggedAt,
    ...(trimmed === '' ? {} : { note: trimmed }),
    expectedAccountId: operatorId,
  };
}

/**
 * Why a mark was refused, in words: nothing left to mark (another operator marked the group
 * first) — the screen then reads the list again; the cookie of another account
 * (`copy.sessionChanged`: nothing was marked, and the session is asked again, ADR-0092); anything
 * else is the common error.
 */
export function linkFlagReviewErrorMessage(error: unknown): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  return isApiError(error, 'NOT_FOUND') ? copy.adminLinkFlagReviewGone : copy.errUnknown;
}

/**
 * Whether a refused mark keeps its dialog, with the outcome and the note in it: only when the
 * request never came back — nothing was decided, so the operator may send it again (a mark that
 * did commit unseen comes back NOT_FOUND, so a second one is never made). Any answer from the API,
 * NOT_FOUND and a 500 among them, closes it and the lists are read again — as the other admin
 * dialogs do (`refundKeepsDialog`, `adminRoleChangeRefusal`, `releaseSettingChangeRefusal`).
 */
export function linkFlagReviewKeepsDialog(error: unknown): boolean {
  return !isApiError(error);
}

/**
 * A row's button named after its row — the rule and the link, then what the button says — so a
 * screen reader's list of buttons tells the rows apart: '한 사람이 3번 이상 https://… 항목 보기'.
 */
export function linkFlagGroupActionLabel(group: AdminLinkFlagGroup, action: string): string {
  return `${linkFlagReasonLabel(group.reason)} ${group.url} ${action}`;
}

/** A label and a time, as the admin screens write one: '탐지 2026. 10. 21. 오후 3:00'. */
function labelledTime(label: string, iso: string): string {
  return `${label} ${formatKst(iso)}`;
}

/** When the item was put on the list. */
export function linkFlagFlaggedAt(flag: AdminLinkFlag): string {
  return labelledTime(copy.adminLinkFlagFlaggedAt, flag.flaggedAt);
}

/** When the group's latest entry was put on the list: '최근 탐지 2026. 10. 21. 오후 3:00'. */
export function linkFlagGroupLatest(group: AdminLinkFlagGroup): string {
  return labelledTime(copy.adminLinkFlagLatest, group.latestFlaggedAt);
}

/**
 * Who marked the group and when: '확인 2026. 10. 21. 오후 3:00 · 운영자 닉네임' — '탈퇴한 사용자' for
 * an operator who closed the account since (#140, after the admin role was revoked).
 */
export function linkFlagReviewedBy(review: NonNullable<AdminLinkFlagGroup['review']>): string {
  return `${labelledTime(copy.adminLinkFlagReviewedAt, review.reviewedAt)} · ${copy.adminLinkFlagReviewer} ${nicknameShown(review.admin.nickname)}`;
}

/**
 * The item's author as the entry names it: the nickname, or '탈퇴한 사용자' once the member closed
 * the account (#140, ADR-0086 — the item stays on the list, and the link to the member's page with
 * it, as on every operator screen).
 */
export function linkFlagAuthorName(flag: AdminLinkFlag): string {
  return nicknameShown(flag.target.author.nickname);
}

/** When the item was written. */
export function linkFlagWrittenAt(target: AdminLinkFlag['target']): string {
  return labelledTime(copy.adminLinkFlagWrittenAt, target.createdAt);
}

/**
 * What became of the item since it was written, each with its time, in the order it can happen:
 * edited, deleted by its author, hidden by an operator. Empty for an item as it was written. A
 * flag does none of these itself — the post stays as it is (decision 4 #187).
 */
export function linkFlagStates(target: AdminLinkFlag['target']): string[] {
  const states: string[] = [];
  if (target.editedAt !== null) {
    states.push(labelledTime(copy.adminLinkFlagEdited, target.editedAt));
  }
  if (target.deletedAt !== null) {
    states.push(labelledTime(copy.adminLinkFlagDeleted, target.deletedAt));
  }
  if (target.hiddenAt !== null) {
    states.push(labelledTime(copy.adminLinkFlagHidden, target.hiddenAt));
  }
  return states;
}
