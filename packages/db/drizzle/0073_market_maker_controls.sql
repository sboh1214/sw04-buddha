CREATE TABLE "market_maker_controls" (
	"approval_id" uuid PRIMARY KEY NOT NULL,
	"market_id" uuid NOT NULL,
	"action" varchar(16) NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text NOT NULL,
	"before_version" integer NOT NULL,
	"after_version" integer NOT NULL,
	"before_control_generation" bigint NOT NULL,
	"after_control_generation" bigint NOT NULL,
	"before_generation" bigint NOT NULL,
	"after_generation" bigint NOT NULL,
	"before_desired_enabled" boolean NOT NULL,
	"after_desired_enabled" boolean NOT NULL,
	"additional_coin" bigint,
	"ledger_entry_id" bigint,
	"applied_txid" text NOT NULL,
	"performed_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "market_maker_controls_action_check" CHECK ("market_maker_controls"."action" IN ('stop','resume','settings','increase')),
	CONSTRAINT "market_maker_controls_admin_check" CHECK ("market_maker_controls"."requested_by" <> "market_maker_controls"."approved_by"),
	CONSTRAINT "market_maker_controls_generations_check" CHECK ("market_maker_controls"."before_generation">=1 AND "market_maker_controls"."after_generation"="market_maker_controls"."before_generation"+1 AND "market_maker_controls"."before_control_generation">=1 AND "market_maker_controls"."after_control_generation"="market_maker_controls"."before_control_generation"+1),
	CONSTRAINT "market_maker_controls_version_check" CHECK ("market_maker_controls"."before_version">=1 AND "market_maker_controls"."after_version"="market_maker_controls"."before_version"+CASE WHEN "market_maker_controls"."action" IN ('settings','increase') THEN 1 ELSE 0 END),
	CONSTRAINT "market_maker_controls_coin_check" CHECK (CASE WHEN "market_maker_controls"."action"='increase' THEN "market_maker_controls"."additional_coin" IS NOT NULL AND "market_maker_controls"."additional_coin">0 AND "market_maker_controls"."additional_coin"<=1000000000000000 AND "market_maker_controls"."ledger_entry_id" IS NOT NULL ELSE "market_maker_controls"."additional_coin" IS NULL AND "market_maker_controls"."ledger_entry_id" IS NULL END)
);
--> statement-breakpoint
ALTER TABLE "market_maker_controls" ADD CONSTRAINT "market_maker_controls_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_controls" ADD CONSTRAINT "market_maker_controls_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_controls" ADD CONSTRAINT "market_maker_controls_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_controls" ADD CONSTRAINT "market_maker_controls_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_controls" ADD CONSTRAINT "market_maker_controls_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_maker_controls_generation_unique" ON "market_maker_controls" USING btree ("market_id","after_control_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "market_maker_controls_ledger_unique" ON "market_maker_controls" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE INDEX "market_maker_controls_history_idx" ON "market_maker_controls" USING btree ("market_id","performed_at","approval_id");
--> statement-breakpoint
-- #130 append after generated 0073 DDL, after the final inherited 0072 snapshot.
CREATE FUNCTION market_maker_demand_snapshot(market uuid, period_from timestamptz,
  period_to timestamptz, captured timestamptz, cursor_id bigint) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
WITH cutoff AS (SELECT coalesce(cursor_id,(SELECT coalesce(max(id),0) FROM fills WHERE market_id=market)) AS id),
selected AS (SELECT f.* FROM fills f,cutoff c WHERE f.market_id=market AND f.id<=c.id
  AND f.created_at>=period_from AND f.created_at<period_to),
legs AS (
  SELECT incoming_owner_id AS owner,side::text AS side,qty,amount_coin AS coin
  FROM selected WHERE is_human_account_type(incoming_account_type)
  UNION ALL
  SELECT resting_owner_id,CASE WHEN kind='pair_mint' THEN 'buy' WHEN side='buy' THEN 'sell' ELSE 'buy' END,
    qty,CASE WHEN kind='pair_mint' THEN (100-price_coin)::bigint*qty ELSE amount_coin END
  FROM selected WHERE is_human_account_type(resting_account_type)
)
SELECT jsonb_build_object(
  'from',to_char(period_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'to',to_char(period_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'capturedAt',to_char(captured AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'lastFillId',(SELECT id::text FROM cutoff), 'fillCount',count(*)::text,
  'humanInvolvedFillCount',count(*) FILTER(WHERE is_human_account_type(incoming_account_type) OR is_human_account_type(resting_account_type))::text,
  'humanHumanFillCount',count(*) FILTER(WHERE is_human_account_type(incoming_account_type) AND is_human_account_type(resting_account_type))::text,
  'humanMakerFillCount',count(*) FILTER(WHERE is_human_account_type(incoming_account_type)<>is_human_account_type(resting_account_type))::text,
  'distinctHumanAccounts',(SELECT count(DISTINCT owner)::text FROM legs),
  'humanBuyQty',(SELECT coalesce(sum(qty) FILTER(WHERE side='buy'),0)::text FROM legs),
  'humanBuyCoin',(SELECT coalesce(sum(coin) FILTER(WHERE side='buy'),0)::text FROM legs),
  'humanSellQty',(SELECT coalesce(sum(qty) FILTER(WHERE side='sell'),0)::text FROM legs),
  'humanSellCoin',(SELECT coalesce(sum(coin) FILTER(WHERE side='sell'),0)::text FROM legs),
  'firstFillAt',to_char(min(created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'lastFillAt',to_char(max(created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM selected
$$;
--> statement-breakpoint
CREATE FUNCTION market_maker_control_assets_valid(market uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f ledger_accounts%ROWTYPE; c ledger_accounts%ROWTYPE; b jsonb; obligation bigint;
BEGIN
  SELECT * INTO f FROM ledger_accounts WHERE market_id=market AND kind='market_maker_funds';
  IF f.id IS NULL OR is_human_account(f.owner_id) OR NOT EXISTS(SELECT 1 FROM "user" WHERE id=f.owner_id AND account_type='market_maker') THEN RETURN false; END IF;
  b:=reconciliation_correction_book(f.id);
  IF b->>'available' IS NULL OR (b->>'available')::bigint+(b->>'locked')::bigint<>(b->>'ledger')::bigint
    OR b->>'ledger' IS DISTINCT FROM b->>'sum' OR b->>'ledger' IS DISTINCT FROM b->>'last'
    OR b->>'locked' IS DISTINCT FROM b->>'expectedLocked' THEN RETURN false; END IF;
  obligation:=reconciliation_correction_obligation(market);
  IF obligation IS NULL THEN RETURN false; END IF;
  SELECT * INTO c FROM ledger_accounts WHERE market_id=market AND kind='market_collateral';
  IF c.id IS NULL THEN RETURN obligation=0; END IF;
  b:=reconciliation_correction_book(c.id);
  RETURN b->>'available' IS NOT NULL AND (b->>'available')::bigint=obligation AND b->>'locked'='0'
    AND b->>'available'=b->>'ledger' AND b->>'ledger'=b->>'sum' AND b->>'ledger'=b->>'last';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION market_maker_control_held(market uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM reconciliation_holds h WHERE h.market_id=market AND h.recovered_at IS NULL)
    OR EXISTS(SELECT 1 FROM market_pauses p WHERE p.market_id=market AND p.reason='ledger_failure'
      AND (p.ended_at IS NULL OR p.end_kind='closed_at_close')
      AND NOT EXISTS(SELECT 1 FROM reconciliation_recoveries r WHERE r.legacy_pause_id=p.id))
$$;
--> statement-breakpoint
-- A visible row cannot belong to another uncommitted transaction. RELEASE SAVEPOINT removes
-- a subtransaction's pg_locks entry, so use its full XID status instead of requiring that lock.
-- Subtransactions are allocated after our top-level XID, including a possible 32-bit wrap.
CREATE FUNCTION market_maker_control_current_write(row_xid xid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE top_xid numeric:=pg_current_xact_id()::text::numeric; full_xid numeric;
BEGIN
  full_xid:=top_xid+mod(row_xid::text::numeric-mod(top_xid,4294967296)+4294967296,4294967296);
  RETURN pg_xact_status(full_xid::text::xid8)='in progress';
EXCEPTION WHEN invalid_parameter_value OR numeric_value_out_of_range THEN RETURN false;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION market_maker_controls_check_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a approval_requests%ROWTYPE; m markets%ROWTYPE; r market_maker_runtime%ROWTYPE;
  v market_liquidity_versions%ROWTYPE; e ledger_entries%ROWTYPE; p jsonb; c jsonb; d jsonb;
  treasury bigint; funds bigint; b jsonb; a_xid xid; e_xid xid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.market_id::text));
  PERFORM pg_advisory_xact_lock_shared(hashtext('buddha:admin_roles'));
  SELECT * INTO m FROM markets WHERE id=NEW.market_id;
  SELECT * INTO r FROM market_maker_runtime WHERE market_id=m.id;
  SELECT * INTO v FROM market_liquidity_versions WHERE market_id=m.id AND version=m.current_liquidity_version;
  SELECT * INTO a FROM approval_requests WHERE id=NEW.approval_id;
  SELECT xmin INTO a_xid FROM approval_requests WHERE id=a.id;
  p:=a.payload; c:=p->'change';
  IF a.id IS NULL OR a.kind<>'market_maker_control' OR a.target_type IS DISTINCT FROM 'market'
    OR a.target_id IS DISTINCT FROM m.id::text OR a.status<>'approved' OR a.decided_at IS NULL
    OR a.requested_by IS DISTINCT FROM NEW.requested_by OR a.decided_by IS DISTINCT FROM NEW.approved_by
    OR NEW.requested_by=NEW.approved_by OR NEW.applied_txid IS DISTINCT FROM pg_current_xact_id()::text
    OR NOT market_maker_control_current_write(a_xid)
    OR (SELECT count(*) FROM profiles WHERE user_id IN (NEW.requested_by,NEW.approved_by) AND role='admin' AND closed_at IS NULL)<>2
    OR r.market_id IS NULL OR v.version IS NULL OR m.opened_liquidity_version IS NULL
    OR (m.status<>'open' AND NOT (NEW.action='stop' AND m.status='paused'))
    OR m.close_at<=clock_timestamp() OR market_maker_control_held(m.id)
    OR NOT market_maker_control_assets_valid(m.id)
    OR NEW.action IS DISTINCT FROM c->>'action'
    OR NEW.before_version IS DISTINCT FROM v.version OR NEW.before_version::text IS DISTINCT FROM p->>'baseVersion'
    OR NEW.before_control_generation IS DISTINCT FROM r.control_generation OR NEW.before_control_generation::text IS DISTINCT FROM p->>'baseControlGeneration'
    OR NEW.before_generation IS DISTINCT FROM r.generation
    OR NEW.before_desired_enabled IS DISTINCT FROM r.desired_enabled
    OR p->'beforeDesiredEnabled' IS DISTINCT FROM to_jsonb(r.desired_enabled)
    OR p->'beforeConfig' IS DISTINCT FROM jsonb_build_object('budgetCoin',v.budget_coin::text,
      'maxLossCoin',v.max_loss_coin::text,'b',v.b,'levels',v.levels,'quantity',v.quantity,'safetyTicks',v.safety_ticks)
    OR NEW.after_desired_enabled IS DISTINCT FROM (CASE NEW.action WHEN 'stop' THEN false WHEN 'resume' THEN true ELSE r.desired_enabled END)
    OR (NEW.action='stop' AND NOT r.desired_enabled) OR (NEW.action='resume' AND r.desired_enabled)
    OR NEW.performed_at<a.decided_at THEN
    RAISE EXCEPTION 'control requires current two-admin approval, exact generation and healthy market' USING ERRCODE='check_violation';
  END IF;
  IF NEW.action='resume' AND NOT EXISTS (
    SELECT 1 FROM release_settings stage_a,release_settings h,release_settings q
    WHERE stage_a.key='market_maker.reduce_at_bp' AND h.key='market_maker.halt_at_bp'
      AND q.key='market_maker.reduce_ratio_bp'
      AND jsonb_typeof(stage_a.value)='number' AND jsonb_typeof(h.value)='number' AND jsonb_typeof(q.value)='number'
      AND (stage_a.value::text)::numeric=trunc((stage_a.value::text)::numeric)
      AND (h.value::text)::numeric=trunc((h.value::text)::numeric)
      AND (q.value::text)::numeric=trunc((q.value::text)::numeric)
      AND (stage_a.value::text)::numeric BETWEEN 0 AND 10000
      AND (h.value::text)::numeric BETWEEN (stage_a.value::text)::numeric AND 10000
      AND (q.value::text)::numeric BETWEEN 0 AND 5000
  ) THEN RAISE EXCEPTION 'resume requires complete valid risk stages' USING ERRCODE='check_violation'; END IF;
  IF NEW.action='stop' AND EXISTS(SELECT 1 FROM orders WHERE market_id=m.id AND user_id=(SELECT owner_id FROM ledger_accounts WHERE market_id=m.id AND kind='market_maker_funds') AND status IN ('open','partially_filled')) THEN
    RAISE EXCEPTION 'stop must cancel all maker orders in its transaction' USING ERRCODE='check_violation';
  END IF;
  IF NEW.action='increase' THEN
    d:=p->'demandSnapshot';
    IF NEW.additional_coin::text IS DISTINCT FROM c->>'additionalCoin'
      OR v.budget_coin::numeric+NEW.additional_coin>1000000000000000
      OR d IS NULL OR jsonb_typeof(d)<>'object'
      OR d->>'from' IS DISTINCT FROM c->'demand'->>'from' OR d->>'to' IS DISTINCT FROM c->'demand'->>'to'
      OR (d->>'from')::timestamptz>=(d->>'to')::timestamptz OR (d->>'to')::timestamptz>(d->>'capturedAt')::timestamptz
      OR (d->>'capturedAt')::timestamptz>a.requested_at
      OR coalesce(length(btrim(c->'demand'->>'independentParticipants')),0) NOT BETWEEN 1 AND 500
      OR coalesce(length(btrim(c->'demand'->>'bidirectionalTrading')),0) NOT BETWEEN 1 AND 500
      OR coalesce(length(btrim(c->'demand'->>'actualDemand')),0) NOT BETWEEN 1 AND 500
      OR d IS DISTINCT FROM market_maker_demand_snapshot(m.id,(d->>'from')::timestamptz,(d->>'to')::timestamptz,(d->>'capturedAt')::timestamptz,(d->>'lastFillId')::bigint) THEN
      RAISE EXCEPTION 'budget increase needs its fixed amount and server evidence' USING ERRCODE='check_violation';
    END IF;
    SELECT id INTO treasury FROM ledger_accounts WHERE kind='treasury';
    SELECT id INTO funds FROM ledger_accounts WHERE kind='market_maker_funds' AND market_id=m.id;
    SELECT * INTO e FROM ledger_entries WHERE id=NEW.ledger_entry_id;
    SELECT xmin INTO e_xid FROM ledger_entries WHERE id=e.id;
    b:=reconciliation_correction_book(treasury);
    IF e.id IS NULL OR e.type<>'BOT_ALLOCATION' OR e.amount_coin<>NEW.additional_coin
      OR e.from_account_id IS DISTINCT FROM treasury OR e.to_account_id IS DISTINCT FROM funds
      OR e.market_id IS DISTINCT FROM m.id OR e.ref_type<>'approval_request' OR e.ref_id<>a.id::text
      OR e.idempotency_key<>a.id::text OR e.created_at<>NEW.performed_at
      OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='transactionid' AND transactionid=e_xid AND mode='ExclusiveLock' AND granted)
      OR b IS NULL OR b->>'available' IS NULL OR b->>'locked'<>'0'
      OR b->>'available' IS DISTINCT FROM b->>'ledger' OR b->>'ledger' IS DISTINCT FROM b->>'sum'
      OR b->>'ledger' IS DISTINCT FROM b->>'last' THEN
      RAISE EXCEPTION 'budget increase needs the exact same-transaction treasury transfer' USING ERRCODE='check_violation';
    END IF;
  ELSIF p->'demandSnapshot' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'only budget increase has demand evidence' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER market_maker_controls_check_insert BEFORE INSERT ON market_maker_controls FOR EACH ROW EXECUTE FUNCTION market_maker_controls_check_insert();
--> statement-breakpoint
CREATE TRIGGER market_maker_controls_keep_record BEFORE UPDATE OR DELETE ON market_maker_controls FOR EACH ROW EXECUTE FUNCTION market_maker_keep_record();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE market_maker_controls FROM buddha_app;
--> statement-breakpoint
CREATE FUNCTION market_maker_controls_check_link() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r market_maker_runtime%ROWTYPE; m markets%ROWTYPE; v market_liquidity_versions%ROWTYPE;
  oldv market_liquidity_versions%ROWTYPE; a approval_requests%ROWTYPE; c jsonb;
BEGIN
  SELECT * INTO r FROM market_maker_runtime WHERE market_id=NEW.market_id;
  SELECT * INTO m FROM markets WHERE id=NEW.market_id;
  SELECT * INTO v FROM market_liquidity_versions WHERE market_id=m.id AND version=NEW.after_version;
  SELECT * INTO oldv FROM market_liquidity_versions WHERE market_id=m.id AND version=NEW.before_version;
  SELECT * INTO a FROM approval_requests WHERE id=NEW.approval_id;
  c:=a.payload->'change';
  IF (SELECT count(*) FROM profiles WHERE user_id IN (NEW.requested_by,NEW.approved_by) AND role='admin' AND closed_at IS NULL)<>2
    OR (m.status<>'open' AND NOT (NEW.action='stop' AND m.status='paused'))
    OR r.control_generation IS DISTINCT FROM NEW.after_control_generation OR r.generation<NEW.after_generation
    OR r.desired_enabled IS DISTINCT FROM NEW.after_desired_enabled OR m.current_liquidity_version IS DISTINCT FROM NEW.after_version
    OR m.opened_liquidity_version IS NULL OR market_maker_control_held(m.id)
    OR NOT market_maker_control_assets_valid(m.id) OR v.version IS NULL
    OR (NEW.action IN ('settings','increase') AND (v.created_by<>NEW.approved_by OR v.created_at<>NEW.performed_at OR v.reason<>a.decision_reason OR v.b<>oldv.b))
    OR (NEW.action='settings' AND (v.budget_coin<>oldv.budget_coin OR v.max_loss_coin::text IS DISTINCT FROM c->'settings'->>'maxLossCoin'
      OR v.levels::text IS DISTINCT FROM c->'settings'->>'levels' OR v.quantity::text IS DISTINCT FROM c->'settings'->>'quantity'
      OR v.safety_ticks::text IS DISTINCT FROM c->'settings'->>'safetyTicks'
      OR (v.max_loss_coin,v.levels,v.quantity,v.safety_ticks) IS NOT DISTINCT FROM (oldv.max_loss_coin,oldv.levels,oldv.quantity,oldv.safety_ticks)))
    OR (NEW.action='increase' AND (v.budget_coin<>oldv.budget_coin+NEW.additional_coin
      OR (v.max_loss_coin,v.levels,v.quantity,v.safety_ticks) IS DISTINCT FROM (oldv.max_loss_coin,oldv.levels,oldv.quantity,oldv.safety_ticks))) THEN
    RAISE EXCEPTION 'control approval, runtime, configuration and assets must commit together' USING ERRCODE='check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER market_maker_controls_check_link AFTER INSERT ON market_maker_controls DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION market_maker_controls_check_link();
--> statement-breakpoint
CREATE FUNCTION approval_market_maker_control_link() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM market_maker_controls WHERE approval_id=NEW.id AND applied_txid=pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'approved control must execute atomically' USING ERRCODE='check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER approval_market_maker_control_link AFTER UPDATE ON approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='market_maker_control' AND NEW.status='approved') EXECUTE FUNCTION approval_market_maker_control_link();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION market_maker_controls_check_insert(), market_maker_controls_check_link(), approval_market_maker_control_link() FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION market_liquidity_versions_check_insert() RETURNS trigger
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
  IF m.status='open' AND EXISTS(SELECT 1 FROM market_maker_controls c WHERE c.market_id=m.id
    AND c.applied_txid=pg_current_xact_id()::text AND c.action IN ('settings','increase')
    AND c.before_version=m.current_liquidity_version AND c.after_version=NEW.version
    AND c.approved_by=NEW.created_by AND c.performed_at=NEW.created_at) THEN RETURN NEW; END IF;
  IF m.status <> 'draft' OR m.opened_liquidity_version IS NOT NULL
     OR NEW.version <> COALESCE(m.current_liquidity_version, 0) + 1 THEN
    RAISE EXCEPTION 'liquidity version requires the next draft version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION markets_keep_liquidity_versions() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_liquidity_version IS NOT NULL OR NEW.opened_liquidity_version IS NOT NULL THEN
      RAISE EXCEPTION 'a new market has no liquidity version yet' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.current_liquidity_version IS DISTINCT FROM OLD.current_liquidity_version THEN
    IF NOT (OLD.status='open' AND NEW.status='open' AND EXISTS(
      SELECT 1 FROM market_maker_controls c WHERE c.market_id=NEW.id
        AND c.applied_txid=pg_current_xact_id()::text AND c.action IN ('settings','increase')
        AND c.before_version=OLD.current_liquidity_version AND c.after_version=NEW.current_liquidity_version
        AND EXISTS(SELECT 1 FROM market_liquidity_versions v WHERE v.market_id=NEW.id AND v.version=c.after_version)))
      AND (OLD.status <> 'draft' OR NEW.status <> 'draft'
       OR OLD.opened_liquidity_version IS NOT NULL
       OR NEW.current_liquidity_version IS NULL
       OR NEW.current_liquidity_version <> COALESCE(OLD.current_liquidity_version, 0) + 1
       OR NOT EXISTS (SELECT 1 FROM market_liquidity_versions v
                      WHERE v.market_id = NEW.id AND v.version = NEW.current_liquidity_version)) THEN
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
CREATE OR REPLACE FUNCTION market_maker_runtime_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'market maker runtime is retained' USING ERRCODE='check_violation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.market_id::text));
  IF TG_OP='INSERT' THEN
    IF NOT NEW.desired_enabled OR NEW.control_generation<>1 OR NEW.generation<>1 OR NEW.completed_generation<>0 OR NEW.state<>'waiting'
      OR NEW.reason IS NOT NULL OR NEW.consecutive_failures<>0 OR NEW.last_attempt_at IS NOT NULL
      OR NEW.last_success_at IS NOT NULL OR NEW.last_failure_at IS NOT NULL OR NEW.last_error IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM market_maker_allocations a WHERE a.market_id=NEW.market_id
        AND a.applied_txid=pg_current_xact_id()::text AND a.liquidity_version=NEW.last_config_version
        AND a.created_at=NEW.created_at AND a.created_at=NEW.updated_at) THEN
      RAISE EXCEPTION 'runtime starts only with its fresh initial allocation' USING ERRCODE='check_violation';
    END IF;
  ELSE
    IF NEW.market_id<>OLD.market_id OR NEW.created_at<>OLD.created_at
      OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
      OR NEW.completed_generation<OLD.completed_generation THEN
      RAISE EXCEPTION 'runtime identity is fixed; generations only advance' USING ERRCODE='check_violation';
    END IF;
    IF EXISTS(SELECT 1 FROM market_maker_controls c WHERE c.market_id=NEW.market_id
      AND c.applied_txid=pg_current_xact_id()::text AND c.before_control_generation=OLD.control_generation
      AND c.after_control_generation=NEW.control_generation AND c.before_generation=OLD.generation
      AND c.after_generation=NEW.generation AND c.before_desired_enabled=OLD.desired_enabled
      AND c.after_desired_enabled=NEW.desired_enabled AND c.performed_at=NEW.updated_at
      AND NEW.completed_generation=OLD.completed_generation
      AND NEW.state=CASE WHEN NEW.desired_enabled THEN 'waiting' ELSE 'stopped' END
      AND NEW.reason IS NOT DISTINCT FROM CASE WHEN c.action='stop' THEN 'operator_stopped' WHEN NEW.desired_enabled THEN NULL ELSE OLD.reason END
      AND (NEW.last_attempt_at,NEW.last_success_at,NEW.last_failure_at,NEW.last_error,NEW.consecutive_failures,NEW.last_config_version)
        IS NOT DISTINCT FROM (OLD.last_attempt_at,OLD.last_success_at,OLD.last_failure_at,OLD.last_error,OLD.consecutive_failures,OLD.last_config_version)) THEN RETURN NEW; END IF;
    IF NEW.desired_enabled IS DISTINCT FROM OLD.desired_enabled
      OR NEW.control_generation IS DISTINCT FROM OLD.control_generation THEN
      -- Only a fresh exhausted failure may disable this bot. No raw resume path: #130 binds
      -- that operation to another administrator's current, versioned approval.
      IF NOT OLD.desired_enabled OR NEW.desired_enabled
        OR NEW.control_generation<>OLD.control_generation+1 OR NEW.generation<>OLD.generation+1
        OR NEW.completed_generation<>OLD.completed_generation
        OR NEW.state<>'stopped' OR NEW.reason IS DISTINCT FROM 'retry_exhausted'
        OR NOT EXISTS(SELECT 1 FROM market_maker_runs r WHERE r.market_id=NEW.market_id
          AND r.control_generation=OLD.control_generation
          AND r.generation>OLD.completed_generation AND r.generation<=OLD.generation
          AND r.outcome='error' AND r.reason='retry_exhausted'
          AND r.applied_txid=pg_current_xact_id()::text
          AND r.finished_at=NEW.updated_at AND r.error=NEW.last_error) THEN
        RAISE EXCEPTION 'runtime control needs a fresh exhausted failure or an approved control' USING ERRCODE='check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ledger_entries_market_maker_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.type='TREASURY_MINT' THEN
    IF NOT EXISTS(SELECT 1 FROM treasury_issuances i WHERE i.ledger_entry_id=NEW.id
      AND i.applied_txid=pg_current_xact_id()::text AND i.approval_id::text=NEW.ref_id
      AND i.approval_id::text=NEW.idempotency_key AND i.amount_coin=NEW.amount_coin) THEN
      RAISE EXCEPTION 'treasury mint lacks its permanent approved issuance' USING ERRCODE='check_violation';
    END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM market_maker_allocations i WHERE i.ledger_entry_id=NEW.id
      AND i.applied_txid=pg_current_xact_id()::text AND i.approval_id::text=NEW.ref_id
      AND i.approval_id::text=NEW.idempotency_key AND i.amount_coin=NEW.amount_coin AND i.market_id=NEW.market_id)
      AND NOT EXISTS(SELECT 1 FROM market_maker_controls c WHERE c.ledger_entry_id=NEW.id AND c.action='increase'
        AND c.applied_txid=pg_current_xact_id()::text AND c.approval_id::text=NEW.ref_id
        AND c.approval_id::text=NEW.idempotency_key AND c.additional_coin=NEW.amount_coin AND c.market_id=NEW.market_id) THEN
      RAISE EXCEPTION 'bot allocation lacks its permanent approved allocation' USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
