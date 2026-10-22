import {
  BIO_MAX_LENGTH,
  JOINED_MONTH_PATTERN,
  PROFILE_IMAGE_CONTENT_TYPES,
  bioRefusalOf,
  codePointLength,
  normaliseBio,
  type ImageRefusal,
} from '@buddha/shared';
import type { Metadata } from 'next';
import * as z from 'zod';
import { copy } from '@/copy';
import {
  type ProfileInterestCategory,
  type PublicProfile,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { CATEGORY_TRAIL_SEPARATOR } from './category-label';
import { type Onboarding, hasOnboardingStepLeft, needsOnboarding } from './onboarding';
import {
  imagePrecheck,
  imageRefusalMessage,
  imageUploadErrorMessage,
  uploadContentType,
} from './post-editor';

/**
 * 공개 프로필 (#41, ADR-0078) as the screens read it: its address, what the page says of the
 * member's public items, and MY 설정's editors of them — the image (#141, ADR-0079), the 소개 and the
 * interest categories.
 * Pure functions of the API's answers, kept apart from the components and the hooks so the node
 * test runner reaches them, and free of `'use client'`, so the server page uses them too.
 *
 * Owner decisions (ADR-0069 decision 3 #37, decision 4 #41, decision 7): the profile lives at
 * `/u/<publicId>` — the public id never changes, so an old link finds the member after a nickname
 * change (#37-2) — and anyone reads it, signed in or not, while search engines are kept away
 * (#37-1). It shows the CURRENT nickname (#37-3), the image the member uploaded (#141) or else the
 * nickname's first letter — never a social login's photo (#37-6) —, '운영자' on an admin account
 * (#45-9), the 소개 — plain text of at most 160 characters, its line breaks kept, never a link
 * (#37-3) —, every interest category picked and nothing when none (#37-5), the year and month
 * joined ('2026년 10월 가입', #37-3), and the counts of posts, comments and likes received (#37-4) —
 * numbers, never a score, a rank or a skill (N05 §2, D5). Nothing else of the account (#37-8,
 * #37-11~13). The member edits the image, the 소개 and the categories in MY 설정, and the own profile
 * links there (decision 4 #41).
 */

// ---- the address ---------------------------------------------------------------------------------

/** The profile's address: the public id, never the account id nor the nickname (#37-2). */
export function profilePath(publicId: string): string {
  return `/u/${publicId}`;
}

/** MY 설정, where the public items are edited (decision 4 #41: «MY 설정»). */
export const PROFILE_SETTINGS_PATH = '/my/settings';

/**
 * Every answer of the profile page — the profile, and none — is kept out of search engines
 * (#37-1: «검색 엔진에는 노출하지 않는다»): `noindex` on the page itself, whichever it is. The tab
 * says whose profile it is by the current nickname, and nothing more. No description of its own —
 * the 소개 is not made one, for a page no search engine shows — so the page keeps the site's, which
 * Next merges in from the root layout (`copy.appDescription`, ADR-0078 7-20).
 */
export function profilePageMetadata(profile: PublicProfile | null): Metadata {
  const title = profile === null ? copy.profileNotFound : profile.member.nickname;
  return { title: `${title} | ${copy.appName}`, robots: { index: false } };
}

/**
 * Whether the viewer is the member: the profile's public id is the viewer's own
 * (`Me.profile.publicId`), never the account id, which no public answer carries (ADR-0069
 * decision 5) — as a post tells its author. Decides only whether the page offers the link to MY
 * 설정; every edit is an owner route the server checks.
 */
export function isOwnProfile(publicId: string, viewerPublicId: string | undefined): boolean {
  return viewerPublicId !== undefined && publicId === viewerPublicId;
}

// ---- what the page says ----------------------------------------------------------------------------

/**
 * '2026년 10월 가입' (#37-3: «연·월»): the month the account joined as the API answers it
 * (`YYYY-MM`, Korea time — ADR-0078), the month without a leading zero. Nothing finer is known
 * here: the answer carries no day or time. A value the pattern refuses (never sent) says nothing
 * rather than a broken date.
 */
export function joinedMonthText(joinedMonth: string): string {
  if (!JOINED_MONTH_PATTERN.test(joinedMonth)) return '';
  const [year = '', month = ''] = joinedMonth.split('-');
  return `${year}${copy.profileYearUnit} ${String(Number(month))}${copy.profileMonthUnit} ${copy.profileJoined}`;
}

/**
 * An interest category as the profile writes it: a top-level one by its name, a sub-category after
 * the top-level one it sits under (the same name can sit under two) — the trail the market detail
 * writes (`CATEGORY_TRAIL_SEPARATOR`).
 */
export function interestCategoryLabel(category: ProfileInterestCategory): string {
  return category.parent === null
    ? category.nameKo
    : `${category.parent.nameKo}${CATEGORY_TRAIL_SEPARATOR}${category.nameKo}`;
}

/** One of the profile's counts (#37-4): what it counts and the number. */
export interface ProfileCount {
  key: 'posts' | 'comments' | 'likes';
  label: string;
  value: string;
}

/**
 * The three counts in the owner's order (#37-4: «글·댓글 수와 받은 좋아요 합계»): visible posts,
 * visible 댓글 and 대댓글, and the likes those hold (ADR-0078; deleted and hidden ones count for
 * none — owner decision 2026-10-20). A number each, with its thousands separated — the profile is
 * drawn on the server alone, so no browser has to agree on the format. Never added up, ranked or
 * called anything but what it counts.
 */
export function profileCounts(profile: PublicProfile): ProfileCount[] {
  const format = (count: number) => count.toLocaleString('ko-KR');
  return [
    { key: 'posts', label: copy.profilePostCount, value: format(profile.postCount) },
    { key: 'comments', label: copy.profileCommentCount, value: format(profile.commentCount) },
    { key: 'likes', label: copy.profileReceivedLikes, value: format(profile.receivedLikeCount) },
  ];
}

// ---- MY 설정: the 소개 ----------------------------------------------------------------------------

/** A 소개 being written, as the server will measure it (#37-3). */
export interface BioDraft {
  /** What the server keeps: line breaks as `\n`, control characters dropped, trimmed. */
  bio: string;
  length: number;
  tooLong: boolean;
}

/**
 * Counts a 소개 the way `bioInputSchema` does — normalised (`normaliseBio`), then code points
 * (`codePointLength`: '가', 'a' and '😀' are one each, a line break one) — so the count under the
 * box is the server's and the member sees the limit before saving.
 */
export function bioDraft(text: string): BioDraft {
  const bio = normaliseBio(text);
  const length = codePointLength(bio);
  return { bio, length, tooLong: length > BIO_MAX_LENGTH };
}

/**
 * What `PUT /me/bio` is sent for the text in the box: the 소개 as the server keeps it, or `null`
 * when nothing is left — an empty or blank box clears the 소개 (#37-19: clearing is one of the
 * deletions, and it stays open during a restriction, decision 7).
 */
export function bioToSend(text: string): string | null {
  const { bio } = bioDraft(text);
  return bio === '' ? null : bio;
}

/** The count under the box: '12 / 160자'. */
export function bioLengthText(length: number): string {
  return `${length.toLocaleString('ko-KR')} / ${BIO_MAX_LENGTH.toLocaleString('ko-KR')}${copy.bioLengthUnit}`;
}

/** What MY 설정 does with a refused write of a public item (`PUT /me/bio`, the categories). */
export type ProfileItemFailure =
  /** Under the field: the 소개 is too long. */
  | { kind: 'field'; message: string }
  /**
   * `['me']` is out of date — a revision asked for the consent again while the screen was open
   * (ONBOARDING_REQUIRED) — and the hook has asked for it again: the gate, or on this page the step
   * (`profileItemRefusalMove`), takes the member on from there; said only when neither does.
   */
  | { kind: 'refresh'; message: string }
  /** The categories on screen are not all offered any more: the list is read again. */
  | { kind: 'categories'; message: string }
  /** Anything else, as a notice: the session switched, the connection, the generic error. */
  | { kind: 'notice'; message: string };

/**
 * What a refused public-item write tells the member:
 * - the cookie is another account than the screen's (`expectedAccountId`): the session switched;
 * - ONBOARDING_REQUIRED: a new value from an account whose `['me']` said nothing was left — a
 *   revision asked for the consent again while the screen was open, say. MY 설정 is reached by an
 *   onboarded account and, for clearing, by one facing a re-consent alone (ONBOARDING_EXEMPT_PAGES,
 *   owner decision 2026-10-21 answer 2): the hook asked `['me']` again, and the gate or the step
 *   takes the member on (`profileItemRefusalMove`) — this is said when neither can;
 * - VALIDATION_ERROR on `bio` (`bioRefusalOf`): more than 160 characters; on `categoryIds`: a
 *   category retired while the screen was open — the list is loaded again;
 * - a request that never reached the API, and anything else — the FORBIDDEN a writing or an
 *   account restriction will answer for a new value (#185, #139; ADR-0078) included: what the
 *   member sees of a restriction is those issues' to say.
 */
export function profileItemFailure(error: unknown): ProfileItemFailure {
  if (isForAnotherAccount(error)) return { kind: 'notice', message: copy.sessionChanged };
  if (isApiError(error, 'ONBOARDING_REQUIRED')) {
    return { kind: 'refresh', message: copy.errPostOnboarding };
  }
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'bio') {
      const refusal = bioRefusalOf(validationMessage(error) ?? '');
      if (refusal?.kind === 'too_long') return { kind: 'field', message: copy.errBioTooLong };
    }
    if (field === 'categoryIds') {
      return { kind: 'categories', message: copy.errInterestsUnavailable };
    }
  }
  return {
    kind: 'notice',
    message: isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown,
  };
}

// ---- MY 설정 for an account facing a re-consent ---------------------------------------------------

/**
 * What a save of a public item is, as the server tells them apart (`assertPublicItemOnboarding`,
 * ADR-0078 decision 4, 7-8 and 7-11): `clear` — the 소개 emptied, interest categories dropped and
 * none added, the image deleted (#141) — asks for a session alone, an account facing a re-consent
 * included (owner decisions 2026-10-21 answer 2 and 2026-10-22); `replace` — a 소개 with text, a
 * category the account did not have, any image uploaded — is for an account that has done its
 * onboarding.
 */
export type PublicItemEdit = 'clear' | 'replace';

/** The 소개's save: `null` (`bioToSend` of a blank box) clears it, any text is a new value. */
export function bioEdit(next: string | null): PublicItemEdit {
  return next === null ? 'clear' : 'replace';
}

/**
 * The interest categories' save: a new value when it holds a category the account does not have
 * (`held`, `Me.profile.interestCategoryIds`) — dropping some or all of them is a deletion, and a
 * save that drops one and adds another is a new value (ADR-0078 7-11).
 */
export function interestsEdit(chosen: readonly number[], held: readonly number[]): PublicItemEdit {
  const had = new Set(held);
  return chosen.some((id) => !had.has(id)) ? 'replace' : 'clear';
}

/**
 * Whether MY 설정 takes a save to the account's remaining step rather than sending it. The page is
 * exempt for an account facing a re-consent alone (ONBOARDING_EXEMPT_PAGES) so it can clear its
 * public items with a session alone (owner decision 2026-10-21 answer 2, ADR-0078 7-24); a new value
 * is for an onboarded account only — the server would refuse it — so it goes to the step first, which
 * comes back to MY 설정 (`onboardingEntryPath`), as the post page's writes do (#46, #48, #49): a 소개
 * with text, a category added, and a nickname change, which is always `replace` (owner decision
 * 2026-10-22 answer 1 — `PATCH /me` is behind OnboardedGuard). The 소개 typed, the categories
 * picked and the nickname typed are kept in the tab for the return (lib/profile-drafts.ts, answer 3
 * and 2026-10-22 (2nd) answer 2). `stepLeft` is `useOnboardingEntry`'s: `GET /me` names a step
 * left — on this page, a re-consent.
 */
export function profileItemSaveGoesToStep(edit: PublicItemEdit, stepLeft: boolean): boolean {
  return stepLeft && edit === 'replace';
}

/**
 * Where a save the server refused for the onboarding (ONBOARDING_REQUIRED) goes, once `['me']` has
 * been read again (the hooks do it before the save's promise rejects): `onboarding` is what it says
 * now, and `pathname` the page shown now. Such a save was sent because `GET /me` had not said a step
 * is left — a revision asked for the consent again while the screen was open. As a 좋아요's
 * (`likeRefusalMove`; owner decisions 2026-10-20 answer 1 and 2026-10-21 for #46's refusals: a
 * refusal for a re-consent moves to the step without a word):
 * - `gate`: the onboarding gate takes the account from this page (`needsOnboarding` — an onboarding
 *   not finished): nothing to say, the gate goes to the step;
 * - `step`: still on MY 설정, which the gate lets an account facing a re-consent alone stay on, with a
 *   step left: the save goes to it now, nothing said;
 * - undefined: anything else — another refusal, `['me']` not read again (a failure keeps what it
 *   held) or naming no step, the member gone from MY 설정 meanwhile — and the card says why
 *   (`profileItemFailure`).
 */
export function profileItemRefusalMove(
  error: unknown,
  at: { pathname: string; onboarding: Onboarding | undefined },
): 'gate' | 'step' | undefined {
  if (!isApiError(error, 'ONBOARDING_REQUIRED')) return undefined;
  if (needsOnboarding(at.pathname, at.onboarding)) return 'gate';
  return at.pathname === PROFILE_SETTINGS_PATH && hasOnboardingStepLeft(at.onboarding)
    ? 'step'
    : undefined;
}

// ---- MY 설정: the interest categories -------------------------------------------------------------

/**
 * Whether the categories picked on screen differ from the account's: both read among the
 * categories the list offers (a retired one is neither shown nor sent, `interestIds`), so a
 * category operators retired does not leave the 저장 button lit on a screen where nothing moved.
 */
export function interestsChanged(
  picked: readonly number[],
  held: readonly number[],
  offered: readonly { id: number }[],
): boolean {
  const ids = new Set(offered.map((category) => category.id));
  const shown = (list: readonly number[]) =>
    [...new Set(list.filter((id) => ids.has(id)))].sort((a, b) => a - b).join(',');
  return shown(picked) !== shown(held);
}

/**
 * MY 설정's 소개 form (`react-hook-form`, as the nickname card): the text as typed, refused before
 * sending when it is longer than the server takes (`bioDraft`). Blank is not refused — it clears the
 * 소개 (`bioToSend`).
 */
export const bioFormSchema = z.object({
  bio: z.string().superRefine((text, ctx) => {
    if (bioDraft(text).tooLong) ctx.addIssue({ code: 'custom', message: copy.errBioTooLong });
  }),
});
export type BioFormValues = z.input<typeof bioFormSchema>;

// ---- MY 설정: the image -----------------------------------------------------------------------------

/*
 * 프로필 이미지 (#141, ADR-0079; ADR-0069 decision 3 #37-6, decision 4 #141): uploaded straight from
 * MY 설정 — JPEG, PNG or WebP, at most 5MB — and checked by the server by its bytes, which crops the
 * middle to a square (512px at most, never enlarged) and strips the metadata (EXIF) before storing
 * it; no crop is chosen on screen (owner decisions 2026-10-22). Replacing or deleting it removes
 * the earlier one at once. The upload goes the way a post's image does (`PUT /me/profile-image`:
 * the file itself as the body, the account in the query), so the checks before sending and the
 * reasons of a refusal are the post editor's (lib/post-editor.ts), with the profile image's own
 * three types: a GIF is not taken.
 */

/** The file picker's types: the three the server takes (#37-6); it decides by the bytes anyway. */
export const PROFILE_IMAGE_ACCEPT = PROFILE_IMAGE_CONTENT_TYPES.join(',');

/**
 * Whether a picked file is worth sending as the profile image: an empty file, one over 5MB, or one
 * declared as another type than the three (a GIF included) is refused here with the server's own
 * reason; anything else — a file with no declared type too — goes up and the server decides.
 */
export function profileImagePrecheck(file: {
  type: string;
  size: number;
}): ImageRefusal | undefined {
  return imagePrecheck(file, PROFILE_IMAGE_CONTENT_TYPES);
}

/** The upload's `Content-Type`: the file's own when it is one of the three, else bytes. */
export function profileImageContentType(file: { type: string }): string {
  return uploadContentType(file, PROFILE_IMAGE_CONTENT_TYPES);
}

/**
 * Why a profile image was refused, in the member's words: the type and the size name the profile
 * image's own rule (JPEG·PNG·WebP, 5MB — a post's names the GIF too), the rest are a post image's.
 */
export function profileImageRefusalMessage(reason: ImageRefusal): string {
  if (reason === 'type') return copy.errProfileImageType;
  if (reason === 'size') return copy.errProfileImageSize;
  return imageRefusalMessage(reason);
}

/**
 * What a refused upload says: as a post image's (`imageUploadErrorMessage` — the server's reason,
 * the cookie as another account, ONBOARDING_REQUIRED, an unreachable server, a failed upload) with
 * the profile image's reasons. The FORBIDDEN a writing or an account restriction answers for a new
 * image names no field and is a failed upload for now: what the member sees of a restriction is
 * #185's and #139's to say (owner decision 2026-10-21 answer 8 on #41, ADR-0078 7-9).
 */
export function profileImageUploadFailure(error: unknown): string {
  // Never an upload given up while it waited to be sent again (`UploadAbandoned`, the one thing
  // said as nothing with `gateMoves` false): the card's sends are never given up (hooks/use-me.ts).
  // A 429 here is one still refused after the card sent the file again: a failed upload.
  return imageUploadErrorMessage(error, false, profileImageRefusalMessage) ?? copy.errImageUpload;
}

/** What a refused deletion says: the session switched, the connection, or that it failed. */
export function profileImageDeleteFailure(error: unknown): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  return isApiUnreachable(error) ? copy.errNetwork : copy.errProfileImageDelete;
}
