import {
  COMMENT_REPLIED_NOTIFICATION,
  MODERATION_ACTION_CANCELLED_NOTIFICATION,
  MODERATION_ACTION_TAKEN_NOTIFICATION,
  MODERATION_ACTION_TYPES,
  MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION,
  NOTIFIED_PROPOSAL_DECISIONS,
  POST_REPLIED_NOTIFICATION,
  PROPOSAL_DECIDED_NOTIFICATION,
  RESTRICTION_ACTION_TYPES,
  type ModerationActionCancelledParams,
  type ModerationActionTakenParams,
  type ModerationActionType,
  type ModerationRestrictionEndChangedParams,
  type NotifiedProposalDecision,
  type ProposalDecidedParams,
  type ReplyParams,
  type RestrictionActionType,
  type RestrictionEndChangeKind,
} from '@buddha/shared';
import type { NotificationInput } from './notifications.js';
import { moderationActionEventKey } from './order-notifications.js';
import type { marketProposals, moderationActions } from './schema/index.js';

type ModerationActionRow = typeof moderationActions.$inferSelect;
type ProposalRow = typeof marketProposals.$inferSelect;

/*
 * 커뮤니티 알림 (#135, ADR-0161; N05 §2·§4·§5·§6, N04 §6, 52-7·52-15~52-19, 135-1~135-7): the
 * inputs of the six 커뮤니티 types, built from the rows their events already wrote. Pure functions
 * (ADR-0158): each transaction owner passes their output to its ONE `createNotifications` call,
 * last in the transaction, after its writes and unlocked reads (ADR-0157 결정 4, ADR-0158 12-20):
 *
 * - R1 a 댓글 and R2 a 대댓글 (the API's comments.service.ts `create`): `replyNotificationInput` to
 *   the author right above it (52-18) — the post's for a 댓글, the thread 댓글's for a 대댓글 (one
 *   answering a 대댓글 there included) — and nothing when that is the writer (135-3);
 * - M1–M9 an operator's action on a member, its cancellation and a writing restriction's 감경 or
 *   조기 해제 (moderation.service.ts): `moderationActionNotificationInput`,
 *   `moderationCancelNotificationInput`, `restrictionEndChangeNotificationInput` to the member
 *   acted on (52-16);
 * - A1–A3 an account restriction's approved apply, cancel, 감경 or 조기 해제
 *   (account-restrictions.service.ts): the same builders, appended to #134's inputs of the same
 *   call (ADR-0158 결과 6);
 * - P1/P2 a proposal's 채택 or 반려 (admin-proposals.service.ts): `proposalDecisionNotificationInput`
 *   to the proposer (52-19).
 *
 * Never: a dismissal (135-1, 52-17), a reporter (52-17), a report's intake, a restriction ending by
 * itself (52-16 — no worker producer), an account restriction's request, rejection or retraction,
 * a comment's or a post's edit or deletion, a like (135-3, 135-4, D5), a proposal's review start,
 * market link, memo or retraction (52-19 "결론만") — community-notifications.test.ts pins the
 * writers. The params carry the action's kind and a restriction's own end, the reply's id and
 * time, the decision and the proposer's question: never a reason, a note, an operator, an approval,
 * a report, a reporter, a reply's body or its author (135-2, 135-4, #45 13항).
 *
 * A throw here, or an input the definitions refuse, rolls the event back (ADR-0157 결정 4의 7,
 * 188-2): the comment, the action, the change or the decision. So the builders never produce what
 * the definitions refuse, a thrown message starts 'community notice: ' and names no account
 * (ADR-0160 12-10), and the tests run real rows through `createNotifications`.
 */

/** A comment's (a 댓글's or a 대댓글's, `post_comments.id`) event key: one notice per reply. */
export const commentEventKey = (commentId: string): string => `comment:${commentId}`;
/** A restriction's end change's (`restriction_end_changes.id`) event key: one per 감경·조기 해제. */
export const restrictionEndChangeEventKey = (changeId: string): string =>
  `restriction_end_change:${changeId}`;
/** A proposal's (`market_proposals.id`) event key: decided once (채택·반려 are final). */
export const proposalEventKey = (proposalId: string): string => `proposal:${proposalId}`;

/** A thrown caller bug, naming no account: the event rolls back with it (ADR-0158 12-19). */
function callerBug(message: string): never {
  throw new Error(`community notice: ${message}`);
}

/** The action's type as MODERATION_ACTION_TYPES lists it (the column is a varchar). */
function actionTypeOf(type: string): ModerationActionType {
  if (!(MODERATION_ACTION_TYPES as readonly string[]).includes(type)) {
    callerBug(`an action of an unknown type ${type}`);
  }
  return type as ModerationActionType;
}

const isRestriction = (type: ModerationActionType): type is RestrictionActionType =>
  (RESTRICTION_ACTION_TYPES as readonly string[]).includes(type);

/** The reply a notice tells: the comment row as its insert wrote it. */
export interface ReplyNoticeReply {
  readonly id: string;
  /** Its `created_at` (millisecond precision: `toISOString()` round-trips it). */
  readonly createdAt: Date;
  readonly authorId: string;
}

/**
 * What a reply answers (52-18): a 댓글 the post (its author), a 대댓글 the thread 댓글 (its author —
 * the 댓글 `lockParent` resolves a named 대댓글 to, never the named 대댓글's own author).
 */
export type ReplyNoticeParent =
  | { readonly kind: 'post'; readonly postId: string; readonly authorId: string }
  | {
      readonly kind: 'comment';
      readonly postId: string;
      readonly commentId: string;
      readonly authorId: string;
    };

/**
 * `post_replied` (R1) or `comment_replied` (R2) — 52-7, 52-15, 52-18, 135-3, 135-4: to the author
 * of what the reply answers, keyed by the reply (`commentEventKey`), merged by that post or 댓글
 * (the target, which a merge cannot change), at the reply's `created_at` — so the row's 발생 시각
 * (GREATEST) and the params' reply, the later by (created_at, id), stay one reply under
 * concurrent merges. The params are the reply's id and time only. Null when the writer is that
 * author (135-3: a self-reply is no bug). Pure: no SQL.
 */
export function replyNotificationInput(
  reply: ReplyNoticeReply,
  on: ReplyNoticeParent,
): NotificationInput | null {
  if (reply.authorId === on.authorId) return null;
  const params: ReplyParams = {
    replyId: reply.id,
    replyCreatedAt: reply.createdAt.toISOString(),
  };
  const common = {
    userId: on.authorId,
    eventKey: commentEventKey(reply.id),
    occurredAt: reply.createdAt,
    params,
  };
  return on.kind === 'post'
    ? {
        ...common,
        type: POST_REPLIED_NOTIFICATION.type,
        mergeKey: on.postId,
        target: { kind: 'post', postId: on.postId },
      }
    : {
        ...common,
        type: COMMENT_REPLIED_NOTIFICATION.type,
        mergeKey: on.commentId,
        target: { kind: 'comment', postId: on.postId, commentId: on.commentId },
      };
}

/**
 * `moderation_action_taken` (M1–M7, A1) — 52-16, 135-2, 135-6: a new action of any of the seven
 * types to the member acted on (`moderation_actions.user_id`), keyed by the action
 * (`moderationActionEventKey` — #134's `orders_cancelled` of an account restriction shares it,
 * another type, 53-4), at its `created_at` (the time MY 조치·신고 내역 shows), leading there. The
 * params are its kind and, for a restriction, its own end (null: 무기한). Pure: no SQL.
 *
 * Throws — a caller bug — on a type outside the list and on an end of anything but a restriction.
 */
export function moderationActionNotificationInput(
  action: Pick<ModerationActionRow, 'id' | 'type' | 'userId' | 'endsAt' | 'createdAt'>,
): NotificationInput {
  const type = actionTypeOf(action.type);
  if (action.endsAt !== null && !isRestriction(type)) callerBug(`a ${type} with an end`);
  const params: ModerationActionTakenParams = {
    action: type,
    endsAt: action.endsAt === null ? null : action.endsAt.toISOString(),
  };
  return {
    userId: action.userId,
    type: MODERATION_ACTION_TAKEN_NOTIFICATION.type,
    eventKey: moderationActionEventKey(action.id),
    occurredAt: action.createdAt,
    target: { kind: 'moderation_action', actionId: action.id },
    params,
  };
}

/**
 * `moderation_action_cancelled` (M8, A2) — 52-16 '그 취소': the cancellation of an action to the
 * member acted on — an ended restriction's too — keyed by the action under its own type (53-4:
 * `cancelled_at` is set once), at `at` (its `cancelled_at`). The params are its kind. Pure.
 *
 * Throws — a caller bug — on a type outside the list.
 */
export function moderationCancelNotificationInput(
  action: Pick<ModerationActionRow, 'id' | 'type' | 'userId'>,
  at: Date,
): NotificationInput {
  const params: ModerationActionCancelledParams = { action: actionTypeOf(action.type) };
  return {
    userId: action.userId,
    type: MODERATION_ACTION_CANCELLED_NOTIFICATION.type,
    eventKey: moderationActionEventKey(action.id),
    occurredAt: at,
    target: { kind: 'moderation_action', actionId: action.id },
    params,
  };
}

/** A restriction's end change as its insert wrote it (`restriction_end_changes`). */
export interface RestrictionEndChangeNotice {
  readonly id: string;
  readonly kind: RestrictionEndChangeKind;
  /** The new end: a 감경's later instant, a 조기 해제's own instant. */
  readonly endsAt: Date;
  readonly createdAt: Date;
}

/**
 * `moderation_restriction_end_changed` (M9, A3) — 52-16 '감경·조기 해제', 135-2, 135-5 (h): one
 * change of a restriction's end to the member acted on, keyed by the change (one action may be
 * shortened several times), at its `created_at`, leading to the action whose end changed. The
 * params are the restriction's kind, the change and the new end. Pure: no SQL.
 *
 * Throws — a caller bug — on an action that is not a restriction, a 조기 해제 whose end is not its
 * own instant and a 감경 whose end is not after it.
 */
export function restrictionEndChangeNotificationInput(
  change: RestrictionEndChangeNotice,
  action: Pick<ModerationActionRow, 'id' | 'type' | 'userId'>,
): NotificationInput {
  const type = actionTypeOf(action.type);
  if (!isRestriction(type)) callerBug(`an end change of a ${type}`);
  const kind: string = change.kind;
  if (kind === 'lift') {
    if (change.endsAt.getTime() !== change.createdAt.getTime()) {
      callerBug('a lift ends when it is made');
    }
  } else if (kind === 'shorten') {
    if (change.endsAt.getTime() <= change.createdAt.getTime()) {
      callerBug('a shortening ends after it is made');
    }
  } else {
    callerBug(`an end change of the kind ${kind}`);
  }
  const params: ModerationRestrictionEndChangedParams = {
    action: type,
    change: change.kind,
    endsAt: change.endsAt.toISOString(),
  };
  return {
    userId: action.userId,
    type: MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION.type,
    eventKey: restrictionEndChangeEventKey(change.id),
    occurredAt: change.createdAt,
    target: { kind: 'moderation_action', actionId: action.id },
    params,
  };
}

/**
 * `proposal_decided` (P1, P2) — 52-19 "채택·반려 결론만": the decision to the proposer
 * (`market_proposals.user_id`), keyed by the proposal (decided once — both final), at `at` (its
 * `decided_at`), leading to MY 내 제안. The params are the decision and the proposer's own
 * question — never the rejection's reason or explanation nor a memo. Pure: no SQL.
 *
 * Throws — a caller bug — on a proposal that is not `adopted` or `rejected`.
 */
export function proposalDecisionNotificationInput(
  proposal: Pick<ProposalRow, 'id' | 'userId' | 'question' | 'status'>,
  at: Date,
): NotificationInput {
  const decision = proposal.status;
  if (!(NOTIFIED_PROPOSAL_DECISIONS as readonly string[]).includes(decision)) {
    callerBug(`a decision notice of a proposal that is ${decision}`);
  }
  const params: ProposalDecidedParams = {
    decision: decision as NotifiedProposalDecision,
    question: proposal.question,
  };
  return {
    userId: proposal.userId,
    type: PROPOSAL_DECIDED_NOTIFICATION.type,
    eventKey: proposalEventKey(proposal.id),
    occurredAt: at,
    target: { kind: 'proposal', proposalId: proposal.id },
    params,
  };
}
