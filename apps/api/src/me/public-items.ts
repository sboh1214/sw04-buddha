import { type Db } from '@buddha/db';
import { AppError } from '../common/errors/app-error.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/**
 * What a write does to a public profile item (#41, ADR-0069 decision 3 #37-9 and decision 7) —
 * the nickname, the 소개, the image (#141) and the interest categories:
 * - `replace`: gives it a new value — a nickname change, a 소개 with text, a category the account
 *   did not have among its picks, a new image;
 * - `clear`: takes a value away and adds none — the 소개 emptied, categories dropped, the image
 *   deleted.
 * A write that changes nothing is neither: its caller returns before asking.
 */
export type PublicItemEdit = 'replace' | 'clear';

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
 * can be cleared, which stays open whatever the sanction. The restriction never closes the profile
 * itself (#37-9: «그대로 열린다»), nor a private setting such as the time zone, which never asks.
 *
 * Callers: the nickname change (`PATCH /me`, NicknameService), the 소개 (`PUT /me/bio`,
 * MeService) and the interest categories (`PUT /me/interest-categories`, OnboardingService); the
 * image (#141) joins them. `sanctioned` is the lookup — `sanctionInForce` but in unit tests.
 *
 * The refusal is a 403 FORBIDDEN that names no field (the web tells the other account's cookie by
 * its `expectedAccountId` detail). Which code and which details the member hears — the sanction's
 * end and the way to appeal (#139's 본인에게 보일 내용) — are #185's and #139's to settle with
 * their records; nothing reaches it before them.
 */
export async function assertPublicItemEdit(
  executor: Executor,
  userId: string,
  edit: PublicItemEdit,
  sanctioned: SanctionCheck = sanctionInForce,
): Promise<void> {
  if (edit === 'clear') return;
  if (await sanctioned(executor, userId)) {
    throw new AppError('FORBIDDEN', {
      message: 'A public profile item cannot take a new value during a restriction',
    });
  }
}
