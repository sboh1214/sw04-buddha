-- #70 시작 지급 (ADR-0069 decision 1 #57-1·#57-2·#57-18 and decision 4 #70, ADR-0071): the start
-- Coin a verified mobile number gets once, and the end of the sign-up grant. Hand-edited after
-- `drizzle-kit generate` at the end only (marked below); the snapshot is as generated.
--
-- - START_GRANT is the ledger type of the grant (new issuance, '시작 지급'), apart from the
--   coupon's BONUS. Added with ADD VALUE, so nothing in this batch may use it (55P04, see 0014):
--   the functions below only name it in bodies that run after the batch commits.
-- - start_grants: an account's start grant, one per account — waiting for its amount, paid, or
--   cancelled when the account withdrew while it waited (owner decision 2026-10-18).
-- - start_grant_numbers: the numbers that received the start Coin, keyed by a keyed hash of the
--   number so the row outlives the number (withdrawal, #140) — the grant's own number and any an
--   operator later recorded for the account (owner decision 2026-10-18), one live row per number.
-- - create_profile_for_user() no longer grants anything: every sign-up path starts at 0 with no
--   ledger entry. Existing accounts keep what they got (D4: no backfill, no clawback; the owner
--   resets the deployed database when #70 ships, docs/RESET.md).
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'START_GRANT';--> statement-breakpoint
CREATE TABLE "start_grant_numbers" (
	"phone_hash" varchar(64) NOT NULL,
	"grant_id" uuid NOT NULL,
	"source" varchar(8) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp (3) with time zone,
	CONSTRAINT "start_grant_numbers_grant_id_phone_hash_pk" PRIMARY KEY("grant_id","phone_hash"),
	CONSTRAINT "start_grant_numbers_phone_hash_check" CHECK ("start_grant_numbers"."phone_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "start_grant_numbers_source_check" CHECK ("start_grant_numbers"."source" IN ('grant', 'operator'))
);
--> statement-breakpoint
CREATE TABLE "start_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"amount_coin" bigint,
	"ledger_entry_id" bigint,
	"granted_at" timestamp (3) with time zone,
	"cancelled_at" timestamp (3) with time zone,
	CONSTRAINT "start_grants_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "start_grants_ledger_entry_id_unique" UNIQUE("ledger_entry_id"),
	CONSTRAINT "start_grants_paid_check" CHECK (("start_grants"."granted_at" IS NULL) = ("start_grants"."amount_coin" IS NULL) AND ("start_grants"."granted_at" IS NULL) = ("start_grants"."ledger_entry_id" IS NULL)),
	CONSTRAINT "start_grants_amount_coin_check" CHECK ("start_grants"."amount_coin" > 0),
	CONSTRAINT "start_grants_settled_check" CHECK ("start_grants"."granted_at" IS NULL OR "start_grants"."cancelled_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "start_grant_numbers" ADD CONSTRAINT "start_grant_numbers_grant_id_start_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."start_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "start_grants" ADD CONSTRAINT "start_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "start_grants" ADD CONSTRAINT "start_grants_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "start_grant_numbers_phone_hash_live_idx" ON "start_grant_numbers" USING btree ("phone_hash") WHERE "start_grant_numbers"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "start_grant_numbers_grant_id_source_grant_idx" ON "start_grant_numbers" USING btree ("grant_id") WHERE "start_grant_numbers"."source" = 'grant';--> statement-breakpoint
CREATE INDEX "start_grants_pending_created_at_idx" ON "start_grants" USING btree ("created_at") WHERE "start_grants"."granted_at" IS NULL AND "start_grants"."cancelled_at" IS NULL;--> statement-breakpoint
-- Hand-edited: the record of a grant and of a number that got the start Coin is never lost.
-- buddha_app keeps SELECT/INSERT/UPDATE of the default privileges in
-- docker/postgres/init/01-roles.sql and loses DELETE on both; only an owner-run wipe (TRUNCATE,
-- wipe.ts) or an operator removes rows.
REVOKE DELETE ON TABLE "start_grants", "start_grant_numbers" FROM buddha_app;--> statement-breakpoint
-- Hand-edited: a grant is recorded pending, with nothing paid or cancelled. The CHECKs would accept
-- a row inserted paid already (any amount, any unused ledger entry — another account's, another
-- type), and buddha_app may INSERT: payment must come as the one UPDATE the trigger below allows,
-- after the row exists, so it is checked against the ledger. And a row inserted cancelled would be
-- an account that can never be granted (one row per account) without a withdrawal to say why.
CREATE FUNCTION start_grants_start_pending() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_coin IS NOT NULL OR NEW.ledger_entry_id IS NOT NULL
     OR NEW.granted_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'start grant % must be inserted pending, with nothing paid or cancelled', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER start_grants_start_pending
  BEFORE INSERT ON "start_grants"
  FOR EACH ROW EXECUTE FUNCTION start_grants_start_pending();--> statement-breakpoint
-- Hand-edited: the only changes a row takes are pending → granted, made by the transaction that
-- pays it, and pending → cancelled, made by the withdrawal of an account whose grant still waited
-- (cancelStartGrant, owner decision 2026-10-18). The account and when it was recorded never change,
-- a paid or cancelled grant never changes again, and a grant is paid only by the START_GRANT entry
-- of the same account, amount and grant (ref start_grant → this id), so the grant and the ledger
-- cannot tell two stories — with the trigger above, which keeps a row from being inserted paid,
-- every paid row went through this check. Paid and cancelled at once is the settled CHECK's.
-- Runs as the invoker: buddha_app may SELECT ledger_entries. TRUNCATE fires no row trigger.
CREATE FUNCTION start_grants_keep_record() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'start grant %: its account and recording time never change', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.granted_at IS NOT NULL THEN
    RAISE EXCEPTION 'start grant % was paid at %: a paid grant never changes', OLD.id,
      OLD.granted_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'start grant % was cancelled at %: a cancelled grant never changes', OLD.id,
      OLD.cancelled_at
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
-- Hand-edited: a cancelled grant frees its numbers — every one it held, its own and any an operator
-- recorded — at the instant of the cancellation (owner decision 2026-10-18: nothing was paid, so
-- the number's once is unused, and the next account that verifies it can get the start Coin). In
-- the database, so a cancellation never leaves a number held by a grant that will never pay; the
-- rows stay, released, as history. Runs as the invoker (buddha_app may UPDATE start_grant_numbers;
-- the trigger below checks the change).
CREATE FUNCTION start_grants_release_numbers() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE start_grant_numbers SET released_at = NEW.cancelled_at
  WHERE grant_id = NEW.id AND released_at IS NULL;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER start_grants_release_numbers
  AFTER UPDATE OF cancelled_at ON "start_grants"
  FOR EACH ROW WHEN (OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL)
  EXECUTE FUNCTION start_grants_release_numbers();--> statement-breakpoint
-- Hand-edited: a grant holds its own number by the end of the transaction that records it — the
-- 'grant' row of start_grant_numbers, which the API inserts right after the grant. Deferred, so the
-- two inserts may come in either order; without it a grant could be recorded holding no number,
-- and the number would not count as having received the start Coin. Neither row can be deleted
-- by buddha_app afterwards (REVOKE above, RESTRICT).
CREATE FUNCTION start_grants_hold_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM start_grant_numbers n WHERE n.grant_id = NEW.id AND n.source = 'grant'
  ) THEN
    RAISE EXCEPTION 'start grant % was recorded without its number', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER start_grants_hold_number
  AFTER INSERT ON "start_grants"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION start_grants_hold_number();--> statement-breakpoint
-- Hand-edited: a number is recorded holding it, for a grant that is not cancelled — the grant's own
-- or one an operator gives the account later (docs/OPERATIONS.md) — never released already (only a
-- cancellation releases, the trigger below) and never for a cancelled grant, whose numbers are
-- free. FOR SHARE on the grant: a cancellation (its UPDATE) waits for this insert to commit and then
-- releases it with the rest, or this waits for the cancellation and sees it. Runs as the invoker:
-- buddha_app may UPDATE start_grants, which FOR SHARE asks for.
CREATE FUNCTION start_grant_numbers_start_held() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cancelled timestamptz;
BEGIN
  IF NEW.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a number of start grant % must be inserted held, not released', NEW.grant_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT g.cancelled_at INTO cancelled FROM start_grants g WHERE g.id = NEW.grant_id FOR SHARE;
  IF cancelled IS NOT NULL THEN
    RAISE EXCEPTION 'start grant % was cancelled at %: it records no number', NEW.grant_id,
      cancelled
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER start_grant_numbers_start_held
  BEFORE INSERT ON "start_grant_numbers"
  FOR EACH ROW EXECUTE FUNCTION start_grant_numbers_start_held();--> statement-breakpoint
-- Hand-edited: the only change a number's row takes is its release, by its grant's cancellation
-- (the AFTER trigger above) at the cancellation's instant. Its number, its grant, how it was
-- recorded and when never change, and a released row never changes again (it is history). The
-- rows of a paid grant are never released: the grant cannot be cancelled.
CREATE FUNCTION start_grant_numbers_keep_record() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cancelled timestamptz;
BEGIN
  IF NEW.phone_hash <> OLD.phone_hash OR NEW.grant_id <> OLD.grant_id
     OR NEW.source <> OLD.source OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a number of start grant %: its number, grant, source and recording time never change',
      OLD.grant_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a number of start grant % was released at %: a released number never changes',
      OLD.grant_id, OLD.released_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.released_at IS NOT NULL THEN
    SELECT g.cancelled_at INTO cancelled FROM start_grants g WHERE g.id = NEW.grant_id;
    IF cancelled IS NULL OR NEW.released_at <> cancelled THEN
      RAISE EXCEPTION 'a number of start grant % is released only by the grant''s cancellation',
        OLD.grant_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER start_grant_numbers_keep_record
  BEFORE UPDATE ON "start_grant_numbers"
  FOR EACH ROW EXECUTE FUNCTION start_grant_numbers_keep_record();--> statement-breakpoint
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
