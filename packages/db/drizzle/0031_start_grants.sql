-- #70 시작 지급 (ADR-0069 decision 1 #57-1·#57-2·#57-18 and decision 4 #70, ADR-0071): the start
-- Coin a verified mobile number gets once, and the end of the sign-up grant. Hand-edited after
-- `drizzle-kit generate` at the end only (marked below); the snapshot is as generated.
--
-- - START_GRANT is the ledger type of the grant (new issuance, '시작 지급'), apart from the
--   coupon's BONUS. Added with ADD VALUE, so nothing in this batch may use it (55P04, see 0014):
--   the function below only names it in a body that runs after the batch commits.
-- - start_grants: one row per number that got (or awaits) its start Coin, keyed by a keyed hash of
--   the number so the row outlives the number (withdrawal, #140), and by account.
-- - create_profile_for_user() no longer grants anything: every sign-up path starts at 0 with no
--   ledger entry. Existing accounts keep what they got (D4: no backfill, no clawback).
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'START_GRANT';--> statement-breakpoint
CREATE TABLE "start_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"phone_hash" varchar(64) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"amount_coin" bigint,
	"ledger_entry_id" bigint,
	"granted_at" timestamp (3) with time zone,
	CONSTRAINT "start_grants_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "start_grants_phone_hash_unique" UNIQUE("phone_hash"),
	CONSTRAINT "start_grants_ledger_entry_id_unique" UNIQUE("ledger_entry_id"),
	CONSTRAINT "start_grants_paid_check" CHECK (("start_grants"."granted_at" IS NULL) = ("start_grants"."amount_coin" IS NULL) AND ("start_grants"."granted_at" IS NULL) = ("start_grants"."ledger_entry_id" IS NULL)),
	CONSTRAINT "start_grants_amount_coin_check" CHECK ("start_grants"."amount_coin" > 0),
	CONSTRAINT "start_grants_phone_hash_check" CHECK ("start_grants"."phone_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "start_grants" ADD CONSTRAINT "start_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "start_grants" ADD CONSTRAINT "start_grants_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "start_grants_pending_created_at_idx" ON "start_grants" USING btree ("created_at") WHERE "start_grants"."granted_at" IS NULL;--> statement-breakpoint
-- Hand-edited: the record of a number that got its start Coin is never lost. buddha_app keeps
-- SELECT/INSERT/UPDATE of the default privileges in docker/postgres/init/01-roles.sql and loses
-- DELETE; only an owner-run wipe (TRUNCATE, wipe.ts) or an operator removes rows.
REVOKE DELETE ON TABLE "start_grants" FROM buddha_app;--> statement-breakpoint
-- Hand-edited: a grant is recorded pending, with nothing paid. The CHECKs would accept a row
-- inserted paid already (any amount, any unused ledger entry — another account's, another type),
-- and buddha_app may INSERT: payment must come as the one UPDATE the trigger below allows, after
-- the row exists, so it is checked against the ledger.
CREATE FUNCTION start_grants_start_pending() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_coin IS NOT NULL OR NEW.ledger_entry_id IS NOT NULL
     OR NEW.granted_at IS NOT NULL THEN
    RAISE EXCEPTION 'start grant % must be inserted pending, with nothing paid', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER start_grants_start_pending
  BEFORE INSERT ON "start_grants"
  FOR EACH ROW EXECUTE FUNCTION start_grants_start_pending();--> statement-breakpoint
-- Hand-edited: the only change a row takes is pending → granted, made by the transaction that
-- pays it. The account, the number and when it was recorded never change, a paid grant never
-- changes again, and a grant is paid only by the START_GRANT entry of the same account, amount
-- and grant (ref start_grant → this id), so the grant and the ledger cannot tell two stories —
-- with the trigger above, which keeps a row from being inserted paid, every paid row went through
-- this check. Runs as the invoker: buddha_app may SELECT ledger_entries. TRUNCATE fires no row
-- trigger.
CREATE FUNCTION start_grants_keep_record() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.phone_hash <> OLD.phone_hash
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'start grant %: its account, number and recording time never change', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.granted_at IS NOT NULL THEN
    RAISE EXCEPTION 'start grant % was paid at %: a paid grant never changes', OLD.id,
      OLD.granted_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.granted_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ledger_entries e
    WHERE e.id = NEW.ledger_entry_id
      AND e.user_id = NEW.user_id
      AND e.type = 'START_GRANT'
      AND e.amount_coin = NEW.amount_coin
      AND e.ref_type = 'start_grant'
      AND e.ref_id = NEW.id::text
  ) THEN
    RAISE EXCEPTION 'start grant % is paid only by its own START_GRANT ledger entry', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER start_grants_keep_record
  BEFORE UPDATE ON "start_grants"
  FOR EACH ROW EXECUTE FUNCTION start_grants_keep_record();--> statement-breakpoint
-- Hand-edited: creating an account grants nothing (ADR-0069 decision 1 #57-1, decision 4 #70). The
-- function is re-created whole with 0019's body less the 10,000 Coin and its BONUS ledger row
-- (and SIGNUP_BONUS_COIN, its copy in @buddha/shared, is gone): the profile with the auto nickname
-- 'user_' + 4 (ADR-0052, retried up to ten times on a taken one) and a zero balance stay, in the
-- same transaction as the user row (ADR-0019). Every sign-up path — email, Google, Kakao, Naver —
-- goes through this INSERT, so every new account starts at 0 with no ledger entry; the start Coin
-- comes from the start grant (start_grants) once the onboarding is done (#58).
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
      INSERT INTO profiles (user_id, nickname) VALUES (NEW.id, 'user_' || suffix);
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF attempt >= 10 THEN RAISE; END IF;
    END;
  END LOOP;
  INSERT INTO balances (user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;
