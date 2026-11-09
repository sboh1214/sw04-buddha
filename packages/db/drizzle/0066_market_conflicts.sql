ALTER TYPE "public"."order_reject_reason" ADD VALUE 'admin_role_revoked';--> statement-breakpoint
CREATE TABLE "market_conflict_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"declared_at" timestamp (3) with time zone NOT NULL,
	"admin_action_id" uuid NOT NULL,
	CONSTRAINT "market_conflict_declarations_market_user_unique" UNIQUE("market_id","user_id"),
	CONSTRAINT "market_conflict_declarations_action_unique" UNIQUE("admin_action_id"),
	CONSTRAINT "market_conflict_declarations_reason_check" CHECK (char_length(btrim("market_conflict_declarations"."reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_protection_check";--> statement-breakpoint
ALTER TABLE "market_conflict_declarations" ADD CONSTRAINT "market_conflict_declarations_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_conflict_declarations" ADD CONSTRAINT "market_conflict_declarations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_conflict_declarations" ADD CONSTRAINT "market_conflict_declarations_admin_action_id_admin_actions_id_fk" FOREIGN KEY ("admin_action_id") REFERENCES "public"."admin_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_actions_revocation_target_idx" ON "admin_actions" USING btree ("target_id","created_at" desc,"id" desc) WHERE "admin_actions"."type" = 'admin_revoke' AND "admin_actions"."target_type" = 'user';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_protection_check" CHECK (CASE "orders"."time_in_force"
        WHEN 'gtc' THEN "orders"."protected_limit_price" = "orders"."limit_price"
          AND "orders"."reference_price" IS NULL AND "orders"."protection_ticks" IS NULL
        ELSE CASE WHEN "orders"."protection_ticks" IS NULL
          THEN "orders"."reference_price" IS NULL AND "orders"."protected_limit_price" = "orders"."limit_price"
            AND "orders"."reject_reason" IS NOT NULL
            AND "orders"."reject_reason"::text IN ('not_open_yet', 'paused', 'closed', 'ledger_hold', 'admin_role_revoked')
          ELSE ("orders"."reference_price" IS NULL AND "orders"."protected_limit_price" = "orders"."limit_price")
            OR ("orders"."side" = 'buy' AND "orders"."protected_limit_price"
                = LEAST("orders"."limit_price", "orders"."reference_price" + "orders"."protection_ticks", 99))
            OR ("orders"."side" = 'sell' AND "orders"."protected_limit_price"
                = GREATEST("orders"."limit_price", "orders"."reference_price" - "orders"."protection_ticks", 1))
          END
        END);
--> statement-breakpoint
-- #143 declarations are permanent evidence; no historical backfill or market/role timestamps change.
REVOKE UPDATE, DELETE ON TABLE market_conflict_declarations FROM buddha_app;
--> statement-breakpoint
CREATE FUNCTION market_conflict_declarations_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'a market conflict declaration is permanent' USING ERRCODE='integrity_constraint_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.market_id::text));
  PERFORM pg_advisory_xact_lock_shared(hashtext('buddha:admin_roles'));
  IF NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id=NEW.user_id AND p.role='admin')
    OR NOT EXISTS (SELECT 1 FROM admin_actions a WHERE a.id=NEW.admin_action_id
      AND a.admin_id=NEW.user_id AND a.type='market_conflict_declare'
      AND a.target_type='market' AND a.target_id=NEW.market_id::text
      AND a.created_at=NEW.declared_at AND a.payload->>'reason'=NEW.reason) THEN
    RAISE EXCEPTION 'a declaration needs its current administrator and matching audit record' USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER market_conflict_declarations_check BEFORE INSERT OR UPDATE OR DELETE ON market_conflict_declarations
FOR EACH ROW EXECUTE FUNCTION market_conflict_declarations_check();
--> statement-breakpoint
CREATE FUNCTION orders_refuse_revoked_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE revoked_at timestamptz;
market_created_at timestamptz;
owner_role text;
BEGIN
  -- Match the intake's profile lock: a role change cannot race this INSERT's eligibility.
  SELECT role INTO owner_role FROM profiles WHERE user_id=NEW.user_id FOR SHARE;
  -- The older BEFORE INSERT admin guard can have read 'user' before this lock waited for a
  -- grant. Re-check the row obtained after that wait, including rejected-order inserts.
  IF owner_role='admin' THEN
    RAISE EXCEPTION 'account % holds the admin role: it takes no order',NEW.user_id
      USING ERRCODE='integrity_constraint_violation',CONSTRAINT=TG_NAME;
  END IF;
  SELECT created_at INTO revoked_at FROM admin_actions
    WHERE type='admin_revoke' AND target_type='user' AND target_id=NEW.user_id
    ORDER BY created_at DESC,id DESC LIMIT 1;
  IF revoked_at IS NOT NULL AND NEW.status<>'rejected' THEN
    SELECT created_at INTO market_created_at FROM markets WHERE id=NEW.market_id;
    IF market_created_at<=revoked_at THEN
      RAISE EXCEPTION 'account % cannot trade a market created before or at its admin revocation',NEW.user_id
        USING ERRCODE='integrity_constraint_violation',CONSTRAINT=TG_NAME;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_refuse_revoked_owner BEFORE INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION orders_refuse_revoked_owner();
