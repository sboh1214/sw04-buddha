/**
 * An operator's change of a member's verified mobile number, as docs/OPERATIONS.md has it run in
 * psql: the member cannot change the number, an operator does it in the database by hand (ADR-0069
 * decision 1 #57-3), and the new number is recorded as one that received the start Coin as well —
 * beside the account's grant, `source` 'operator' — so that a later account verifying it gets
 * nothing (owner decision 2026-10-18, ADR-0071). Three psql variables: `user_id` (the account),
 * `new_phone` (its digits) and `new_hash` (the keyed hash of those digits, from the API's
 * phone-hash CLI, apps/api/src/identity/phone-hash-cli.ts — SQL cannot compute it without the
 * key). Run between BEGIN and COMMIT, reading the three results first:
 *
 * 1. The number itself, `UPDATE 1` (0: no such account). `phone_verifications.phone` stays UNIQUE
 *    and digits only (its constraints), and `verified_at` keeps the member's own confirmation.
 * 2. The record, `INSERT 0 1` — or `INSERT 0 0`: the account has no grant to record it beside
 *    (not onboarded yet, so its grant will record the new number itself, or withdrawn), or the
 *    number's live row is a grant's already (this one's, or another account's — ON CONFLICT DO
 *    NOTHING takes the live UNIQUE too, so nothing is recorded for this account then).
 * 3. What now holds the new number: one row or none (the account has no grant yet). `this_account`
 *    t: recorded for this account. f: another account's grant holds it — `paid` t, that account got
 *    the start Coin with it, so nothing is missing; `paid` f, that grant still waits, and the number
 *    counts only while it does: if that account withdraws before it is paid, the cancellation frees
 *    the number (owner decision 2026-10-18, answer 2) and this account's grant does not hold it —
 *    what then is ADR-0071 결과 4's question, not settled here. `has_grant` says whether this
 *    account has a grant that is not cancelled: f with another account's row means it will get no
 *    start Coin on this number while that row holds it (its grant answers `number_already_used`).
 *
 * Kept here, one text in two places like the wipe statement (wipe.ts): phone-change.test.ts reads
 * docs/OPERATIONS.md for it and runs it against the test database.
 */
export const OPERATOR_PHONE_CHANGE_SQL = `UPDATE phone_verifications SET phone = :'new_phone', updated_at = now()
  WHERE user_id = :'user_id';
INSERT INTO start_grant_numbers (phone_hash, grant_id, source)
  SELECT :'new_hash', g.id, 'operator' FROM start_grants g
  WHERE g.user_id = :'user_id' AND g.cancelled_at IS NULL
  ON CONFLICT DO NOTHING;
SELECT g.user_id = :'user_id' AS this_account, n.source, g.granted_at IS NOT NULL AS paid,
    EXISTS (SELECT 1 FROM start_grants o
      WHERE o.user_id = :'user_id' AND o.cancelled_at IS NULL) AS has_grant
  FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
  WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL;`;
