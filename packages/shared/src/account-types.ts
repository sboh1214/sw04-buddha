import { NO_EMAIL_DOMAIN } from './constants.js';
import type { AccountType } from './enums.js';

/**
 * 사람 계정 판별 (#115, ADR-0107 결정 4 #115 and 결정 2 #73 11항, N04 §2·§5): the one rule that
 * says whether an account is a person's. Its SQL form is `is_human_account_type(type)` and, by
 * account id, `is_human_account(id)` (migration 0059), which `isHumanAccountTypeSql` and
 * `isHumanAccountSql` in @buddha/db write; the schema test keeps the three in agreement.
 */

/** The human ('일반 사용자') type: the only one the rule answers true for. */
const HUMAN_ACCOUNT_TYPE = 'member' satisfies AccountType;

/**
 * Whether an account of `type` is a person's (사람 계정). Every count and check of people asks
 * this and nothing else: participants and volume (#121, #177 13항), '사용자 체결 0건' (#20·#120),
 * the start grant, a public profile and public activity (#73 11항), the market maker's self-trade
 * group (#117, `sameSelfTradeGroup` in matching.ts), the order rate limit's exclusion (#119), a 판정
 * 이의's eligibility (#175). The admin role is not looked at (#177 13항: an admin is a person), and a
 * closed account stays a person; nothing else — role, nickname, email, onboarding, closure —
 * decides it.
 */
export function isHumanAccountType(type: AccountType): boolean {
  return type === HUMAN_ACCOUNT_TYPE;
}

/**
 * The 운영 마켓메이커 account's `user.email` (#73 11항: no login method): on the service's own
 * unroutable domain, so the mailer never sends to it and every credential endpoint refuses it
 * (`isNoEmailAddress`). Its local part has no '_', so it never equals a social placeholder
 * (`{provider}_{id}`) or a closed account's (`closedAccountEmail`).
 */
export const MARKET_MAKER_ACCOUNT_EMAIL = `market-maker@${NO_EMAIL_DOMAIN}`;
