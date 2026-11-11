CREATE TABLE "market_maker_supply_intervals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" uuid NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"ended_at" timestamp (3) with time zone NOT NULL,
	"applied_txid" text NOT NULL,
	"is_open" boolean NOT NULL,
	"close_at" timestamp (3) with time zone NOT NULL,
	"bot_yes_buy" boolean NOT NULL,
	"bot_no_buy" boolean NOT NULL,
	"yes_ask" boolean NOT NULL,
	"no_ask" boolean NOT NULL,
	CONSTRAINT "market_maker_supply_intervals_time_check" CHECK ("market_maker_supply_intervals"."started_at" <= "market_maker_supply_intervals"."ended_at")
);
--> statement-breakpoint
CREATE TABLE "market_maker_supply_pending" (
	"market_id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_maker_supply_states" (
	"market_id" uuid PRIMARY KEY NOT NULL,
	"first_observed_at" timestamp (3) with time zone NOT NULL,
	"first_observed_txid" text NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"last_observed_at" timestamp (3) with time zone NOT NULL,
	"last_observed_txid" text NOT NULL,
	"is_open" boolean NOT NULL,
	"close_at" timestamp (3) with time zone NOT NULL,
	"bot_yes_buy" boolean NOT NULL,
	"bot_no_buy" boolean NOT NULL,
	"yes_ask" boolean NOT NULL,
	"no_ask" boolean NOT NULL,
	CONSTRAINT "market_maker_supply_states_time_check" CHECK ("market_maker_supply_states"."first_observed_at" <= "market_maker_supply_states"."started_at" AND "market_maker_supply_states"."started_at" <= "market_maker_supply_states"."last_observed_at")
);
--> statement-breakpoint
ALTER TABLE "market_maker_supply_intervals" ADD CONSTRAINT "market_maker_supply_intervals_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_supply_pending" ADD CONSTRAINT "market_maker_supply_pending_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_supply_states" ADD CONSTRAINT "market_maker_supply_states_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_maker_supply_intervals_market_started_idx" ON "market_maker_supply_intervals" USING btree ("market_id","started_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "market_maker_supply_intervals_market_txid_idx" ON "market_maker_supply_intervals" USING btree ("market_id","applied_txid");
--> statement-breakpoint
-- #182: the app reads observations; only this deferred observer owns their writes.
-- No historical backfill, account identity or order identity is copied.
REVOKE INSERT, UPDATE, DELETE ON TABLE market_maker_supply_pending, market_maker_supply_states, market_maker_supply_intervals FROM buddha_app;
--> statement-breakpoint
-- A private pending marker is transactional: one per market until the next deferred flush.
-- It is inserted after each actual write (before the observer by trigger name), so even
-- SET CONSTRAINTS IMMEDIATE sees later writes. Rollback/savepoints also restore the marker.
CREATE FUNCTION market_maker_supply_mark_pending() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE mid uuid;
BEGIN
  IF TG_TABLE_NAME='orders' THEN mid := NEW.market_id; ELSE mid := NEW.id; END IF;
  INSERT INTO market_maker_supply_pending(market_id) VALUES (mid) ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION market_maker_supply_mark_pending() FROM PUBLIC,buddha_app;
--> statement-breakpoint
CREATE TRIGGER orders_mark_market_maker_supply_pending
AFTER INSERT OR UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION market_maker_supply_mark_pending();
--> statement-breakpoint
CREATE TRIGGER markets_mark_market_maker_supply_pending
AFTER INSERT OR UPDATE ON markets
FOR EACH ROW EXECUTE FUNCTION market_maker_supply_mark_pending();
--> statement-breakpoint
CREATE FUNCTION market_maker_supply_keep_committed_interval() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  -- Only an interval created by this still-open transaction can be folded after an
  -- explicit SET CONSTRAINTS flush. A committed observation is always immutable.
  IF OLD.applied_txid <> pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'committed market-maker supply intervals are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'ended_at') IS DISTINCT FROM (to_jsonb(OLD)-'ended_at') THEN
    RAISE EXCEPTION 'only the uncommitted supply interval end may change' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION market_maker_supply_keep_committed_interval() FROM PUBLIC,buddha_app;
--> statement-breakpoint
CREATE TRIGGER market_maker_supply_intervals_keep_record
BEFORE UPDATE OR DELETE ON market_maker_supply_intervals
FOR EACH ROW EXECUTE FUNCTION market_maker_supply_keep_committed_interval();
--> statement-breakpoint
CREATE FUNCTION market_maker_supply_observe() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  mid uuid;
  previous market_maker_supply_states%ROWTYPE;
  baseline market_maker_supply_intervals%ROWTYPE;
  observed_xid text := pg_current_xact_id()::text;
  observed_at timestamptz(3);
  open_now boolean;
  closes_at timestamptz(3);
  by_buy boolean;
  bn_buy boolean;
  y_ask boolean;
  n_ask boolean;
BEGIN
  IF TG_TABLE_NAME='orders' THEN mid := NEW.market_id; ELSE mid := NEW.id; END IF;
  DELETE FROM market_maker_supply_pending WHERE market_id=mid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO previous FROM market_maker_supply_states WHERE market_id=mid FOR UPDATE;
  -- Domain writers acquire the market lock before orders/assets. Do not return just
  -- because this transaction was observed: SET CONSTRAINTS may flush before its last write.
  SELECT status='open', close_at INTO open_now, closes_at FROM markets WHERE id=mid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  observed_at := greatest(clock_timestamp(), previous.last_observed_at);
  SELECT
    coalesce(bool_or(NOT is_human_account_type(u.account_type) AND o.side='buy' AND o.outcome='YES'),false),
    coalesce(bool_or(NOT is_human_account_type(u.account_type) AND o.side='buy' AND o.outcome='NO'),false),
    coalesce(bool_or((o.side='sell' AND o.outcome='YES') OR (o.side='buy' AND o.outcome='NO')),false),
    coalesce(bool_or((o.side='sell' AND o.outcome='NO') OR (o.side='buy' AND o.outcome='YES')),false)
    INTO by_buy,bn_buy,y_ask,n_ask
    FROM orders o JOIN "user" u ON u.id=o.user_id
    WHERE o.market_id=mid AND o.status IN ('open','partially_filled')
      AND o.time_in_force='gtc' AND o.qty>o.filled_qty;
  IF previous.market_id IS NULL THEN
    INSERT INTO market_maker_supply_states
      (market_id,first_observed_at,first_observed_txid,started_at,last_observed_at,last_observed_txid,
       is_open,close_at,bot_yes_buy,bot_no_buy,yes_ask,no_ask)
    VALUES (mid,observed_at,observed_xid,observed_at,observed_at,observed_xid,
            open_now,closes_at,by_buy,bn_buy,y_ask,n_ask);
    RETURN NULL;
  END IF;
  IF ROW(previous.is_open,previous.close_at,previous.bot_yes_buy,previous.bot_no_buy,previous.yes_ask,previous.no_ask)
     IS NOT DISTINCT FROM ROW(open_now,closes_at,by_buy,bn_buy,y_ask,n_ask) THEN
    -- The ordinary deferred queue can contain many events for this same final book.
    -- Keep one observation; a later event still compares its actual final state.
    IF previous.last_observed_txid=observed_xid THEN RETURN NULL; END IF;
  ELSIF previous.first_observed_txid=observed_xid THEN
    -- No state from this market has committed yet: keep only the final first observation.
    previous.first_observed_at := observed_at;
    previous.started_at := observed_at;
  ELSE
    SELECT * INTO baseline FROM market_maker_supply_intervals
      WHERE market_id=mid AND applied_txid=observed_xid;
    IF baseline.id IS NULL THEN
      INSERT INTO market_maker_supply_intervals
        (market_id,started_at,ended_at,applied_txid,is_open,close_at,bot_yes_buy,bot_no_buy,yes_ask,no_ask)
      VALUES (mid,previous.started_at,observed_at,observed_xid,previous.is_open,previous.close_at,
              previous.bot_yes_buy,previous.bot_no_buy,previous.yes_ask,previous.no_ask);
      previous.started_at := observed_at;
    ELSIF ROW(baseline.is_open,baseline.close_at,baseline.bot_yes_buy,baseline.bot_no_buy,baseline.yes_ask,baseline.no_ask)
       IS NOT DISTINCT FROM ROW(open_now,closes_at,by_buy,bn_buy,y_ask,n_ask) THEN
      -- Returning to the committed state means no supply transition occurred in this TX.
      DELETE FROM market_maker_supply_intervals WHERE id=baseline.id;
      previous.started_at := baseline.started_at;
    ELSE
      -- Fold only this TX's intermediate transition into its final observed state.
      UPDATE market_maker_supply_intervals SET ended_at=observed_at WHERE id=baseline.id;
      previous.started_at := observed_at;
    END IF;
  END IF;
  UPDATE market_maker_supply_states SET first_observed_at=previous.first_observed_at,
    started_at=previous.started_at,last_observed_at=observed_at,last_observed_txid=observed_xid,
    is_open=open_now,close_at=closes_at,bot_yes_buy=by_buy,bot_no_buy=bn_buy,yes_ask=y_ask,no_ask=n_ask
    WHERE market_id=mid;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION market_maker_supply_observe() FROM PUBLIC,buddha_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER orders_observe_market_maker_supply
AFTER INSERT OR UPDATE ON orders DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION market_maker_supply_observe();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER markets_observe_market_maker_supply
AFTER INSERT OR UPDATE ON markets DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION market_maker_supply_observe();
