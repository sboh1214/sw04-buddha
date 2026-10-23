import * as z from 'zod';
import { coinAmountSchema } from './api/coin-amount.js';
import { NO_EMAIL_DOMAIN } from './constants.js';
import { restrictedDetailsSchema } from './moderation.js';

/**
 * 탈퇴 (#140, ADR-0069 decision 1 #57-15…#57-18, decision 3 #37-15…#37-17, decision 4 #140 rows
 * and decision 7): the member closes their own account — deactivation, withdrawal and closure are
 * one thing (#57-15). Only the member does it: no operator closes an account for them and nothing
 * restores one (#57-17). It happens at once on the one confirmation (#57-17, decision 4 #140 «마지막
 * 확인»): the Coin left is forfeited (`CLOSURE_FORFEIT`, '탈퇴 소멸', #57-16), the identifying data
 * goes and the public face is anonymised — the author shown as '탈퇴한 사용자' with no profile link,
 * the profile address answering as for no account (#37-16), the posts, comments and likes kept
 * (#37-17) — while the ledger, the orders, fills and positions and every operator record stay.
 *
 * Refused while the account holds the admin role (#57-17: closed only after the role is revoked),
 * holds contracts not settled (#57-16), has a payment pending or refunding (decision 7), has orders
 * waiting (their cancellation is #178's), or a writing or an account restriction stands (decision 4
 * #140 «제재 중 탈퇴»: RESTRICTED, until it ends or is lifted).
 */

/** What the member types to confirm, exactly (decision 4 #140 «'탈퇴'를 직접 입력해 한 번 확인한다»). */
export const ACCOUNT_CLOSURE_CONFIRMATION = '탈퇴';

/**
 * The reason a two-person request about a closing member is closed with (owner decision
 * 2026-10-23, ADR-0085 결과 5: «탈퇴 때 그 요청은 저절로 닫음(거절로 기록, 까닭 '탈퇴')»): rejected
 * by no admin, at the closure.
 */
export const ACCOUNT_CLOSURE_DECISION_REASON = '탈퇴';

/**
 * The address a closed account's `user.email` is replaced with: the member's address is deleted at
 * once (#57-18) and freed for a new sign-up (#57-17 «같은 이메일·소셜 로그인·번호로 곧바로 다시 가입»),
 * while better-auth's column cannot be empty and stays unique. On the service's own unroutable
 * domain (NO_EMAIL_DOMAIN): never mailed (`isNoEmailAddress`), and the credential endpoints refuse
 * it, so nobody signs in with it or claims it. Keyed by the account id — one per account, and the
 * same however often the closure is asked.
 */
export function closedAccountEmail(userId: string): string {
  return `closed_${userId}@${NO_EMAIL_DOMAIN}`;
}

/** The account the screen shows (better-auth `user.id`, text), as every owner write carries. */
const expectedAccountIdSchema = z.string().min(1).max(255);

/**
 * `POST /me/closure`: the typed confirmation — exactly '탈퇴', blanks around it aside — and the
 * account the screen shows (`expectedAccountId`): the cookie decides whose account closes, and a
 * window still showing account A after another one signed in as B would otherwise close B. The
 * server refuses a mismatch (403 FORBIDDEN naming the field) before it reads anything.
 */
export const accountClosureBodySchema = z
  .object({
    confirmation: z.string().trim().pipe(z.literal(ACCOUNT_CLOSURE_CONFIRMATION)),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'AccountClosureBody' });
export type AccountClosureBody = z.infer<typeof accountClosureBodySchema>;

/**
 * Why a closure is refused (CLOSURE_NOT_ALLOWED), in the order the closure asks:
 * - `admin`: the account holds the admin role — closed only after it is revoked (#57-17, with at
 *   least two admins, ADR-0056);
 * - `unsettled_contracts`: a contract it holds is not settled yet (#57-16: not until all are);
 * - `payment_in_progress`: a payment of the kept paid-Coin code (D9) is pending or refunding
 *   (ADR-0069 decision 7: never today, sales being closed);
 * - `pending_orders`: an order of it still waits — their cancellation before a closure (N02 §9) is
 *   #178's, and until it is there the closure never forfeits a reserved Coin (none can exist
 *   today: there is no order intake).
 * A writing or an account restriction refuses it as RESTRICTED, with its kind and end.
 */
export const ACCOUNT_CLOSURE_REFUSALS = [
  'admin',
  'unsettled_contracts',
  'payment_in_progress',
  'pending_orders',
] as const;
export type AccountClosureRefusal = (typeof ACCOUNT_CLOSURE_REFUSALS)[number];
export const accountClosureRefusalSchema = z
  .enum(ACCOUNT_CLOSURE_REFUSALS)
  .meta({ id: 'AccountClosureRefusal' });

/** CLOSURE_NOT_ALLOWED's details: the first reason the closure met. */
export const accountClosureNotAllowedDetailsSchema = z
  .object({ reason: accountClosureRefusalSchema })
  .meta({ id: 'AccountClosureNotAllowedDetails' });
export type AccountClosureNotAllowedDetails = z.infer<typeof accountClosureNotAllowedDetailsSchema>;

/**
 * `GET /me/closure`: what the confirmation screen says before the member types anything — the Coin
 * the closure would forfeit now (the available balance; reserved Coin cannot exist without orders)
 * and whatever refuses it now: the reasons in the order the closure asks them, and the restriction
 * it would answer RESTRICTED with (the later of the two when both stand, as every refusal names
 * it), or none — and whether the account's start Coin was paid (`startGrantReceived`, owner
 * decision 2026-10-23 (3차) 9, ADR-0086): only then does the screen say that the same number gets
 * no start Coin again on a new sign-up (#57-1). A grant still waiting is cancelled by the closure
 * and its number may receive the start Coin with the next account (owner decision 2026-10-18 on
 * #70), and an account that never had one (none asked yet, or its number's went to another
 * account — `number_used`) is told nothing either. Read as of now: the closure asks everything
 * again in its own transaction.
 */
export const accountClosureCheckSchema = z
  .object({
    availableCoin: coinAmountSchema,
    refusals: z.array(accountClosureRefusalSchema),
    restriction: restrictedDetailsSchema.nullable(),
    /** The account's start grant was paid (`granted`): its number never gets one again. */
    startGrantReceived: z.boolean(),
  })
  .meta({ id: 'AccountClosureCheck' });
export type AccountClosureCheck = z.infer<typeof accountClosureCheckSchema>;

/**
 * `POST /me/closure`'s answer: when the account closed and the Coin forfeited with it ('0' when
 * there was none — then no ledger entry was written). The same answer for a request that comes
 * while the first one closes it (the closure runs once): the sessions are gone from the commit, so
 * every later request is UNAUTHENTICATED.
 */
export const accountClosureResultSchema = z
  .object({
    closedAt: z.iso.datetime(),
    forfeitedCoin: coinAmountSchema,
  })
  .meta({ id: 'AccountClosureResult' });
export type AccountClosureResult = z.infer<typeof accountClosureResultSchema>;
