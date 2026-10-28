import * as z from 'zod';
import { NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH } from './constants.js';

/**
 * Nickname charset (PLAN 17 Q4 default + `_`): Hangul syllables, ASCII letters, digits and
 * underscore. The underscore is required because the auto nickname is `user_XXXX` (PLAN
 * 10.4; prefix from ADR-0052). Recorded as QUESTIONS A-M1 assumption. Uniqueness ignores case
 * (#57-6, below): the database's unique index is on `lower(nickname)`.
 */
export const NICKNAME_PATTERN = /^[A-Za-z0-9가-힣_]+$/;

/**
 * A nickname's format, which every stored nickname has — the auto nickname too. What a member may
 * choose is narrower (`nicknameRuleViolation` below).
 */
export const nicknameSchema = z
  .string()
  .min(NICKNAME_MIN_LENGTH)
  .max(NICKNAME_MAX_LENGTH)
  .regex(NICKNAME_PATTERN, 'only Korean, letters, digits and _')
  .meta({ id: 'Nickname' });

/**
 * 닉네임 규칙 (#58, ADR-0069 decision 1 #57-6 and #37-16) beyond the format of `nicknameSchema`
 * (2–20 Hangul, Latin letters, digits and `_`, me.ts), in one place for the API, which enforces
 * them, and the web's forms, which say the same before sending:
 *
 * - Uniqueness ignores case: 'Abc' taken keeps 'abc' out (`nicknameKey`; the database's unique
 *   index is on `lower(nickname)`).
 * - A nickname a member types may not start with the auto nickname's prefix `user_` nor contain a
 *   word that passes for the operators (NICKNAME_RESERVED_WORDS), both ignoring case, the words
 *   also with underscores put between their letters (`nicknameRuleViolation`). The auto nickname
 *   itself (`user_XXXX`, ADR-0052) stays: the onboarding's nickname step offers it, and confirming
 *   it unchanged sets the nickname. Every other nickname an account already has — an admin's, the
 *   seed's 관리자 included — meets the same rules there (`keptNicknameViolation`).
 * - Look-alikes ('adm1n', '0fficial') are not refused: reports take care of impersonation
 *   (오너 결정 2026-10-19 (2차) 7, ADR-0072).
 * - After the onboarding a nickname changes once in NICKNAME_CHANGE_INTERVAL_DAYS; the onboarding's
 *   choice is not a change.
 * - A nickname a change (or a withdrawal, #140) gave up is held for NICKNAME_HOLD_DAYS: no other
 *   account takes it meanwhile, the auto nickname included.
 *
 * Fixed values of the owner's decision, not release settings (docs/SETTINGS.md).
 */

/** The prefix of the auto nickname (ADR-0052): `user_` and four characters. */
export const AUTO_NICKNAME_PREFIX = 'user_';

/**
 * The auto nickname as the sign-up trigger draws it (ADR-0052, migrations 0019 and 0032): the
 * prefix and four of its 32 unambiguous upper-case letters and digits (no 0/O/1/I). Exactly that
 * shape, so `user_kim` typed through MY 설정 before #58 is not mistaken for one.
 */
export const AUTO_NICKNAME_PATTERN = /^user_[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;

/**
 * The 32 characters the auto nickname's four are drawn from (ADR-0052, the trigger's alphabet):
 * an operator giving a member's nickname back to an auto nickname draws from it too (#50, #37-10).
 */
export const AUTO_NICKNAME_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** The number of characters after the prefix. */
export const AUTO_NICKNAME_SUFFIX_LENGTH = 4;

/** Whether `nickname` has the shape of the auto nickname the trigger gives (ADR-0052). */
export function isAutoNickname(nickname: string): boolean {
  return AUTO_NICKNAME_PATTERN.test(nickname);
}

/**
 * Words a nickname a member types may not contain, ignoring case: they pass for the operators
 * (#57-6 «운영자·관리자·운영팀·공식·admin·buddha 등»). Contained anywhere — '공식' keeps
 * '비공식' out too, as the owner's rule reads — and with underscores between their letters too
 * ('관_리_자', 'ad_min'): the underscore is the charset's only separator, and a word spread over
 * it still reads as the word (ADR-0072 7-24). Nothing else is normalised: look-alikes with digits
 * for letters ('adm1n', '0fficial') are not blocked — reports take care of impersonation (오너
 * 결정 2026-10-19 (2차) 7). Extending it is adding a word here.
 */
export const NICKNAME_RESERVED_WORDS = [
  '운영자',
  '관리자',
  '운영팀',
  '공식',
  'admin',
  'buddha',
] as const;

/** A nickname changes at most once in this many days after the onboarding (#57-6). */
export const NICKNAME_CHANGE_INTERVAL_DAYS = 30;

/** A nickname given up stays out of other accounts' reach for this many days (#57-6, #37-16). */
export const NICKNAME_HOLD_DAYS = 30;

/**
 * What uniqueness compares: the nickname with its Latin letters in lower case. The charset holds
 * no other cased letter (Hangul has no case), so this is Postgres's `lower()` on the same value.
 */
export function nicknameKey(nickname: string): string {
  return nickname.toLowerCase();
}

/** Why a nickname a member typed breaks the rules, whatever the database holds. */
export const NICKNAME_RULE_VIOLATIONS = ['auto_prefix', 'reserved_word'] as const;
export type NicknameRuleViolation = (typeof NICKNAME_RULE_VIOLATIONS)[number];

/**
 * The rule a nickname a member typed breaks, or null. The prefix is read on the nickname as it is
 * ('my_user_1' is fine); the reserved words with its underscores taken out ('관_리_자' is
 * '관리자'). For a nickname the member chose: what the onboarding's nickname step confirms as it
 * is follows `keptNicknameViolation`.
 */
export function nicknameRuleViolation(nickname: string): NicknameRuleViolation | null {
  const key = nicknameKey(nickname);
  if (key.startsWith(AUTO_NICKNAME_PREFIX)) return 'auto_prefix';
  const joined = key.replaceAll('_', '');
  if (NICKNAME_RESERVED_WORDS.some((word) => joined.includes(word.toLowerCase()))) {
    return 'reserved_word';
  }
  return null;
}

/**
 * The rule the onboarding's nickname step finds broken when the account confirms the nickname it
 * already has, or null (ADR-0072 7-25). The owner's rule (#57-6) lets the offered auto nickname be
 * confirmed as it is, and holds every other nickname to `nicknameRuleViolation` — one typed
 * through MY 설정 before #58, which met only the format, and an admin's (the seed named its admins
 * 관리자, 관리자2) alike: the step refuses it and asks for another (오너 결정 2026-10-19 (2차) 2).
 * The API and the web's nickname step apply this same function.
 */
export function keptNicknameViolation(nickname: string): NicknameRuleViolation | null {
  if (isAutoNickname(nickname)) return null;
  return nicknameRuleViolation(nickname);
}

/**
 * Why a nickname was refused (`NICKNAME_NOT_ALLOWED`):
 * - `auto_prefix`, `reserved_word`: the rules above;
 * - `taken`: another account has it (ignoring case) or gave it up less than NICKNAME_HOLD_DAYS ago
 *   — one answer for both, so nobody learns from it that a nickname changed hands recently (#37-3
 *   keeps former nicknames out of sight);
 * - `change_interval`: the account changed its nickname less than NICKNAME_CHANGE_INTERVAL_DAYS
 *   ago; `nextChangeAt` says when it can again;
 * - `already_set`: the onboarding's nickname step is done, with another nickname — a change is
 *   `PATCH /me`, under the interval.
 */
export const NICKNAME_REFUSALS = [
  'auto_prefix',
  'reserved_word',
  'taken',
  'change_interval',
  'already_set',
] as const;
export type NicknameRefusal = (typeof NICKNAME_REFUSALS)[number];
export const nicknameNotAllowedDetailsSchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.enum(['auto_prefix', 'reserved_word', 'taken', 'already_set']) }),
  z.object({ reason: z.literal('change_interval'), nextChangeAt: z.iso.datetime() }),
]);
export type NicknameNotAllowedDetails = z.infer<typeof nicknameNotAllowedDetailsSchema>;
