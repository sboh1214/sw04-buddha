-- #126: preserve each positive holding's quantity, cost, payout and settlement PnL.
-- Generated schema followed by hand-written guards. No existing row is changed or backfilled.
-- A NULL judgement version names a pre-version market and uses `legacy` in its payout key.
CREATE TABLE "position_settlements" (
	"market_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"outcome" "outcome" NOT NULL,
	"judgement_version" integer,
	"rule_version" integer,
	"result" "market_result" NOT NULL,
	"qty" integer NOT NULL,
	"cost_basis_coin" bigint NOT NULL,
	"realized_pnl_before_coin" bigint NOT NULL,
	"payout_per_contract_coin" integer NOT NULL,
	"payout_coin" bigint NOT NULL,
	"settlement_pnl_coin" bigint NOT NULL,
	"ledger_entry_id" bigint,
	"settled_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "position_settlements_market_id_user_id_outcome_pk" PRIMARY KEY("market_id","user_id","outcome"),
	CONSTRAINT "position_settlements_ledger_entry_id_unique" UNIQUE("ledger_entry_id"),
	CONSTRAINT "position_settlements_qty_check" CHECK ("position_settlements"."qty" > 0),
	CONSTRAINT "position_settlements_cost_check" CHECK ("position_settlements"."cost_basis_coin" >= 0),
	CONSTRAINT "position_settlements_version_check" CHECK ("position_settlements"."judgement_version" > 0 AND "position_settlements"."rule_version" > 0),
	CONSTRAINT "position_settlements_payout_check" CHECK ("position_settlements"."payout_per_contract_coin" = CASE WHEN "position_settlements"."result" = 'VOID' THEN 50 WHEN "position_settlements"."result"::text = "position_settlements"."outcome"::text THEN 100 ELSE 0 END AND "position_settlements"."payout_coin" = "position_settlements"."qty"::bigint * "position_settlements"."payout_per_contract_coin"),
	CONSTRAINT "position_settlements_pnl_check" CHECK ("position_settlements"."settlement_pnl_coin" = "position_settlements"."payout_coin" - "position_settlements"."cost_basis_coin"),
	CONSTRAINT "position_settlements_ledger_check" CHECK (("position_settlements"."payout_coin" > 0) = ("position_settlements"."ledger_entry_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_judgement_fk" FOREIGN KEY ("market_id","judgement_version") REFERENCES "public"."market_judgements"("market_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_rule_fk" FOREIGN KEY ("market_id","rule_version") REFERENCES "public"."market_rule_versions"("market_id","version") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "position_settlements" FROM buddha_app;--> statement-breakpoint
-- A record is inserted while the old holding still exists, and must retire in the same commit.
CREATE FUNCTION position_settlements_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  m markets%ROWTYPE;
  p positions%ROWTYPE;
  j market_judgements%ROWTYPE;
  e ledger_entries%ROWTYPE;
  source ledger_accounts%ROWTYPE;
  recipient ledger_accounts%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.market_id::text));
  SELECT * INTO m FROM markets WHERE id = NEW.market_id;
  SELECT * INTO p FROM positions
    WHERE market_id = NEW.market_id AND user_id = NEW.user_id AND outcome = NEW.outcome
    FOR UPDATE;
  IF m.id IS NULL OR m.status <> 'settling' OR m.resolved_result IS DISTINCT FROM NEW.result
     OR m.judgement_version IS DISTINCT FROM NEW.judgement_version
     OR m.rule_version IS DISTINCT FROM NEW.rule_version
     OR p.user_id IS NULL OR p.settled OR p.locked_qty <> 0
     OR p.qty <> NEW.qty OR p.cost_basis_coin <> NEW.cost_basis_coin
     OR p.realized_pnl_coin <> NEW.realized_pnl_before_coin THEN
    RAISE EXCEPTION 'settlement record must snapshot its live holding and final judgement'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF NEW.judgement_version IS NOT NULL THEN
    SELECT * INTO j FROM market_judgements
      WHERE market_id = NEW.market_id AND version = NEW.judgement_version;
    IF j.market_id IS NULL OR j.result IS DISTINCT FROM NEW.result
       OR j.rule_version IS DISTINCT FROM NEW.rule_version THEN
      RAISE EXCEPTION 'settlement record must follow its approved judgement'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
    END IF;
  END IF;
  IF is_human_account(NEW.user_id) AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE user_id = NEW.user_id AND closed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a closed account cannot hold a contract to settle'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF NEW.ledger_entry_id IS NOT NULL THEN
    SELECT * INTO e FROM ledger_entries WHERE id = NEW.ledger_entry_id;
    SELECT * INTO source FROM ledger_accounts WHERE id = e.from_account_id;
    SELECT * INTO recipient FROM ledger_accounts WHERE id = e.to_account_id;
    IF e.id IS NULL OR e.type <> 'SETTLEMENT_PAYOUT'
       OR e.market_id IS DISTINCT FROM NEW.market_id OR e.ref_type <> 'market'
       OR e.ref_id <> NEW.market_id::text OR e.amount_coin <> NEW.payout_coin
       OR e.created_at <> NEW.settled_at
       OR e.idempotency_key <> NEW.market_id::text || ':' ||
         coalesce(NEW.judgement_version::text, 'legacy') || ':' || NEW.user_id || ':' || NEW.outcome::text
       OR source.kind IS DISTINCT FROM 'market_collateral'
       OR source.market_id IS DISTINCT FROM NEW.market_id
       OR recipient.owner_id IS DISTINCT FROM NEW.user_id
       OR NOT (recipient.kind = 'user' OR
         (recipient.kind = 'market_maker_funds' AND recipient.market_id = NEW.market_id)) THEN
      RAISE EXCEPTION 'settlement record must name its exact payout ledger entry'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER position_settlements_check
  BEFORE INSERT ON "position_settlements"
  FOR EACH ROW EXECUTE FUNCTION position_settlements_check();--> statement-breakpoint
CREATE FUNCTION position_settlements_retired() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM positions p
    WHERE p.market_id = NEW.market_id AND p.user_id = NEW.user_id AND p.outcome = NEW.outcome
      AND p.settled AND p.qty = 0 AND p.cost_basis_coin = 0 AND p.locked_qty = 0
      AND p.realized_pnl_coin = NEW.realized_pnl_before_coin + NEW.settlement_pnl_coin
  ) THEN
    RAISE EXCEPTION 'settlement record must retire its holding in the same transaction'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER position_settlements_retired
  AFTER INSERT ON "position_settlements" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION position_settlements_retired();--> statement-breakpoint
CREATE FUNCTION position_settlements_keep_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'settlement of % % on market % is permanent and takes no %',
    OLD.user_id, OLD.outcome, OLD.market_id, TG_OP
    USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
END;
$$;--> statement-breakpoint
CREATE TRIGGER position_settlements_keep_record
  BEFORE UPDATE OR DELETE ON "position_settlements"
  FOR EACH ROW EXECUTE FUNCTION position_settlements_keep_record();
