import { APPEAL_WINDOW_DAYS } from '@buddha/shared';

/**
 * Step 2 of the operator's handling of a sanction appeal (#186, ADR-0084; docs/OPERATIONS.md '제재
 * 이의 처리'): the account an appeal mail's sender address belongs to and the actions that member
 * received, run in psql as buddha_app and read only, the way the phone change's step 1 looks up its
 * account (OPERATOR_ACCOUNT_LOOKUP_SQL) — the owner made the two the same judgement (owner decision
 * 2026-10-22 답 5). One psql variable, `sender`, the address the mail came from.
 *
 * - Only an account whose current email is exactly that address (account emails are stored
 *   lower-case). No row: the address is no account's current email, and the mail is unconfirmed —
 *   it uses up no action's one appeal (답 5).
 * - Otherwise one row per action the member received, newest first, or one row with no action
 *   (`action_id` NULL) when there is none: `type` as stored (MODERATION_ACTION_TYPES), `acted_kst`
 *   its time in KST to the second (cut, not rounded), `deadline_kst` the last second an appeal of it
 *   is in time — the minute its deadline (APPEAL_WINDOW_DAYS × 24 hours later, `appealDeadlineOf`)
 *   shows in, to its …:59, as mail received up to then is in time (owner decision 2026-10-23 답 5)
 *   and the member's card turns to '이의 기한이 지났습니다.' once it ends (`appealWindowEndOf`) — and
 *   `cancelled`.
 *
 * Why psql and not `/admin/users`' search (ADR-0084 6-8): that search is a substring match of email
 * and nickname, 20 cards a page with the newest account first, and its term stops at 100
 * characters, so the member's own card can be pages down or past reach. And why the lookup's
 * deadline: every screen shows the minute, and the operator compares the mailbox's arrival time
 * (답 10) with `deadline_kst` — in time when it is not later — rather than adding 14 days to a
 * screen's time by hand.
 *
 * One text in two places, like the phone change's statements: appeal-lookup.test.ts reads
 * docs/OPERATIONS.md for it and runs it against the test database the way psql does.
 */
export const OPERATOR_APPEAL_LOOKUP_SQL = `SELECT u.id AS user_id, a.id AS action_id, a.type,
    to_char(a.created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') AS acted_kst,
    to_char((a.created_at + interval '${String(APPEAL_WINDOW_DAYS * 24)} hours') AT TIME ZONE 'Asia/Seoul',
      'YYYY-MM-DD HH24:MI') || ':59' AS deadline_kst,
    a.cancelled_at IS NOT NULL AS cancelled
  FROM "user" u LEFT JOIN moderation_actions a ON a.user_id = u.id
  WHERE u.email = lower(:'sender')
  ORDER BY a.created_at DESC, a.id DESC;`;
