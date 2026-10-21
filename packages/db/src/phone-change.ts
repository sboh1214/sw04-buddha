/**
 * An operator's change of a member's verified mobile number, as docs/OPERATIONS.md has it run in
 * psql: the member cannot change the number, an operator does it in the database by hand (ADR-0069
 * decision 1 #57-3), and the new number is recorded as one that received the start Coin as well —
 * beside the account's grant, `source` 'operator' — so that a later account verifying it gets
 * nothing (owner decision 2026-10-18, ADR-0071). Five psql variables: `user_id` (the account),
 * `new_phone` (its digits) and `new_hash` (the keyed hash of those digits, from the API's
 * phone-hash CLI, apps/api/src/identity/phone-hash-cli.ts — SQL cannot compute it without the
 * key), and `old_phone` and `old_hash`, the same for the number the account holds now, read with
 * OPERATOR_CURRENT_NUMBER_SQL and hashed by the same CLI (`--psql-old`, owner decision 2026-10-21,
 * ADR-0076 — step 4 below). The doc runs it only for a request that came from the account's
 * current email and passed sender authentication (the operator's own mail provider's verdict, the
 * topmost Authentication-Results line: SPF and DKIM both passing for the sender's domain, or DMARC
 * passing), whose new number passed the pre-check before any SMS (OPERATOR_NUMBER_PRECHECK_SQL),
 * and whose member confirmed the number by sending back, from that email within 30 minutes, the
 * last code the operator texted to it — at most three codes per request (owner decisions
 * 2026-10-19, answer 1, 3차, answers 1 and 2, and 4차, answers 1 and 2; the account is looked up
 * first, OPERATOR_ACCOUNT_LOOKUP_SQL, and looked up again for the reply's sender, which must give
 * the same id, still verified; the code comes from the same CLI's `--code` — node:crypto's
 * CSPRNG, not PostgreSQL's random() — and is noted with the number it was texted to, which the
 * CLI's `new_phone` line must match digit for digit — ADR-0071 7-29 to 7-32), in one transaction
 * with psql's ON_ERROR_ROLLBACK off, reading the results first and then ending it with the COMMIT
 * or ROLLBACK the doc's result table gives for them:
 *
 * 1. The number itself, `UPDATE 1` — 0: no such account, or the account does not hold
 *    `old_phone` (the operator typed another number into the CLI, or runs the lines again after
 *    the change committed: the old number is read and hashed again, ADR-0076 7-24). `UPDATE 0`
 *    only says so: the transaction goes on, and the statements after it run. Step 3's DO block
 *    refuses it before any of them is kept (below), so neither the INSERT nor a hash of another
 *    number moving likes in step 4 outlives it, a COMMIT typed after it included.
 *    `phone_verifications.phone` stays UNIQUE and digits only (its constraints — another
 *    account's verified number is a 23505 here), and `verified_at` keeps the member's own
 *    confirmation.
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
 *    number stays as it was. The index decides as the row is written: a grant recording the
 *    number or a cancellation freeing it meanwhile is waited for and counts as it ends; a grant
 *    paid meanwhile is still refused, and asking again goes through (ADR-0071 7-25).
 * 3. The refusals the UPDATE and the INSERT cannot make, in one DO block. First an `UPDATE 0`
 *    (ADR-0076 7-24): unless this transaction's UPDATE changed the account's 본인확인 row — it set
 *    `updated_at` to `now()`, the time this transaction began, kept to the millisecond as the
 *    column keeps it (`timestamptz(3)`), which another transaction's write would have to hit — the
 *    block raises (`refused: the account does not hold old_phone`). The transaction is aborted and
 *    a COMMIT answers ROLLBACK, as for every other refusal: nothing of the INSERT or of step 4 is
 *    kept, whether or not the operator read the `UPDATE 0`. Then the refusal of step 2 for an
 *    account with no grant, which step 2 has no row to refuse with (owner decision 2026-10-19 3차,
 *    answer 4): it raises when the account has a 본인확인 record and a waiting grant of another account
 *    holds the new number. psql writes no variable into a dollar-quoted body, so the SET LOCAL
 *    lines hand it `user_id` and `new_hash` (and the likes' block `old_hash` too) for this
 *    transaction only. It reads what is committed: a cancellation or payment of that grant still in
 *    flight is not waited for, and the change is refused until asked again (ADR-0071 7-26).
 * 4. The account's likes (#49, owner decisions 2026-10-20 and 2026-10-21, ADR-0076): «좋아요 한 번»
 *    counts per verified number (ADR-0069 decision 7), so the likes that are the account's go over
 *    to the new number's hash and no longer hold the old number — its own `post_likes` and
 *    `comment_likes` rows (those whose account it is), and the likes it inherited from a withdrawn
 *    account on the old number (rows under `old_hash` whose account has no 본인확인 record left, which
 *    it saw as its own, ADR-0076 7-3): the old number's next holder likes freely. Where the new
 *    number already liked a target one of those likes, one like stays. A withdrawn account's row
 *    there (one that held the number) gives way to the one coming with the account: it is deleted
 *    first (only on those targets: the new number's likes of any other target stay, and the account
 *    sees them as its own, ADR-0076 7-18). A live account's row there stays — only a number changed
 *    outside this procedure leaves one under another number than the one it holds (ADR-0076 7-19),
 *    and a live account's like is its own (7-3), never deleted for another's — and the one coming
 *    with the account gives way to it (ADR-0076 7-26, Codex review on PR #222). Then the rows are
 *    deleted and inserted again under the new hash with their account, target and time (buddha_app
 *    has no UPDATE on them, migration 0035) — the account's own first, then the inherited ones,
 *    which give way where the account's own like of the same target is there already (only a number
 *    changed outside this procedure leaves the two on different hashes, ADR-0076 7-23). Every one
 *    of those inserts skips a row whose target the new number's hash still holds a like of — a live
 *    account's — (`ON CONFLICT DO NOTHING`): that like leaves the old number and is not kept. A
 *    second DO block with the SET LOCAL values; it answers `DO` and nothing to read. After step 1,
 *    which holds the account's 본인확인 row: a like of the account's in flight has committed by then
 *    (it holds that row FOR KEY SHARE, LikesService) and is moved too, and a later one waits for
 *    the COMMIT and is made under the new hash; the old number cannot be verified by another
 *    account before the COMMIT either (its UNIQUE entry is the uncommitted UPDATE's). Run again —
 *    the old number read again is the new one — it moves nothing.
 * 5. The account's reports (#50, owner decision 2026-10-21, ADR-0081): «the same person» of a
 *    report — one pending report per target, REPORTS_PER_DAY in the last 24 hours — counts per
 *    verified number too (ADR-0069 decision 7), so the reports those rules read go over to the new
 *    number's hash: the account's pending ones and those of the last 24 hours, processed or not.
 *    The rest keep the hash they were sent with; no rule reads it again. Only the hash changes —
 *    what was reported and how it was processed stay as they are — and the reports' keep-record
 *    trigger takes that change from this transaction alone: to the hash its SET LOCAL names, for a
 *    report of the account it names (`reports_keep_record`, migration 0038). With the old number's
 *    hash in the transaction too (`phone_change.old_hash`, which #49's final procedure sets beside
 *    its check of the old number, ADR-0076) the reports the account inherited from a withdrawn
 *    account on that number go with them; without it — this procedure sets none — that clause
 *    matches nothing (`current_setting(…, true)` is NULL, or '' after an earlier run in the
 *    session) and they stay under the old hash. The rows are locked in id order first, the order an
 *    operator's action and a dismissal take reports in (ModerationService), so the two never wait
 *    on each other crosswise. A third DO block with the same SET LOCAL values; it answers `DO` and
 *    nothing to read. After step 1 as the likes are: a report of the account's in flight holds its
 *    본인확인 row FOR KEY SHARE (ReportsService), commits first and is moved, and a later one waits
 *    for the COMMIT and is sent under the new hash. Run again, it moves nothing.
 * 6. What now holds the new number: one row or none (the account has no grant yet). `this_account`
 *    t: recorded for this account. f: another account's paid grant holds it (`paid` t — after
 *    `UPDATE 1` a waiting one failed step 2 or 3), and `has_grant` says whether this account has a
 *    grant. It has none (`has_grant` f): it then gets no start Coin on this number while that row
 *    holds it (its grant answers `number_already_used`); the operator COMMITs and then tells the
 *    member so with the reply that the number was changed (owner decision 2026-10-19, answer 3) —
 *    after COMMIT, not before, so the open transaction does not hold the account's
 *    phone_verifications row lock while the reply is written (ADR-0071 7-27).
 *
 * Every refusal here — `UPDATE 0`, whatever follows it (the account gone meanwhile; not a mistyped
 * id or old number, which the operator runs again with the right one), another account's verified
 * number (23505 on the UPDATE), either refusal of a waiting grant's number — is told to the member
 * with the same one sentence and no reason, after the ROLLBACK, and the member asks again later
 * (owner decisions 2026-10-19 3차, answer 3, and 4차, answer 1). The pre-check has already turned
 * away before the confirmation SMS what it could see then, so these come only from what changed
 * after it (ADR-0071 7-31).
 *
 * Kept here with the procedure's three read-only statements below, each one text in two places
 * like the wipe statement (wipe.ts): phone-change.test.ts reads docs/OPERATIONS.md for them and
 * runs them against the test database the way psql does.
 */
export const OPERATOR_PHONE_CHANGE_SQL = `UPDATE phone_verifications SET phone = :'new_phone', updated_at = now()
  WHERE user_id = :'user_id' AND phone = :'old_phone';
INSERT INTO start_grant_numbers (phone_hash, grant_id, source)
  SELECT :'new_hash', g.id, 'operator' FROM start_grants g
  WHERE g.user_id = :'user_id' AND g.cancelled_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM start_grant_numbers n JOIN start_grants h ON h.id = n.grant_id
      WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL
        AND (h.id = g.id OR h.granted_at IS NOT NULL));
SET LOCAL phone_change.user_id = :'user_id';
SET LOCAL phone_change.new_hash = :'new_hash';
SET LOCAL phone_change.old_hash = :'old_hash';
DO $$BEGIN
  IF NOT EXISTS (SELECT 1 FROM phone_verifications
      WHERE user_id = current_setting('phone_change.user_id')
        AND updated_at = now()::timestamptz(3)) THEN
    RAISE EXCEPTION 'refused: the account does not hold old_phone';
  END IF;
  IF EXISTS (SELECT 1 FROM phone_verifications pv
      JOIN start_grant_numbers n ON n.phone_hash = current_setting('phone_change.new_hash')
        AND n.released_at IS NULL
      JOIN start_grants h ON h.id = n.grant_id
      WHERE pv.user_id = current_setting('phone_change.user_id')
        AND h.user_id <> pv.user_id AND h.granted_at IS NULL) THEN
    RAISE EXCEPTION 'refused: a waiting start grant of another account holds the new number';
  END IF;
END$$;
DO $$BEGIN
  DELETE FROM post_likes o USING post_likes a
    WHERE o.post_id = a.post_id AND o.phone_hash = current_setting('phone_change.new_hash')
      AND a.phone_hash <> o.phone_hash
      AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = o.user_id)
      AND (a.user_id = current_setting('phone_change.user_id')
        OR (a.phone_hash = current_setting('phone_change.old_hash')
          AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = a.user_id)));
  DELETE FROM comment_likes o USING comment_likes a
    WHERE o.comment_id = a.comment_id AND o.phone_hash = current_setting('phone_change.new_hash')
      AND a.phone_hash <> o.phone_hash
      AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = o.user_id)
      AND (a.user_id = current_setting('phone_change.user_id')
        OR (a.phone_hash = current_setting('phone_change.old_hash')
          AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = a.user_id)));
  WITH moved AS (DELETE FROM post_likes
      WHERE user_id = current_setting('phone_change.user_id')
        AND phone_hash <> current_setting('phone_change.new_hash')
      RETURNING post_id, user_id, created_at)
    INSERT INTO post_likes (post_id, user_id, phone_hash, created_at)
      SELECT post_id, user_id, current_setting('phone_change.new_hash'), created_at FROM moved
      ON CONFLICT DO NOTHING;
  WITH moved AS (DELETE FROM comment_likes
      WHERE user_id = current_setting('phone_change.user_id')
        AND phone_hash <> current_setting('phone_change.new_hash')
      RETURNING comment_id, user_id, created_at)
    INSERT INTO comment_likes (comment_id, user_id, phone_hash, created_at)
      SELECT comment_id, user_id, current_setting('phone_change.new_hash'), created_at FROM moved
      ON CONFLICT DO NOTHING;
  WITH moved AS (DELETE FROM post_likes l
      WHERE l.phone_hash = current_setting('phone_change.old_hash')
        AND l.phone_hash <> current_setting('phone_change.new_hash')
        AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = l.user_id)
      RETURNING post_id, user_id, created_at)
    INSERT INTO post_likes (post_id, user_id, phone_hash, created_at)
      SELECT post_id, user_id, current_setting('phone_change.new_hash'), created_at FROM moved
      ON CONFLICT DO NOTHING;
  WITH moved AS (DELETE FROM comment_likes l
      WHERE l.phone_hash = current_setting('phone_change.old_hash')
        AND l.phone_hash <> current_setting('phone_change.new_hash')
        AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = l.user_id)
      RETURNING comment_id, user_id, created_at)
    INSERT INTO comment_likes (comment_id, user_id, phone_hash, created_at)
      SELECT comment_id, user_id, current_setting('phone_change.new_hash'), created_at FROM moved
      ON CONFLICT DO NOTHING;
END$$;
DO $$BEGIN
  PERFORM 1 FROM reports r
    WHERE r.reporter_phone_hash <> current_setting('phone_change.new_hash')
      AND (r.status = 'pending' OR r.created_at > now() - interval '24 hours')
      AND (r.reporter_id = current_setting('phone_change.user_id')
        OR (r.reporter_phone_hash = current_setting('phone_change.old_hash', true)
          AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = r.reporter_id)))
    ORDER BY r.id FOR UPDATE;
  UPDATE reports r SET reporter_phone_hash = current_setting('phone_change.new_hash')
    WHERE r.reporter_phone_hash <> current_setting('phone_change.new_hash')
      AND (r.status = 'pending' OR r.created_at > now() - interval '24 hours')
      AND (r.reporter_id = current_setting('phone_change.user_id')
        OR (r.reporter_phone_hash = current_setting('phone_change.old_hash', true)
          AND NOT EXISTS (SELECT 1 FROM phone_verifications pv WHERE pv.user_id = r.reporter_id)));
END$$;
SELECT g.user_id = :'user_id' AS this_account, n.source, g.granted_at IS NOT NULL AS paid,
    EXISTS (SELECT 1 FROM start_grants o
      WHERE o.user_id = :'user_id' AND o.cancelled_at IS NULL) AS has_grant
  FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
  WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL;`;

/**
 * Step 1 of the same procedure, before any confirmation SMS goes out (owner decision 2026-10-19,
 * answer 1): the account whose current email a number-change request came from, and whether it has
 * a 본인확인 record to change. No row, and the operator stops there — sends nothing, changes
 * nothing (ADR-0071 7-20); `verified` f, and the request is refused with the one sentence (4차,
 * answer 1, ADR-0071 7-33). Run on the request, and again on every authenticated reply with the
 * reply's sender — the 가입 이메일 is the account's current email (2026-10-19 3차, answer 2),
 * which the member may have changed meanwhile, so only the same id with `verified` t goes on (any
 * other answer is refused), and that id is step 5's `user_id` (ADR-0071 7-29). Read only. One psql
 * variable, `sender`, the address the mail came from; account emails are stored lower-case.
 */
export const OPERATOR_ACCOUNT_LOOKUP_SQL = `SELECT u.id, pv.user_id IS NOT NULL AS verified
  FROM "user" u LEFT JOIN phone_verifications pv ON pv.user_id = u.id
  WHERE u.email = lower(:'sender');`;

/**
 * Step 3, after the member's reply and before step 5 (owner decision 2026-10-21, ADR-0076): the
 * number the account holds now — the old number — which the operator types into the hash CLI's
 * `--psql-old` for step 5's `old_phone` and `old_hash`. The change moves the likes the account
 * inherited from a withdrawn account on that number, and SQL cannot hash it without the key. Read
 * only; `user_id` from the lookup. No row: no 본인확인 record (the lookup said `verified` f, or the
 * account withdrew since) — nothing to change. Read again for every run of step 5: after the
 * change it is the new number.
 */
export const OPERATOR_CURRENT_NUMBER_SQL = `SELECT phone FROM phone_verifications WHERE user_id = :'user_id';`;

/**
 * Step 1, after the lookup and before every confirmation code is picked and texted (owner decision
 * 2026-10-19 4차, answer 1): whether step 5 would refuse the new number on what can be seen now —
 * `other_verified`, another account verified it (step 5's UPDATE, 23505); `other_waiting`, a
 * waiting grant of another account holds it (step 5's INSERT or DO block). Either t, and no SMS
 * goes out: the request is refused with the one sentence. Both f, and the code may be sent. The
 * account's own number and its own grant's numbers are not flagged — step 5 takes them. A paid
 * grant's number is not flagged either: step 5 changes to it and records nothing (2026-10-19,
 * answers 2 and 3). Read only; `user_id` from the lookup, `new_phone` and `new_hash` from the
 * hash CLI as for the change (ADR-0071 7-31).
 */
export const OPERATOR_NUMBER_PRECHECK_SQL = `SELECT EXISTS (SELECT 1 FROM phone_verifications pv
      WHERE pv.phone = :'new_phone' AND pv.user_id <> :'user_id') AS other_verified,
    EXISTS (SELECT 1 FROM start_grant_numbers n JOIN start_grants g ON g.id = n.grant_id
      WHERE n.phone_hash = :'new_hash' AND n.released_at IS NULL
        AND g.user_id <> :'user_id' AND g.granted_at IS NULL) AS other_waiting;`;
