import { type LinkFlagReason, type LinkFlagTargetKind } from '@buddha/shared';
import { copy } from '@/copy';
import { type AdminLinkFlag } from './api';
import { formatKst } from './datetime';
import { postPath } from './posts';

/*
 * 반복 링크 검토 목록 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187) as the admin
 * screen reads `GET /admin/link-flags`: each post or comment a repetition rule caught, the link as
 * the rules compared it, the rule, and the item as it is now. Kept out of the component so vitest
 * runs it under node (admin-link-flags.test.ts). Times are Korean time, as on every admin screen
 * (ADR-0061 #60-8).
 */

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
 * Where an operator reads the item: the post's page — a comment's too, which is under its post
 * (the page has no anchor per comment). A deleted or hidden item shows its placeholder there; the
 * list's excerpt is what it said.
 */
export function linkFlagItemPath(target: AdminLinkFlag['target']): string {
  return postPath(target.postId);
}

/** A label and a time, as the admin screens write one: '탐지 2026. 10. 21. 오후 3:00'. */
function labelledTime(label: string, iso: string): string {
  return `${label} ${formatKst(iso)}`;
}

/** When the item was put on the list. */
export function linkFlagFlaggedAt(flag: AdminLinkFlag): string {
  return labelledTime(copy.adminLinkFlagFlaggedAt, flag.flaggedAt);
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
