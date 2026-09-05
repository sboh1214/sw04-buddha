-- Custom migration (drizzle-kit generate --custom --name signup_bonus), applied after 0003.
--
-- PLAN 17 Q2, owner decision 2026-09-04: every new account starts with 10,000P. The grant has
-- to happen in the same transaction as the user row, for the same reason profiles/balances do
-- (ADR-0019): better-auth's after-create hook runs post-commit, and every sign-up path —
-- email, Google, Kakao, Naver — goes through this INSERT.
--
-- The amount is written into the balance AND into a BONUS ledger entry, so the PLAN 5.6
-- invariant (available_p + locked_p = SUM(ledger_entries.amount_p)) holds from the first
-- moment of an account's life. Keep SIGNUP_BONUS_P in @buddha/shared in step with the literal
-- below; changing the bonus means a new migration.
CREATE OR REPLACE FUNCTION create_profile_for_user() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- 32 unambiguous upper-case letters and digits (no 0/O/1/I): 32^4 = 1,048,576 suffixes.
  alphabet CONSTANT text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  bonus_p CONSTANT bigint := 10000;
  suffix text;
  i integer;
  attempt integer := 0;
BEGIN
  LOOP
    attempt := attempt + 1;
    suffix := '';
    FOR i IN 1..4 LOOP
      suffix := suffix || substr(alphabet, 1 + floor(random() * 32)::integer, 1);
    END LOOP;
    BEGIN
      INSERT INTO profiles (user_id, nickname) VALUES (NEW.id, '예측가_' || suffix);
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF attempt >= 10 THEN RAISE; END IF;
    END;
  END LOOP;
  INSERT INTO balances (user_id, available_p) VALUES (NEW.id, bonus_p);
  INSERT INTO ledger_entries (user_id, type, amount_p, balance_after_p, memo)
  VALUES (NEW.id, 'BONUS', bonus_p, bonus_p, '가입 보너스');
  RETURN NEW;
END;
$$;
