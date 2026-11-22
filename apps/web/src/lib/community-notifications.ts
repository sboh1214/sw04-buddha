import type {
  ModerationActionCancelledParams,
  ModerationActionTakenParams,
  ModerationRestrictionEndChangedParams,
  ProposalDecidedParams,
} from '@buddha/shared';
import { copy } from '@/copy';
import type { PostAuthor } from './api';
import type { FormatDateTime } from './judgement-notifications';
import { formatQuantity } from './market-admin';
import { moderationActionLabel } from './moderation';
import { authorView } from './posts';
import { PROPOSAL_STATUS_LABEL } from './proposals';
import { restrictionTermText } from './restriction';
import { fillNotificationText } from './trade-notifications';

/**
 * 커뮤니티 알림 (#135, ADR-0161; N05 §2·§4·§6; owner answers 52-7, 52-15…52-19, 135-1…135-7) as
 * the inbox's row words them: the titles of `post_replied`, `comment_replied`,
 * `moderation_action_taken`, `moderation_action_cancelled`, `moderation_restriction_end_changed`
 * and `proposal_decided` from the params their definitions parsed (@buddha/shared
 * notifications.ts), in the sentences the owner approved (135-5). Each is copy.ts' single-brace
 * template filled by `fillNotificationText` (ADR-0158 12-10), which inserts a value as it is — a
 * question holding `{x}` or `$&` stays as written.
 *
 * A reply notice names the author of the latest reply it holds (52-15, 135-5 (a)) from the row's
 * `replyAuthor`, which the API reads when the list is read — the face the post page shows: the
 * nickname as it is now, '<닉네임>(운영자)' for an admin (#45-9, 135-5 (c)), '탈퇴한 사용자' for a
 * closed account; no name when that reply is hidden or deleted (null — its placeholder hides its
 * author, 135-4, 135-5 (b)). A merged one counts its replies and never as a score (N05 §2). No post
 * or market title (135-5 (d)): the row leads to the post.
 *
 * An action is named as MY 조치·신고 내역 names it (`moderationActionLabel`), a hide as '숨김' alone
 * (135-5 (e)), and a restriction's end is that action's own (135-6), in the MY band's words
 * (`restrictionTermText`: '<time>까지' in the member's zone, or '무기한'); a 조기 해제 has no time
 * (135-5 (f) — the row's 발생 시각 is when). Never the reason, the operator or a reporter (135-2).
 * A decision is named as MY 내 제안 names it (PROPOSAL_STATUS_LABEL: 채택·반려), with the member's
 * own question (135-5 (g)).
 *
 * `format` is the caller's — the renderer passes `useFormatDateTime()`'s — so this module stays
 * pure and node-safe and community-notifications.test.ts runs it with a fixed one.
 */

/** A count of merged replies as the titles write it: grouped, no unit. */
const count = (n: number) => formatQuantity(String(n));

/** The latest reply's author as a title names them (52-15, #45-9, ADR-0086). */
function replyAuthorName(author: PostAuthor): string {
  const view = authorView(author);
  return view.kind === 'member' && view.isAdmin
    ? fillNotificationText(copy.notificationReplyAuthorAdmin, { nickname: view.name })
    : view.name;
}

/** The four sentences of one reply type: one or merged, with or without the author. */
interface ReplyTexts {
  one: string;
  merged: string;
  oneNoAuthor: string;
  mergedNoAuthor: string;
}

function replyTitle(
  texts: ReplyTexts,
  eventCount: number,
  replyAuthor: PostAuthor | null | undefined,
): string {
  const merged = eventCount > 1;
  if (replyAuthor === null || replyAuthor === undefined) {
    return merged
      ? fillNotificationText(texts.mergedNoAuthor, { count: count(eventCount) })
      : texts.oneNoAuthor;
  }
  const author = replyAuthorName(replyAuthor);
  return merged
    ? fillNotificationText(texts.merged, { count: count(eventCount), author })
    : fillNotificationText(texts.one, { author });
}

/**
 * A `post_replied` title (52-7, 52-15, 52-18): a 댓글 on the member's post — '내 글에 새 댓글 ·
 * <작성자>', merged '내 글에 새 댓글 3개 · 마지막: <작성자>'.
 */
export function postRepliedTitle(
  eventCount: number,
  replyAuthor: PostAuthor | null | undefined,
): string {
  return replyTitle(
    {
      one: copy.notificationPostReplied,
      merged: copy.notificationPostRepliedMerged,
      oneNoAuthor: copy.notificationPostRepliedNoAuthor,
      mergedNoAuthor: copy.notificationPostRepliedMergedNoAuthor,
    },
    eventCount,
    replyAuthor,
  );
}

/**
 * A `comment_replied` title (52-7, 52-15, 52-18): a 대댓글 under the member's 댓글 — '내 댓글에 새
 * 답글 · <작성자>' (the web's own word for a 대댓글, `copy.commentReply`).
 */
export function commentRepliedTitle(
  eventCount: number,
  replyAuthor: PostAuthor | null | undefined,
): string {
  return replyTitle(
    {
      one: copy.notificationCommentReplied,
      merged: copy.notificationCommentRepliedMerged,
      oneNoAuthor: copy.notificationCommentRepliedNoAuthor,
      mergedNoAuthor: copy.notificationCommentRepliedMergedNoAuthor,
    },
    eventCount,
    replyAuthor,
  );
}

/**
 * Whether a `moderation_action_taken` title carries a term: the two restrictions do, '무기한'
 * included (52-16, 135-2 '(제한이면) 끝나는 때').
 */
export function moderationTakenHasTerm(params: ModerationActionTakenParams): boolean {
  return params.action === 'writing_restriction' || params.action === 'account_restriction';
}

/**
 * A `moderation_action_taken` title (52-16, 135-2, 135-6): '운영 조치: <종류>', and for a
 * restriction ' · <그 조치의 끝>까지' or ' · 무기한'.
 */
export function moderationTakenTitle(
  params: ModerationActionTakenParams,
  format: FormatDateTime,
): string {
  const action = moderationActionLabel(params.action);
  if (!moderationTakenHasTerm(params)) {
    return fillNotificationText(copy.notificationModerationTaken, { action });
  }
  return fillNotificationText(copy.notificationModerationTakenTerm, {
    action,
    term: restrictionTermText(params.endsAt, format),
  });
}

/** A `moderation_action_cancelled` title (52-16 '그 취소'): '운영 조치 취소: <종류>'. */
export function moderationCancelledTitle(params: ModerationActionCancelledParams): string {
  return fillNotificationText(copy.notificationModerationCancelled, {
    action: moderationActionLabel(params.action),
  });
}

/**
 * A `moderation_restriction_end_changed` title (52-16, 135-5 (f)·(h), 135-6): a 감경 with the
 * restriction's new end, a 조기 해제 with no time.
 */
export function restrictionEndChangedTitle(
  params: ModerationRestrictionEndChangedParams,
  format: FormatDateTime,
): string {
  const action = moderationActionLabel(params.action);
  if (params.change === 'lift') {
    return fillNotificationText(copy.notificationRestrictionLifted, { action });
  }
  return fillNotificationText(copy.notificationRestrictionShortened, {
    action,
    term: restrictionTermText(params.endsAt, format),
  });
}

/** A `proposal_decided` title (52-19, 135-5 (g)): '시장 제안 <채택|반려> · <내 질문>'. */
export function proposalDecidedTitle(params: ProposalDecidedParams): string {
  return fillNotificationText(copy.notificationProposalDecided, {
    decision: PROPOSAL_STATUS_LABEL[params.decision],
    question: params.question,
  });
}
