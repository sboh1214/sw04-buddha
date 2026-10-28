import {
  CONSENT_DOCUMENTS,
  PAID_COIN_SALES_ENABLED,
  onboardingState,
  type ConsentRecord,
  type Onboarding as SharedOnboarding,
} from '@buddha/shared';
import type { Me } from './api';
import { safeNextPath } from './next-path';

/**
 * The onboarding (#58, ADR-0072) as the screens read it: the gate that sends a signed-in account
 * with steps left to /onboarding, the stepper there, and how an onboarding write's answer goes
 * into `['me']`.
 *
 * The gate (ADR-0043, keyed on 본인확인 by ADR-0070 and on the whole onboarding since #58): a
 * signed-in account whose `GET /me` names a next step — every new account, social or email, until
 * its consent, 본인확인 and nickname are done, and one whose consent a revision that changed
 * members' rights asked for again (#57-5) — is sent to /onboarding from every screen except the
 * ones below, resumes at that step (#57-8 '남은 단계부터'), and comes back to where it was going
 * once nothing is left (#57-9). The interest categories are not a step it is sent back to: an
 * account that left the onboarding screen before them has skipped them (오너 결정 2026-10-19 (2차) 5).
 * Email sign-ups set their password on /set-password first and meet the gate on the page it goes
 * on to (`next`): every auth screen — the login form, the social callback, /set-password — goes
 * back to `next`, and the gate there starts the onboarding — on a post page too, which the gate
 * exempts for an account facing a re-consent alone (ONBOARDING_EXEMPT_PAGES), never for one that
 * has not finished its onboarding: a new account that signed up or signed in from a post page is
 * sent on from it, and comes back to it at the end (오너 결정 2026-10-20, ADR-0073 9-37).
 *
 * Pure functions of the URL and of what `GET /me` said, kept out of the gate component
 * (components/auth/onboarding-gate.tsx) and the stepper (app/onboarding/onboarding-form.tsx) so
 * vitest can run them under its node environment. The gate is a client component rather than a
 * check in `proxy.ts`: knowing the account's onboarding takes a `GET /me`, and a proxy that asked
 * the API on every navigation would put one extra request in front of every page — the matcher
 * widening ADR-0034 already declined for less. The client already holds that answer (the nav's
 * balance chip reads it). The gate is the screen's; the server's own check (`OnboardedGuard`,
 * `assertOnboarded`) is what the actions #57-8 keeps from an account that has not finished make.
 */

/** `GET /me`'s `onboarding`: the steps done, where the account resumes, its consent answers. */
export type Onboarding = Me['onboarding'];

export const ONBOARDING_PATH = '/onboarding';

/**
 * Routes a signed-in account with onboarding steps left may still open (#57-8: the legal pages are
 * the owner's exception, the auth screens are where an account gets this far). Each entry covers
 * itself and its subtree (`/terms`, `/terms/…`), never a look-alike prefix (`/termsx`).
 * - /onboarding itself, or the gate would loop.
 * - The auth screens: /login, /signup, /reset-password, and /set-password, where an email
 *   sign-up sets its first password before its onboarding.
 * - What a visitor must be able to read before agreeing to it and handing personal data over: the
 *   three legal documents — the consent step links /terms and /privacy in a new tab — and the
 *   public charge guide (ADR-0044) while paid Coin is on sale — `/charge` is not found otherwise
 *   (PAID_COIN_SALES_ENABLED, ADR-0049).
 * - /api: never a page — the layout the gate lives in does not render for it — but the list is
 *   total so the decision could move into `proxy.ts` without ever answering an API call (the
 *   auth routes included) with a redirect to an HTML form.
 *
 * /admin is deliberately NOT here: an administrator's account is an account like any other, and
 * onboards like one (ADR-0069 decision 4 #58).
 */
export const ONBOARDING_EXEMPT_PATHS: readonly string[] = [
  ONBOARDING_PATH,
  '/login',
  '/signup',
  '/set-password',
  '/reset-password',
  '/terms',
  '/privacy',
  '/refund',
  ...(PAID_COIN_SALES_ENABLED ? ['/charge'] : []),
  '/api',
];

/**
 * A page an account facing a re-consent may still open because the owner lets it do something
 * there with a session alone — the server asks nothing more of that action — and the screen has to
 * reach it too (오너 결정 2026-10-20, ADR-0073). Unlike ONBOARDING_EXEMPT_PATHS an entry is exactly
 * one page, never the pages under it: the post page is exempt, its edit screen is not. What the
 * page offers that the onboarding still keeps from the account — writing, editing, the comment
 * boxes (#48) and 좋아요 (#49, owner decision 2026-10-20, ADR-0076), a public profile item's new
 * value (#41) — sends it to its step instead of opening the form or sending the press
 * (`onboardingEntryPath`, hooks/use-onboarding-entry.ts), so the exemption opens the page and never
 * a write the server would refuse it.
 *
 * Only for an account that finished its onboarding once and has a re-consent alone left
 * (`hasOnlyReconsentLeft`, 오너 결정 2026-10-20 3차 답 1): what it did before the revision — its
 * own posts, and its public profile's 소개 and interest categories (오너 결정 2026-10-21 답 2,
 * #41) and image (오너 결정 2026-10-22, #141) — is what it may still remove. An account that has
 * not finished — a new one that signed up or signed in from the page, `next` bringing it back
 * there — is sent on from it like from any page, with the page as `next`, and comes back to it at
 * the end (#57-9).
 */
export interface OnboardingExemptPage {
  /**
   * The page's route as the app directory spells it: `/`-separated segments, `[name]` for one
   * dynamic segment (any value but an empty one).
   */
  readonly route: string;
  /** What the account may do there with a session alone, and the decision that says so. */
  readonly reason: string;
}

/**
 * The pages exempt for a login-only action. Later issues add theirs here: #77 the proposal list
 * (`/my/proposals`, withdrawing a proposal); #48's comment deletion lives on the post page, whose
 * comment writes — 답글, 수정, 올리기 — go to the step (components/post/comments-section.tsx), and so
 * do its 좋아요 (#49, components/post/like-button.tsx). #41's MY 설정 clears the public profile's
 * 소개 and drops its interest categories, and deletes its image (#141, ADR-0079); a new 소개, a
 * category added, a new image, a nickname change (owner decision 2026-10-22 answer 1) and the
 * marketing switch — a consent record, which the consent step's items come with — go to the step
 * (app/my/settings: `profileItemSaveGoesToStep`, lib/profile.ts), the 소개 typed, the categories
 * picked and the nickname typed kept in the tab for the return (lib/profile-drafts.ts, answer 3
 * and 2026-10-22 (2nd) answer 2). Its account cards —
 * email, password, linked sign-ins, real name, time zone, theme — write what the server takes with
 * a session alone (ADR-0078 7-24). The re-consent step links to it (`settingsLinkOnStep`, answer 2).
 * ADR-0061's watchlist is not one: its server asks for a session alone, and its screens keep the
 * onboarding prompt (#89 — the owner wrote the screen in).
 */
export const ONBOARDING_EXEMPT_PAGES: readonly OnboardingExemptPage[] = [
  {
    route: '/community/posts/[postId]',
    reason:
      'an author facing a re-consent deletes their own post and their own comments with a session alone (owner decisions 2026-10-19 answer 2 and 2026-10-20, #46, #48); its edit entry, its comment writes and its likes (#49) go to the step',
  },
  {
    route: '/my/settings',
    reason:
      'a member facing a re-consent clears the 소개, drops interest categories and deletes the image of their public profile with a session alone (owner decisions 2026-10-21 answer 2, #41, and 2026-10-22, #141), and keeps the account cards; a new 소개, a category added, a new image, a nickname change (owner decision 2026-10-22 answer 1) and the marketing switch go to the step',
  },
];

function isUnder(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/** Whether `pathname` is the page `route` names: segment for segment, `[name]` matching one. */
export function isRoutePage(pathname: string, route: string): boolean {
  const path = pathname.split('/');
  const pattern = route.split('/');
  return (
    path.length === pattern.length &&
    pattern.every((segment, index) => {
      const value = path[index] ?? '';
      return /^\[[^\]/]+\]$/.test(segment) ? value !== '' : value === segment;
    })
  );
}

/** Whether `pathname` is exempt for every account with a step left (ONBOARDING_EXEMPT_PATHS). */
export function isOnboardingExempt(pathname: string): boolean {
  return ONBOARDING_EXEMPT_PATHS.some((root) => isUnder(pathname, root));
}

/** Whether `pathname` is a page exempt for a login-only action (ONBOARDING_EXEMPT_PAGES). */
export function isOnboardingExemptPage(pathname: string): boolean {
  return ONBOARDING_EXEMPT_PAGES.some((page) => isRoutePage(pathname, page.route));
}

/**
 * Whether what is left of the account's onboarding is a re-consent alone: it finished the
 * onboarding once — its 본인확인 and nickname are done, and it agreed to the required items before
 * (`isReconsent`) — and a revision that changed members' rights has since asked for the consent
 * again (#57-5). Not an account that agreed and left before its 본인확인 and then met a revision:
 * it never finished, and has nothing it did as a member to take back.
 */
export function hasOnlyReconsentLeft(onboarding: Onboarding | undefined): boolean {
  return (
    onboarding !== undefined &&
    onboarding.verification &&
    onboarding.nickname &&
    isReconsent(onboarding)
  );
}

/**
 * Whether `GET /me` names an onboarding step left (`onboarding` as `needsOnboarding` reads it):
 * false while it is not known, true for any of the three required steps or a re-consent.
 */
export function hasOnboardingStepLeft(onboarding: Onboarding | undefined): boolean {
  return onboarding !== undefined && onboarding.nextStep !== null;
}

/**
 * Whether the gate sends this page to /onboarding. `onboarding` is what `GET /me` said:
 * - `undefined` — not known: no session, the session or `/me` still pending, or `/me` failed.
 *   Never redirect on a guess; an onboarded member must not be bounced while it loads.
 * - a next step — signed in, with that step (and maybe more) left: one of the three required ones,
 *   or the consent again after a revision that asked for it (#57-5). Never the interest categories:
 *   the onboarding screen shows them once, and leaving is skipping them (오너 결정 2026-10-19 (2차) 5).
 * - `nextStep: null` — nothing to do.
 * Every account with a step left stays on the auth and legal screens (ONBOARDING_EXEMPT_PATHS);
 * one with a re-consent alone left stays on a page of a login-only action too
 * (ONBOARDING_EXEMPT_PAGES, `hasOnlyReconsentLeft`).
 */
export function needsOnboarding(pathname: string, onboarding: Onboarding | undefined): boolean {
  if (!hasOnboardingStepLeft(onboarding) || isOnboardingExempt(pathname)) return false;
  return !(isOnboardingExemptPage(pathname) && hasOnlyReconsentLeft(onboarding));
}

/**
 * Where an entry to a form on an exempt page goes (오너 결정 2026-10-20: 글쓰기·수정, later the
 * comment boxes): the form's page `target` (pathname + search) for an account with nothing left,
 * or — with a step left (a re-consent: no other account stays on the page) — that step, which
 * comes back to `target` once done (#57-9). While the onboarding is not known the entry is the
 * form's own page, whose gate decides when it is.
 */
export function onboardingEntryPath(target: string, onboarding: Onboarding | undefined): string {
  return hasOnboardingStepLeft(onboarding) ? onboardingPath(target) : target;
}

/** The path part of a same-origin destination, percent-decoded for comparison. */
function pathOf(path: string): string {
  const { pathname } = new URL(path, 'https://x.invalid');
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Where /onboarding returns to (#57-9: the page the account was on before it signed up or was
 * sent here): `?next=` if it is a path on this origin (`safeNextPath` — no `https://…`, `//host`,
 * backslash or control-character tricks), otherwise home. Never /onboarding itself: an account
 * with nothing left is sent straight on to `next`, so a `next` pointing back at the gate would
 * bounce between the two for ever.
 */
export function onboardingNext(next: string | string[] | null | undefined): string {
  const safe = safeNextPath(next);
  return isUnder(pathOf(safe), ONBOARDING_PATH) ? '/' : safe;
}

/**
 * The gate's destination for a page at `path` (pathname + search): `/onboarding?next=<path>`,
 * or bare `/onboarding` when there is nowhere better than home to come back to.
 */
export function onboardingPath(path: string): string {
  const next = onboardingNext(path);
  return next === '/' ? ONBOARDING_PATH : `${ONBOARDING_PATH}?next=${encodeURIComponent(next)}`;
}

/**
 * The page the gate is leaving, with its query string: `pathname` from `usePathname()` and
 * `search` from `window.location`. The root layout cannot call `useSearchParams` without a
 * Suspense boundary around every page (see nav.tsx `CategoryNav`), so the query string is read
 * from the location when the redirect fires — and only kept while the location is still the
 * page the router reports, so a navigation racing the effect can never borrow another page's.
 */
export function gatedPagePath(pathname: string, location: { pathname: string; search: string }) {
  return location.pathname === pathname ? `${pathname}${location.search}` : pathname;
}

// ---- the stepper ----------------------------------------------------------------------

/**
 * What /onboarding shows, in the owner's order (ADR-0069 decision 4 #58 and #57-7·#57-10): 약관
 * 동의 → 본인확인 → 닉네임 설정, then — the server having granted the start Coin with the nickname
 * step — the notice about it, then the interest categories, which can be skipped.
 *
 * The first three are the server's (`onboarding.nextStep`). The notice and the interests follow
 * the nickname step on the same visit to the screen, and only then: the server records neither
 * the notice (it says what the nickname step's answer, `startGrant`, and two fixed facts say) nor
 * that the interests were shown, and an account that left at either has skipped the interests —
 * the gate does not send it back, and /onboarding opened again goes straight on (오너 결정
 * 2026-10-19 (2차) 5: the interest step is shown once). The stepper tells the server that skip as
 * the account leaves (`leavingSkipsInterests`, owner decision 2026-10-21 (2nd) answer 2,
 * ADR-0078), so the step's first answer — which a restriction lets through — is the screen's own,
 * and the server takes it as one within 24 hours of the nickname step only (owner decision
 * 2026-10-21 (3rd) answer 1).
 */
export const ONBOARDING_SCREENS = [
  'consent',
  'verification',
  'nickname',
  'notice',
  'interests',
] as const;
export type OnboardingScreen = (typeof ONBOARDING_SCREENS)[number];

/** What the stepper remembers of the visit, beside `GET /me`. */
export interface StepperVisit {
  /**
   * The nickname step was the server's next step during this visit: the three steps were finished
   * on it (or in another tab meanwhile), so the notice and the interests follow. An account that
   * arrives with the three done — it left at the notice or the interests, or it comes back for a
   * re-consent — is not shown them.
   */
  readonly reachedNickname: boolean;
  /** The notice was read (its 다음). */
  readonly noticeRead: boolean;
}

/**
 * The screen for an account whose `GET /me` says `onboarding`, on a visit that went as `visit`
 * says, or null with nothing left — then the stepper goes on to `next`.
 */
export function onboardingScreen(
  onboarding: Onboarding,
  visit: StepperVisit,
): OnboardingScreen | null {
  if (onboarding.nextStep !== null) return onboarding.nextStep;
  if (!visit.reachedNickname || onboarding.interests) return null;
  return visit.noticeRead ? 'interests' : 'notice';
}

/**
 * Whether leaving the stepper now skips the interests step (ADR-0072: leaving the start-Coin notice
 * or the interests screen is skipping it), so the server is to be told (owner decision 2026-10-21
 * (2nd) answer 2, ADR-0078): the screen is one of those two and no answer of the step is on its
 * way (`answering` — the pick or the 건너뛰기 sent; it answers the step itself). Any other screen
 * has not reached the step — or, null, has nothing left to show: the step answered.
 */
export function leavingSkipsInterests(
  screen: OnboardingScreen | null,
  answering: boolean,
): boolean {
  return (screen === 'notice' || screen === 'interests') && !answering;
}

/** Whether `to` comes before `from` among the screens: the server sent the account back. */
export function isStepBack(from: OnboardingScreen | null, to: OnboardingScreen | null): boolean {
  if (from === null || to === null) return false;
  return ONBOARDING_SCREENS.indexOf(to) < ONBOARDING_SCREENS.indexOf(from);
}

/**
 * A consent step the account has done before: it agreed to a required item once, and a revision
 * that changed members' rights has since left that agreement behind (#57-5) — the step it is on
 * is a re-consent, not its first.
 */
export function isReconsent(onboarding: Onboarding): boolean {
  return (
    !onboarding.consent &&
    onboarding.consents.some((answer) => answer.agreed && CONSENT_DOCUMENTS[answer.item].required)
  );
}

/**
 * Why the stepper shows the step it shows rather than a later one (오너 결정 2026-10-19 (2차) 6),
 * said above the step's heading:
 * - `reconsent`: the consent step of an account that agreed before — '약관이 바뀌어 다시 동의가
 *   필요합니다.' — whether the gate brought it here or the stepper was sent back to it;
 * - `earlier_step`: any other screen the server sent the account back to from a later one
 *   (`sentBack`: the step done in another tab came undone, a write was refused because one before
 *   it is not done) — '앞 단계를 먼저 마쳐 주세요.';
 * - null: the account is where it was going.
 */
export type OnboardingReturnReason = 'reconsent' | 'earlier_step';

export function onboardingReturnReason(
  onboarding: Onboarding,
  screen: OnboardingScreen | null,
  sentBack: boolean,
): OnboardingReturnReason | null {
  if (screen === 'consent' && isReconsent(onboarding)) return 'reconsent';
  return sentBack && screen !== null ? 'earlier_step' : null;
}

/**
 * Whether the stepper offers the way to MY 설정 (오너 결정 2026-10-22 답 2, ADR-0078: «재동의 단계
 * 화면에 MY 설정 링크»): on the consent step of an account facing a re-consent alone — the one account
 * that MY 설정 is open to with a step left (`ONBOARDING_EXEMPT_PAGES`, `hasOnlyReconsentLeft`), where
 * it clears its public profile's items and keeps its account cards before agreeing again. Never on
 * a first onboarding — nor on the re-consent of an account that left before its 본인확인, which MY
 * 설정 would send straight back — and never on another step.
 */
export function settingsLinkOnStep(
  onboarding: Onboarding,
  screen: OnboardingScreen | null,
): boolean {
  return screen === 'consent' && hasOnlyReconsentLeft(onboarding);
}

/**
 * The account's onboarding once its 본인확인 is confirmed: the confirmation answers the record,
 * not the whole `Me`, so the step is marked here — through the same `onboardingState` the server
 * answers with, so `completed` and `nextStep` cannot be worked out differently. What the stepper
 * moves on with (`storeVerification`, hooks/use-phone-verification.ts). A verified account's
 * onboarding is returned as it is: the real-name card writes through the same path.
 */
export function afterVerification(onboarding: Onboarding): Onboarding {
  if (onboarding.verification) return onboarding;
  const consents: readonly ConsentRecord[] = onboarding.consents;
  const next: SharedOnboarding = onboardingState(
    {
      consent: onboarding.consent,
      verification: true,
      nickname: onboarding.nickname,
      interests: onboarding.interests,
    },
    consents,
  );
  return next;
}

/** The onboarding writes whose answer (a whole `Me`) goes into `['me']`. */
export type OnboardingWrite = 'consent' | 'nickname' | 'interests';

/**
 * What `['me']` takes from an onboarding write's answer: only what that write changed, as
 * `storeMe` (hooks/use-me.ts) takes only its own field — the answer is a snapshot of the whole
 * account read after the write, and taking the rest could put an older balance back over a
 * `user:balance` event that already landed (realtime-provider.tsx).
 * - the consent step: `onboarding`;
 * - the nickname step: `onboarding`, the nickname and when it may change next, and `startGrant`,
 *   which the notice screen shows (#57-10). The balance the grant moved is not taken here: the
 *   caller asks `GET /me` again for it (`storeOnboardingAnswer`);
 * - the interest categories: `onboarding` and the account's categories.
 */
export function takeOnboardingAnswer(held: Me, answer: Me, write: OnboardingWrite): Me {
  switch (write) {
    case 'consent':
      return { ...held, onboarding: answer.onboarding };
    case 'nickname':
      return {
        ...held,
        onboarding: answer.onboarding,
        startGrant: answer.startGrant,
        profile: {
          ...held.profile,
          nickname: answer.profile.nickname,
          nicknameChangeAvailableAt: answer.profile.nicknameChangeAvailableAt,
        },
      };
    case 'interests':
      return {
        ...held,
        onboarding: answer.onboarding,
        profile: { ...held.profile, interestCategoryIds: answer.profile.interestCategoryIds },
      };
  }
}

/**
 * What the notice screen says of the start Coin (#57-10), from the nickname step's answer
 * (`Me.startGrant`, ADR-0071):
 * - `granted`: the amount paid;
 * - `pending`: the amount is undecided (the release setting 시작 지급액 has no value), and the
 *   owner's sentence stands where the amount would (decision 4 #70: everything else the same);
 * - `number_used`: the verified number's start Coin went to an earlier account (#57-1, #57-17),
 *   and the owner's sentence says so where the amount would (오너 결정 2026-10-19, ADR-0072);
 * - `none`: no word from the server on it (`startGrant` null — not after a nickname step that
 *   completed, which always answers one of the above): the screen leaves the amount out and says
 *   the rest rather than guess.
 */
export type StartGrantNotice =
  | { kind: 'granted'; amountCoin: bigint }
  | { kind: 'pending' }
  | { kind: 'number_used' }
  | { kind: 'none' };

export function startGrantNotice(startGrant: Me['startGrant']): StartGrantNotice {
  if (startGrant === null) return { kind: 'none' };
  if (startGrant.status === 'number_used') return { kind: 'number_used' };
  if (startGrant.status === 'granted' && startGrant.amountCoin !== null) {
    return { kind: 'granted', amountCoin: BigInt(startGrant.amountCoin) };
  }
  return { kind: 'pending' };
}

// ---- the interest categories ------------------------------------------------------------

/**
 * `picked` with `id` checked or not. The interests step picks top-level and sub-categories alike
 * and as many as the member likes (#57-7 «상위 및 하위 카테고리, 상한 없음»): a top-level category
 * is a choice of its own, not a shortcut for its sub-categories.
 */
export function withInterest(
  picked: ReadonlySet<number>,
  id: number,
  checked: boolean,
): ReadonlySet<number> {
  const next = new Set(picked);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * The ids an interests write is sent (the step's `POST /me/onboarding/interests`, MY 설정's
 * `PUT /me/interest-categories`): what is picked among the categories on screen
 * (one retired since the list loaded is not there to pick, and one picked before a reload that no
 * longer lists it is dropped), in id order — the order `Me.profile.interestCategoryIds` answers in.
 * Empty is the step's skip (#57-7), or MY 설정's dropping them all.
 */
export function interestIds(
  picked: ReadonlySet<number>,
  categories: readonly { id: number }[],
): number[] {
  return categories
    .map((category) => category.id)
    .filter((id) => picked.has(id))
    .sort((a, b) => a - b);
}
