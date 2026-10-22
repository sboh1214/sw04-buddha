import { type Db } from '@buddha/db';
import { type RestrictedDetails } from '@buddha/shared';
import { restrictedError, writingRestrictionOf } from '../moderation/restrictions.js';
import { assertOnboarded } from '../onboarding/onboarded.guard.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/**
 * What a write does to a public profile item (#41, ADR-0069 decision 3 #37-9 and decision 7) —
 * the nickname, the 소개, the image (#141) and the interest categories:
 * - `replace`: gives it a new value — a nickname change, a 소개 with text, a category the account
 *   did not have among its picks, a new image;
 * - `clear`: takes a value away and adds none — the 소개 emptied, categories dropped, the image
 *   deleted;
 * - `first`: the account's first choice of it inside the onboarding's screens — the nickname step
 *   and the interests step's first answer (picks or the skip, `POST /me/onboarding/interests` while
 *   `interests_answered_at` is null, within INTERESTS_FIRST_ANSWER_WINDOW_HOURS — 24 — of the
 *   nickname step) — which is not a change (owner decision 2026-10-21 answer 4, ADR-0078: «처음
 *   고르는 것은 허용»). Only those screens' writes: an account that left the start-Coin notice or the
 *   interests screen without answering skipped the step, the screen tells the server so, and MY
 *   설정's first pick is a change (`replace`) however it left (owner decision 2026-10-21 (2nd) answer
 *   2: «온보딩 화면 안의 첫 선택만 허용»); and past the window the step's own picks are one too, for an
 *   account whose leaving the server never heard of (3rd answer 1: «닉네임 확정 뒤 24시간 안에만»).
 * A write that changes nothing is none of them: its caller returns before asking.
 */
export type PublicItemEdit = 'replace' | 'clear' | 'first';

/**
 * The sanction that stops public-item edits in force on the account, or null: a writing
 * restriction (작성 제한, #185) or an account restriction (계정 제한, #139), either of which keeps
 * the public items from new values (#37-9) — its kind and its end (null: 무기한), which the refusal
 * carries. Read inside the caller's transaction, after it locked the profile row, so the answer
 * holds until the write commits: an operator's restriction locks that row before it is written.
 */
export type SanctionCheck = (
  executor: Executor,
  userId: string,
) => Promise<RestrictedDetails | null>;

/**
 * The writing restriction in force (#185, ADR-0082: `writingRestrictionOf`, the same answer every
 * post, comment and edit reads) — the one place a sanction answers for every public-item write
 * (#41's scope: «두 이슈 가운데 이 이슈보다 늦게 끝나는 쪽은 제한 중 프로필 수정 차단 … 의 적용도
 * 맡는다»). #139's account restriction answers here too once it is stacked: the later of the two
 * ends, the one the member waits for.
 */
export const sanctionInForce: SanctionCheck = writingRestrictionOf;

/**
 * The one check point of every public profile item write (#37-9, decision 7): under a writing or
 * an account restriction a public item cannot take a new value — the nickname cannot change — but
 * can be cleared, which stays open whatever the sanction. The onboarding's first choices pass too
 * (owner decision 2026-10-21 answer 4, `first`): only MY 설정's values are kept back, its first pick
 * of interest categories included. The restriction never closes the profile itself (#37-9: «그대로
 * 열린다»), nor a private setting such as the time zone, which never asks.
 *
 * Callers: the onboarding's nickname step (`POST /me/onboarding/nickname`, OnboardingService,
 * always `first`), the nickname change (`PATCH /me`, NicknameService), the 소개 (`PUT /me/bio`,
 * MeService), the interests step (`POST /me/onboarding/interests`, OnboardingService — `first`
 * while the step is unanswered, within 24 hours of the nickname step), MY 설정's interest
 * categories (`PUT /me/interest-categories`, OnboardingService — never `first`) and the image
 * (#141, ProfileImageService: `replace` for an upload — asked before the conversion too — and
 * `clear` for a deletion). `sanctioned` is the lookup — `sanctionInForce` but in unit tests.
 *
 * The refusal is RESTRICTED (403) with the sanction's kind and end (`RestrictedDetails`, null for
 * 무기한): a code of its own rather than a plain FORBIDDEN, so the screen says what stays closed
 * until when — «…(…까지).» or «…(무기한).» — with the way to 조치·신고 내역 under it, where the
 * appeal is (owner decision 2026-10-21 answer 8, ADR-0078 결과 5, as the owner's 2026-10-22
 * evening answer words it: «끝나는 시각과 조치·신고 내역 링크(기한은 내역에)»; #185, ADR-0082).
 */
export async function assertPublicItemEdit(
  executor: Executor,
  userId: string,
  edit: PublicItemEdit,
  sanctioned: SanctionCheck = sanctionInForce,
): Promise<void> {
  if (edit !== 'replace') return;
  const sanction = await sanctioned(executor, userId);
  if (sanction !== null) throw restrictedError(sanction);
}

/**
 * The onboarding a public profile item write needs (#57-8; owner decision 2026-10-21 answer 2,
 * ADR-0078): a new value — and the interests step's own first answer, which is the onboarding's
 * step after the three — waits for the three steps (ONBOARDING_REQUIRED naming those missing, as
 * OnboardedGuard says it), while a clearing passes with sign-in only. So an account the consent
 * step holds back after a revision that changed members' rights (재동의) still takes its 소개 and
 * its categories off its public profile without agreeing first, as it deletes its own comment. A
 * write that only clears has something to clear only once the onboarding was done before, so a new
 * account gains nothing by it.
 *
 * Why not OnboardedGuard on the routes: a guard runs before the body is read, and whether a write
 * clears is known only against what the account has, read under the write's lock — this is asked
 * there, in the write's transaction, before the sanction (`assertPublicItemEdit`), so an account
 * that has to finish the onboarding hears that first. Callers: `PUT /me/bio` (MeService),
 * `POST /me/onboarding/interests` (OnboardingService, the interests step's answer),
 * `PUT /me/interest-categories` (OnboardingService) and the profile image (#141,
 * ProfileImageService) — whose deletion is open the same way (owner decision 2026-10-22, ADR-0079:
 * as the 소개 and the categories of the owner's 2026-10-21 answer 2 on #41), while its upload,
 * always a new value, also has OnboardedGuard on the route: the upload's body is the file, and the
 * guard refuses before the conversion is paid for.
 */
export async function assertPublicItemOnboarding(
  executor: Executor,
  userId: string,
  edit: PublicItemEdit,
): Promise<void> {
  if (edit === 'clear') return;
  await assertOnboarded(executor, userId);
}
