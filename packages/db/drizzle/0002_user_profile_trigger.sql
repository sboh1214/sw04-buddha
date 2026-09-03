-- Custom migration (drizzle-kit generate --custom --name user_profile_trigger), applied after
-- 0000_init (creates "user", profiles, balances) and 0001_restrict_app_role.
--
-- PLAN 10.4: every new user gets a profile (auto nickname 예측가_XXXX, retried on collision)
-- and a zero balance in the SAME transaction as the user row. better-auth's
-- databaseHooks.user.create.after runs after commit (queueAfterTransactionHook), so the
-- guarantee has to live in the database: an AFTER INSERT trigger (ADR-0019). If the trigger
-- raises, the user insert is rolled back and better-auth returns FAILED_TO_CREATE_USER.
--
-- Runs as the inserting role (buddha_app, SECURITY INVOKER), which has INSERT on profiles
-- and balances via the default privileges in docker/postgres/init/01-roles.sql.
CREATE OR REPLACE FUNCTION create_profile_for_user() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- 32 unambiguous upper-case letters and digits (no 0/O/1/I): 32^4 = 1,048,576 suffixes.
  alphabet CONSTANT text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
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
  INSERT INTO balances (user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_after_insert
  AFTER INSERT ON "user"
  FOR EACH ROW EXECUTE FUNCTION create_profile_for_user();
