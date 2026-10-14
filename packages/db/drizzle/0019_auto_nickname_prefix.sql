-- #14: the auto nickname no longer calls the user a forecaster (D22). The prefix '예측가_' becomes
-- 'user_' (owner decision 2026-10-13, ADR-0052): 'user_' + 4 = 9 characters, inside the shared
-- nicknameSchema ([A-Za-z0-9가-힣_], 2..20). Custom migration (drizzle-kit generate --custom
-- --name auto_nickname_prefix): no table changes, so meta/0019_snapshot.json holds 0018's schema.
--
-- create_profile_for_user() is re-created whole with 0018's body, the prefix being the only
-- change: the #192 column names, the 10,000 sign-up bonus and its 'BONUS' ledger row (keep
-- SIGNUP_BONUS_COIN in @buddha/shared in step with the literal) and the 10-try retry on a taken
-- nickname stay. Existing profiles keep the nickname they have; only sign-ups from now on get
-- the new prefix.
CREATE OR REPLACE FUNCTION create_profile_for_user() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- 32 unambiguous upper-case letters and digits (no 0/O/1/I): 32^4 = 1,048,576 suffixes.
  alphabet CONSTANT text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  bonus_coin CONSTANT bigint := 10000;
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
      INSERT INTO profiles (user_id, nickname) VALUES (NEW.id, 'user_' || suffix);
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF attempt >= 10 THEN RAISE; END IF;
    END;
  END LOOP;
  INSERT INTO balances (user_id, available_coin) VALUES (NEW.id, bonus_coin);
  INSERT INTO ledger_entries (user_id, type, amount_coin, balance_after_coin, memo)
  VALUES (NEW.id, 'BONUS', bonus_coin, bonus_coin, '가입 보너스');
  RETURN NEW;
END;
$$;
