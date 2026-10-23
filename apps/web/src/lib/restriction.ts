import {
  RESTRICTION_KINDS,
  restrictedDetailsSchema,
  type MyRestriction,
  type RestrictedDetails,
  type RestrictionKind,
} from '@buddha/shared';
import { copy } from '@/copy';
import { isApiError } from './api';

/**
 * 작성 제한 (#185, ADR-0082) and 계정 제한 (#139, ADR-0085) as a refused write says them: the server
 * answers RESTRICTED (403) with the restriction's kind and its end — null for 무기한
 * (`RestrictedDetails`) — wherever it refuses (a writing restriction: every new post, 댓글 and
 * 대댓글, every edit of one's own, a post's image; either: a new value of a public profile item —
 * the later-ending one named, the account restriction when both end together, ADR-0085 7-6). The
 * screen says which restriction closes what and until when, and shows the way to 조치·신고 내역
 * under it (`isRestricted`, components/moderation/refusal-text.tsx) — the appeal's guidance and its
 * deadline live there, not in the refusal (owner decision 2026-10-22 evening, via #186: «제한 중
 * 거절의 이의 안내 → 끝나는 시각과 조치·신고 내역 링크(기한은 내역에)», which settles how ADR-0078's owner
 * answer 8 «끝나는 시각과 이의 안내» is said; #185·#139 both). Kept apart from lib/moderation.ts,
 * which reads lib/posts.ts and lib/profile.ts: those read this one, so neither imports the other.
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
   * item's refusal, but that screen has nothing to clear — 건너뛰기 is what stays open there, and
   * the refusal says so (owner decision 2026-10-23 answer 9).
   */
  | 'onboardingInterests'
  /** A new nickname (MY 설정): nothing to clear. */
  | 'nickname';

/**
 * The refusal's first sentence, by the restriction that refused (`kind`) and what was refused. An
 * account restriction never refuses a post, a comment nor an edit (ADR-0069 decision 1 #57-12:
 * «커뮤니티 작성은 막지 않는다»), so a refused write is the writing restriction's sentence whatever
 * the kind; a public profile item and a nickname name the restriction that refused them (ADR-0085
 * 7-11). Unreadable details (never from this API) say the writing restriction's, as before #139.
 */
const LEAD: Readonly<Record<RestrictionKind, Readonly<Record<RestrictedWrite, string>>>> = {
  writing: {
    writing: copy.errRestrictedWriting,
    profile: copy.errRestrictedProfile,
    onboardingInterests: copy.errRestrictedProfile,
    nickname: copy.errRestrictedNickname,
  },
  account: {
    writing: copy.errRestrictedWriting,
    profile: copy.errRestrictedAccountProfile,
    onboardingInterests: copy.errRestrictedAccountProfile,
    nickname: copy.errRestrictedAccountNickname,
  },
};

/**
 * RESTRICTED's details: which restriction and its end. Undefined for any other answer; `kind` and
 * `endsAt` undefined when the details do not read (never from this API, which always sends them).
 */
export function restrictionOf(error: unknown):
  | {
      kind: RestrictionKind | undefined;
      endsAt: RestrictedDetails['endsAt'] | undefined;
    }
  | undefined {
  if (!isApiError(error, 'RESTRICTED')) return undefined;
  const details = restrictedDetailsSchema.safeParse(error.details);
  return details.success
    ? { kind: details.data.kind, endsAt: details.data.endsAt }
    : { kind: undefined, endsAt: undefined };
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
 * What stays open, said after the end: clearing a public profile item in MY 설정 (ADR-0069 decision
 * 7, kept by owner decision 2026-10-23 answer 8) and 건너뛰기 on the onboarding's interests step
 * (owner decision 2026-10-23 answer 9). Nothing for a post's writing nor for a nickname.
 */
const STILL_OPEN: Readonly<Record<RestrictedWrite, string | undefined>> = {
  writing: undefined,
  profile: copy.errRestrictedClearAllowed,
  onboardingInterests: copy.errRestrictedSkipAllowed,
  nickname: undefined,
};

/**
 * What a refused write says under a restriction, or undefined when the answer is not RESTRICTED:
 * which restriction closes what (`LEAD`, by the answer's kind and `write`), until when — '(…까지).'
 * or '(무기한).' — and what stays open (`STILL_OPEN`): for a public profile item in MY 설정, that
 * clearing it does; on the onboarding's interests step, that 건너뛰기 does — whichever restriction
 * refused, since both leave them open (ADR-0069 decision 7). No appeal sentence and no deadline:
 * the way to 조치·신고 내역 goes under it (`isRestricted`). A RESTRICTED whose details do not read
 * says the writing restriction's sentence without the end.
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
  const open = STILL_OPEN[write];
  return `${LEAD[restriction.kind ?? 'writing'][write]}${term}${open === undefined ? '' : ` ${open}`}`;
}

/**
 * The restrictions the banner speaks of (ADR-0069 decision 4 #50: «진행 중인 제재가 있으면 MY 요약·
 * 글쓰기 화면의 안내 띠» — 제재 being 작성 제한 and 계정 제한, #45-12), from the member's own read of
 * them (`GET /me/moderation/restriction`) — of each kind the one that governs, the end a refused
 * write names — in RESTRICTION_KINDS' order (the writing restriction, then the account
 * restriction), each only while it stands: none while the read has not answered, and none whose end
 * has passed since by the browser's clock (a term ends by itself, #45-12: at its end and not
 * before). Empty when none stands.
 */
export function restrictionsShown(
  answer: MyRestriction | undefined,
  // Read in render through this default: the member's restriction is never read on the server.
  now: number = Date.now(),
): RestrictedDetails[] {
  if (answer === undefined) return [];
  const byKind: Readonly<Record<RestrictionKind, RestrictedDetails | null>> = {
    writing: answer.restriction,
    account: answer.accountRestriction,
  };
  return RESTRICTION_KINDS.flatMap((kind) => {
    const restriction = byKind[kind];
    if (restriction === null) return [];
    if (restriction.endsAt !== null && !(Date.parse(restriction.endsAt) > now)) return [];
    return [restriction];
  });
}
