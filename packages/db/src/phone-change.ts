/**
 * An operator's change of a member's verified mobile number, as docs/OPERATIONS.md has it run in
 * psql: the member cannot change the number, an operator does it in the database by hand (ADR-0069
 * decision 1 #57-3), and the new number is recorded as one that received the start Coin as well —
 * beside the account's grant, `source` 'operator' — so that a later account verifying it gets
 * nothing (owner decision 2026-10-18, ADR-0071). Three psql variables: `user_id` (the account),
 * `new_phone` (its digits) and `new_hash` (the keyed hash of those digits, from the API's
 * phone-hash CLI, apps/api/src/identity/phone-hash-cli.ts — SQL cannot compute it without the
 * key). The doc runs it only for a request that came from the account's email and whose new
 * number the member confirmed (owner decision 2026-10-19, answer 1; the account is looked up first,
 * OPERATOR_ACCOUNT_LOOKUP_SQL), in one transaction with psql's ON_ERROR_ROLLBACK off, reading
 * the three results first and then ending it with the COMMIT or ROLLBACK the doc's result table
 * gives for them:
 *
 * 1. The number itself, `UPDATE 1` (0: no such account). `phone_verifications.phone` stays UNIQUE
 *    and digits only (its constraints — another account's verified number is a 23505 here), and
 *    `verified_at` keeps the member's own confirmation.
 * 2. The record, `INSERT 0 1` — or `INSERT 0 0`: the account has no grant to record it beside
 *    (not onboarded yet, so its grant records the new number itself when #58 records it; verified
 *    on a number used already, so it got none, and gets one only if the grant is called again —
 *    ADR-0071 결과 4; or withdrawn), or the number's live row is already this grant's or a paid
 *    grant's (another account got the start Coin with it: nothing is missing). The one live row
 *    it does not skip is a WAITING grant's of another account: that number counts only while
 *    that grant waits — its cancellation (a withdrawal, owner decision 2026-10-18, answer 2)
 *    would free it, and this account, paid, would then leave it free for the next account to be
 *    paid again. So the owner refused that change (2026-10-19, answer 2): the INSERT goes ahead
 *    and the one live row per number (`start_grant_numbers_phone_hash_live_idx`) fails it,
 *    23505. The transaction is aborted, the operator's COMMIT then answers ROLLBACK, and the
 *    number stays as it was — until that grant is paid or cancelled, when the change, asked and
 *    confirmed again from the doc's step 1 (ADR-0071 7-28), goes through. The index decides as
 *    the row is written: a grant recording the number or a cancellation freeing it meanwhile is
 *    waited for and counts as it ends; a grant paid meanwhile is still refused, and running it
 *    again goes through (ADR-0071 7-25).
 * 3. What now holds the new number: one row or none (the account has no grant yet). `this_account`
 *    t: recorded for this account. f: another account's grant holds it — paid (`paid` t) when this
 *    account has a grant, since a waiting one failed step 2; either when it has none (`has_grant`
 *    f), and that account then gets no start Coin on this number while that row holds it (its
 *    grant answers `number_already_used`). The SQL has no row to add for such an account, so it
 *    cannot refuse it; the doc's table splits that row by `paid`. Paid: the number got the start
 *    Coin, the operator COMMITs, and then tells the member so with the reply that the number was
 *    changed (owner decision 2026-10-19, answer 3) — after COMMIT, not before, so the open
 *    transaction does not hold the account's phone_verifications row lock while the reply is
 *    written (ADR-0071 7-27). Waiting: nobody got it on this number yet, and the operator
 *    ROLLBACKs as for step 2's refusal (2026-10-19, answer 2; ADR-0071 7-26) — there a COMMIT
 *    would keep the change.
 *
 * Kept here with the procedure's two read-only statements below, each one text in two places like
 * the wipe statement (wipe.ts): phone-change.test.ts reads docs/OPERATIONS.md for them and runs
 * them against the test database the way psql does.
 */
export const OPERATOR_PHONE_CHANGE_SQL = `UPDATE phone_verifications SET phone = :'new_phone', updated_at = now()
  WHERE user_id = :'user_id';
INSERT INTO start_grant_numbers (phone_hash, grant_id, source)
  SELECT :'new_hash', g.id, 'operator' FROM start_grants g
  WHERE g.user_id = :'user_id' AND g.cancelled_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM start_grant_numbers n JOIN start_grants h ON h.id = n.grant_id
      WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL
        AND (h.id = g.id OR h.granted_at IS NOT NULL));
SELECT g.user_id = :'user_id' AS this_account, n.source, g.granted_at IS NOT NULL AS paid,
    EXISTS (SELECT 1 FROM start_grants o
      WHERE o.user_id = :'user_id' AND o.cancelled_at IS NULL) AS has_grant
  FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
  WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL;`;

/**
 * Step 1 of the same procedure, before any confirmation SMS goes out (owner decision 2026-10-19,
 * answer 1): the account whose sign-up email a number-change request came from, and whether it has
 * a 본인확인 record to change. No row, or `verified` f, and the operator stops there — sends
 * nothing, changes nothing (ADR-0071 7-20). Read only. One psql variable, `sender`, the address
 * the request came from; account emails are stored lower-case.
 */
export const OPERATOR_ACCOUNT_LOOKUP_SQL = `SELECT u.id, pv.user_id IS NOT NULL AS verified
  FROM "user" u LEFT JOIN phone_verifications pv ON pv.user_id = u.id
  WHERE u.email = lower(:'sender');`;

/**
 * Before a refused change is tried again (from step 1, ADR-0071 7-28): whether the grant holding
 * the new number has been settled. `paid` f: it still waits, and the change would be refused
 * again. `paid` t (paid) or no row (cancelled, the number freed): settled. Read only; `new_hash`
 * as for the change.
 */
export const OPERATOR_NUMBER_HOLDER_SQL = `SELECT g.granted_at IS NOT NULL AS paid
  FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
  WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL;`;
