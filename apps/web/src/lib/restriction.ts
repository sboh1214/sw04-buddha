import {
  restrictedDetailsSchema,
  type MyRestriction,
  type RestrictedDetails,
} from '@buddha/shared';
import { copy } from '@/copy';
import { isApiError } from './api';

/**
 * 작성 제한 (#185, ADR-0082) as a refused write says it: the server answers RESTRICTED (403) with
 * the restriction's kind and its end — null for 무기한 (`RestrictedDetails`) — wherever it refuses
 * (every new post, 댓글 and 대댓글, every edit of one's own, a post's image, a new value of a public
 * profile item). The screen says what is closed and until when, and shows the way to 조치·신고
 * 내역 under it (`isRestricted`, components/moderation/refusal-text.tsx) — the appeal's guidance and
 * its deadline live there, not in the refusal (owner decision 2026-10-22 evening, via #186: «제한
 * 중 거절의 이의 안내 → 끝나는 시각과 조치·신고 내역 링크(기한은 내역에)», which settles how ADR-0078's
 * owner answer 8 «끝나는 시각과 이의 안내» is said). Kept apart from lib/moderation.ts, which reads
 * lib/posts.ts and lib/profile.ts: those read this one, so neither imports the other.
 *
 * Every function takes the formatter of the member's time zone (`useFormatDateTime`, ADR-0063), as
 * `nicknameFailure` does for the nickname's next change: the end is an absolute time.
 */

/** What a refusal was about, which names what the restriction keeps closed. */
export type RestrictedWrite =
  /** A post, a 댓글 or 대댓글, an edit of one's own, a post's image. */
  | 'writing'
  /** A new 소개, image or interest category in MY 설정 — clearing them stays open (decision 7). */
  | 'profile'
  /**
   * A late pick on the onboarding's interests step (ADR-0078 3rd answer 1): a public profile
   * item's refusal, but that screen has nothing to clear — 건너뛰기 is what stays open there.
   */
  | 'onboardingInterests'
  /** A new nickname (MY 설정): nothing to clear. */
  | 'nickname';

const LEAD: Readonly<Record<RestrictedWrite, string>> = {
  writing: copy.errRestrictedWriting,
  profile: copy.errRestrictedProfile,
  onboardingInterests: copy.errRestrictedProfile,
  nickname: copy.errRestrictedNickname,
};

/**
 * RESTRICTED's details: which restriction and its end. Undefined for any other answer; `endsAt`
 * undefined when the details do not read (never from this API, which always sends them).
 */
export function restrictionOf(
  error: unknown,
): { endsAt: RestrictedDetails['endsAt'] | undefined } | undefined {
  if (!isApiError(error, 'RESTRICTED')) return undefined;
  const details = restrictedDetailsSchema.safeParse(error.details);
  return { endsAt: details.success ? details.data.endsAt : undefined };
}

/**
 * Whether a restriction refused the write (RESTRICTED): the screen then shows the way to 조치·신고
 * 내역 under the refusal's sentence (owner decision 2026-10-22 evening: «끝나는 시각과 조치·신고 내역
 * 링크»).
 */
export function isRestricted(error: unknown): boolean {
  return restrictionOf(error) !== undefined;
}

/**
 * A refusal a screen keeps to show: its sentence, and whether a restriction gave it — then the way
 * to 조치·신고 내역 goes under the sentence (components/moderation/refusal-text.tsx).
 */
export interface Refusal {
  message: string;
  restricted: boolean;
}

/** `message` as the refusal of `error` (the sentence a screen's failure function chose for it). */
export function refusalOf(error: unknown, message: string): Refusal {
  return { message, restricted: isRestricted(error) };
}

/**
 * When a restriction ends, as the member reads it: '2026. 10. 23. 오후 3:00까지' in their zone, or
 * '무기한' for one with no end — it ends when an operator lifts it (#45-12).
 */
export function restrictionTermText(
  endsAt: string | null,
  formatDate: (iso: string) => string,
): string {
  return endsAt === null
    ? copy.restrictionIndefinite
    : `${formatDate(endsAt)}${copy.restrictionUntil}`;
}

/**
 * The end as the member's 조치·신고 내역 and the banner list it under '끝나는 때': the time alone, or
 * '무기한'.
 */
export function restrictionEndText(
  endsAt: string | null,
  formatDate: (iso: string) => string,
): string {
  return endsAt === null ? copy.restrictionIndefinite : formatDate(endsAt);
}

/**
 * What a refused write says under a writing restriction, or undefined when the answer is not
 * RESTRICTED: what is closed (`write`), until when — '(…까지).' or '(무기한).' — and, for a public
 * profile item in MY 설정, that clearing it stays open (ADR-0069 decision 7). No appeal sentence and
 * no deadline: the way to 조치·신고 내역 goes under it (`isRestricted`). A RESTRICTED whose details
 * do not read says the rest without the end.
 */
export function restrictedMessage(
  error: unknown,
  write: RestrictedWrite,
  formatDate: (iso: string) => string,
): string | undefined {
  const restriction = restrictionOf(error);
  if (restriction === undefined) return undefined;
  const term =
    restriction.endsAt === undefined
      ? '.'
      : `(${restrictionTermText(restriction.endsAt, formatDate)}).`;
  const clear = write === 'profile' ? ` ${copy.errRestrictedClearAllowed}` : '';
  return `${LEAD[write]}${term}${clear}`;
}

/**
 * The restriction the banner speaks of (ADR-0069 decision 4 #50: «진행 중인 제재가 있으면 MY 요약·
 * 글쓰기 화면의 안내 띠»), from the member's own read of it (`GET /me/moderation/restriction`) — the
 * one that governs, the end every refused write names — or null: none stands, the read has not
 * answered, or its end has passed since by the browser's clock (a term ends by itself, #45-12: at
 * its end and not before).
 */
export function restrictionShown(
  answer: MyRestriction | undefined,
  // Read in render through this default: the member's restriction is never read on the server.
  now: number = Date.now(),
): RestrictedDetails | null {
  const restriction = answer?.restriction ?? null;
  if (restriction === null) return null;
  if (restriction.endsAt !== null && !(Date.parse(restriction.endsAt) > now)) return null;
  return restriction;
}
