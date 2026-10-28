import { type Db } from '@buddha/db';
import { AppError } from '../common/errors/app-error.js';
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
 * Whether a sanction that stops public-item edits is in force on the account: a writing
 * restriction (작성 제한, #185) or an account restriction (계정 제한, #139), either of which keeps
 * the public items from new values (#37-9). Read inside the caller's transaction, after it locked
 * the profile row, so the answer holds until the write commits.
 */
export type SanctionCheck = (executor: Executor, userId: string) => Promise<boolean>;

/**
 * Neither sanction exists yet: #185 and #139 come later and answer here, from their own records —
 * the one place they have to change for every public-item write to follow (#41's scope: «두 이슈
 * 가운데 이 이슈보다 늦게 끝나는 쪽은 제한 중 프로필 수정 차단 … 의 적용도 맡는다»).
 */
export const sanctionInForce: SanctionCheck = () => Promise.resolve(false);

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
 * while the step is unanswered, within 24 hours of the nickname step) and MY 설정's interest
 * categories (`PUT /me/interest-categories`, OnboardingService — never `first`); the image (#141)
 * joins them. `sanctioned` is the lookup — `sanctionInForce` but in unit tests.
 *
 * The refusal is a 403 FORBIDDEN that names no field (the web tells the other account's cookie by
 * its `expectedAccountId` detail) — until #185 and #139, which give it a code of its own carrying
 * the sanction's end and the notice that one appeals by email (owner decision 2026-10-21 answer 8,
 * ADR-0078 결과 5), with their records; nothing reaches it before them.
 */
export async function assertPublicItemEdit(
  executor: Executor,
  userId: string,
  edit: PublicItemEdit,
  sanctioned: SanctionCheck = sanctionInForce,
): Promise<void> {
  if (edit !== 'replace') return;
  if (await sanctioned(executor, userId)) {
    throw new AppError('FORBIDDEN', {
      message: 'A public profile item cannot take a new value during a restriction',
    });
  }
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
 * `POST /me/onboarding/interests` and `PUT /me/interest-categories` (OnboardingService). Whether
 * the image's deletion (#141) is open the same way is #141's to settle (the answer named the 소개
 * and the categories).
 */
export async function assertPublicItemOnboarding(
  executor: Executor,
  userId: string,
  edit: PublicItemEdit,
): Promise<void> {
  if (edit === 'clear') return;
  await assertOnboarded(executor, userId);
}
