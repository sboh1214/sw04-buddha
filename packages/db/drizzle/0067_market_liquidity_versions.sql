CREATE TABLE "market_liquidity_versions" (
	"market_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"budget_coin" bigint NOT NULL,
	"max_loss_coin" bigint NOT NULL,
	"b" double precision NOT NULL,
	"levels" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"safety_ticks" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "market_liquidity_versions_market_id_version_pk" PRIMARY KEY("market_id","version"),
	CONSTRAINT "market_liquidity_versions_version_check" CHECK ("market_liquidity_versions"."version" >= 1),
	CONSTRAINT "market_liquidity_versions_coin_check" CHECK ("market_liquidity_versions"."budget_coin" BETWEEN 1 AND 1000000000000000 AND "market_liquidity_versions"."max_loss_coin" BETWEEN 1 AND "market_liquidity_versions"."budget_coin"),
	CONSTRAINT "market_liquidity_versions_b_check" CHECK ("market_liquidity_versions"."b" > 0 AND "market_liquidity_versions"."b" < 'Infinity'::float8 AND 1.0 / "market_liquidity_versions"."b" < 'Infinity'::float8 AND 100.0 * "market_liquidity_versions"."b" < 'Infinity'::float8),
	CONSTRAINT "market_liquidity_versions_ladder_check" CHECK ("market_liquidity_versions"."levels" BETWEEN 1 AND 9007199254740991 AND "market_liquidity_versions"."quantity" BETWEEN 1 AND 1000000 AND "market_liquidity_versions"."safety_ticks" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "market_liquidity_versions_reason_check" CHECK (length(btrim("market_liquidity_versions"."reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "current_liquidity_version" integer;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "opened_liquidity_version" integer;--> statement-breakpoint
ALTER TABLE "market_liquidity_versions" ADD CONSTRAINT "market_liquidity_versions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_liquidity_versions" ADD CONSTRAINT "market_liquidity_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_liquidity_versions_check" CHECK ("markets"."current_liquidity_version" >= 1 AND "markets"."opened_liquidity_version" >= 1);--> statement-breakpoint
-- Hand-edited: immutable history and write boundaries. Generated columns/CHECKs above and
-- snapshot remain as generated. No backfill: old markets retain NULL pointers.
REVOKE UPDATE, DELETE ON TABLE "market_liquidity_versions" FROM buddha_app;
--> statement-breakpoint
CREATE FUNCTION market_liquidity_versions_keep_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'market liquidity version is a permanent record and takes no %', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER market_liquidity_versions_keep_record
BEFORE UPDATE OR DELETE ON market_liquidity_versions
FOR EACH ROW EXECUTE FUNCTION market_liquidity_versions_keep_record();
--> statement-breakpoint
CREATE FUNCTION market_liquidity_versions_check_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE m markets%ROWTYPE;
BEGIN
  -- The application has these already. Direct INSERT writers must use the same order.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.market_id::text));
  SELECT * INTO m FROM markets WHERE id = NEW.market_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'liquidity market does not exist' USING ERRCODE = 'foreign_key_violation';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtext('buddha:admin_roles'));
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = NEW.created_by AND role = 'admin') THEN
    RAISE EXCEPTION 'liquidity version requires a current admin' USING ERRCODE = 'check_violation';
  END IF;
  IF m.status <> 'draft' OR m.opened_liquidity_version IS NOT NULL
     OR NEW.version <> COALESCE(m.current_liquidity_version, 0) + 1 THEN
    RAISE EXCEPTION 'liquidity version requires the next draft version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER market_liquidity_versions_check_insert
BEFORE INSERT ON market_liquidity_versions
FOR EACH ROW EXECUTE FUNCTION market_liquidity_versions_check_insert();
--> statement-breakpoint
CREATE FUNCTION markets_keep_liquidity_versions() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_liquidity_version IS NOT NULL OR NEW.opened_liquidity_version IS NOT NULL THEN
      RAISE EXCEPTION 'a new market has no liquidity version yet' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.current_liquidity_version IS DISTINCT FROM OLD.current_liquidity_version THEN
    IF OLD.status <> 'draft' OR NEW.status <> 'draft'
       OR OLD.opened_liquidity_version IS NOT NULL
       OR NEW.current_liquidity_version IS NULL
       OR NEW.current_liquidity_version <> COALESCE(OLD.current_liquidity_version, 0) + 1
       OR NOT EXISTS (SELECT 1 FROM market_liquidity_versions v
                      WHERE v.market_id = NEW.id AND v.version = NEW.current_liquidity_version) THEN
      RAISE EXCEPTION 'current liquidity changes only to the next recorded draft version'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.opened_liquidity_version IS DISTINCT FROM OLD.opened_liquidity_version THEN
    IF OLD.opened_liquidity_version IS NOT NULL OR OLD.status <> 'scheduled' OR NEW.status <> 'open'
       OR NEW.opened_liquidity_version IS NULL
       OR NEW.opened_liquidity_version IS DISTINCT FROM NEW.current_liquidity_version
       OR NOT EXISTS (SELECT 1 FROM market_liquidity_versions v
                      WHERE v.market_id = NEW.id AND v.version = NEW.opened_liquidity_version) THEN
      RAISE EXCEPTION 'opened liquidity is fixed once at the scheduled open'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.status = 'scheduled' AND NEW.status = 'open'
     AND (NEW.opened_liquidity_version IS NULL
          OR NEW.opened_liquidity_version IS DISTINCT FROM NEW.current_liquidity_version) THEN
    RAISE EXCEPTION 'scheduled open requires its current liquidity version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER markets_keep_liquidity_versions
BEFORE INSERT OR UPDATE OF status, current_liquidity_version, opened_liquidity_version ON markets
FOR EACH ROW EXECUTE FUNCTION markets_keep_liquidity_versions();
--> statement-breakpoint
-- A version and its current pointer commit together. An INSERT without the pointer may not
-- leave an unreachable immutable row that would consume the next version number forever.
CREATE FUNCTION market_liquidity_versions_check_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM markets m WHERE m.id = NEW.market_id
      AND m.current_liquidity_version = (
        SELECT max(v.version) FROM market_liquidity_versions v WHERE v.market_id = NEW.market_id
      )
  ) THEN
    RAISE EXCEPTION 'liquidity history and current pointer must commit together'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER market_liquidity_versions_check_link
AFTER INSERT ON market_liquidity_versions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION market_liquidity_versions_check_link();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION market_liquidity_versions_keep_record(), market_liquidity_versions_check_insert(), markets_keep_liquidity_versions(), market_liquidity_versions_check_link() FROM PUBLIC;
