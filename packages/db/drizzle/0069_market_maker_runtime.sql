CREATE TABLE "market_maker_allocations" (
	"market_id" uuid PRIMARY KEY NOT NULL,
	"approval_id" uuid NOT NULL,
	"approved_event_id" bigint NOT NULL,
	"liquidity_version" integer NOT NULL,
	"amount_coin" bigint NOT NULL,
	"ledger_entry_id" bigint NOT NULL,
	"applied_txid" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "market_maker_allocations_amount_check" CHECK ("market_maker_allocations"."amount_coin" BETWEEN 1 AND 1000000000000000)
);
--> statement-breakpoint
CREATE TABLE "market_maker_open_attempts" (
	"market_id" uuid PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp (3) with time zone NOT NULL,
	"reason" text,
	"required_coin" bigint,
	"available_coin" bigint,
	"liquidity_version" integer,
	"succeeded_at" timestamp (3) with time zone,
	CONSTRAINT "market_maker_open_attempts_coin_check" CHECK (("market_maker_open_attempts"."required_coin" IS NULL OR "market_maker_open_attempts"."required_coin" > 0) AND ("market_maker_open_attempts"."available_coin" IS NULL OR "market_maker_open_attempts"."available_coin" >= 0))
);
--> statement-breakpoint
CREATE TABLE "market_maker_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"control_generation" bigint DEFAULT 1 NOT NULL,
	"applied_txid" text DEFAULT pg_current_xact_id()::text NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"reason" text,
	"error" text,
	"detail" jsonb NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "market_maker_runs_generation_check" CHECK ("market_maker_runs"."generation" >= 1),
	CONSTRAINT "market_maker_runs_outcome_check" CHECK ("market_maker_runs"."outcome" IN ('ready','waiting','error') AND ("market_maker_runs"."outcome"='error')=("market_maker_runs"."error" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "market_maker_runtime" (
	"market_id" uuid PRIMARY KEY NOT NULL,
	"desired_enabled" boolean NOT NULL,
	"control_generation" bigint DEFAULT 1 NOT NULL,
	"generation" bigint NOT NULL,
	"completed_generation" bigint NOT NULL,
	"state" varchar(16) NOT NULL,
	"reason" text,
	"last_config_version" integer NOT NULL,
	"last_attempt_at" timestamp (3) with time zone,
	"last_success_at" timestamp (3) with time zone,
	"last_failure_at" timestamp (3) with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "market_maker_runtime_generation_check" CHECK ("market_maker_runtime"."control_generation" >= 1 AND "market_maker_runtime"."generation" >= 1 AND "market_maker_runtime"."completed_generation" BETWEEN 0 AND "market_maker_runtime"."generation"),
	CONSTRAINT "market_maker_runtime_state_check" CHECK ("market_maker_runtime"."state" IN ('ready','waiting','stopped','error')),
	CONSTRAINT "market_maker_runtime_failures_check" CHECK ("market_maker_runtime"."consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "treasury_issuances" (
	"approval_id" uuid PRIMARY KEY NOT NULL,
	"ledger_entry_id" bigint NOT NULL,
	"amount_coin" bigint NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text NOT NULL,
	"applied_txid" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "treasury_issuances_amount_check" CHECK ("treasury_issuances"."amount_coin" BETWEEN 1 AND 1000000000000000),
	CONSTRAINT "treasury_issuances_admin_check" CHECK ("treasury_issuances"."requested_by" <> "treasury_issuances"."approved_by")
);
--> statement-breakpoint
ALTER TABLE "market_maker_allocations" ADD CONSTRAINT "market_maker_allocations_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_allocations" ADD CONSTRAINT "market_maker_allocations_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_allocations" ADD CONSTRAINT "market_maker_allocations_approved_event_id_market_events_id_fk" FOREIGN KEY ("approved_event_id") REFERENCES "public"."market_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_allocations" ADD CONSTRAINT "market_maker_allocations_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_allocations" ADD CONSTRAINT "market_maker_allocations_market_id_liquidity_version_market_liquidity_versions_market_id_version_fk" FOREIGN KEY ("market_id","liquidity_version") REFERENCES "public"."market_liquidity_versions"("market_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_open_attempts" ADD CONSTRAINT "market_maker_open_attempts_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_runs" ADD CONSTRAINT "market_maker_runs_market_id_market_maker_runtime_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."market_maker_runtime"("market_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_runtime" ADD CONSTRAINT "market_maker_runtime_market_id_market_maker_allocations_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."market_maker_allocations"("market_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_runtime" ADD CONSTRAINT "market_maker_runtime_market_id_last_config_version_market_liquidity_versions_market_id_version_fk" FOREIGN KEY ("market_id","last_config_version") REFERENCES "public"."market_liquidity_versions"("market_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_issuances" ADD CONSTRAINT "treasury_issuances_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_issuances" ADD CONSTRAINT "treasury_issuances_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_issuances" ADD CONSTRAINT "treasury_issuances_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_issuances" ADD CONSTRAINT "treasury_issuances_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_maker_allocations_approval_unique" ON "market_maker_allocations" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "market_maker_allocations_ledger_unique" ON "market_maker_allocations" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE INDEX "market_maker_runs_market_created_idx" ON "market_maker_runs" USING btree ("market_id","finished_at","id");--> statement-breakpoint
CREATE INDEX "market_maker_runtime_due_idx" ON "market_maker_runtime" USING btree ("last_attempt_at","market_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_issuances_ledger_unique" ON "treasury_issuances" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE INDEX "treasury_issuances_created_idx" ON "treasury_issuances" USING btree ("created_at","approval_id");
--> statement-breakpoint
-- Hand-edited #129 boundaries. No legacy ledger backfill: these triggers govern new INSERTs.
REVOKE UPDATE, DELETE ON TABLE treasury_issuances, market_maker_allocations, market_maker_runs FROM buddha_app;
--> statement-breakpoint
REVOKE DELETE ON TABLE market_maker_runtime, market_maker_open_attempts FROM buddha_app;
--> statement-breakpoint
CREATE FUNCTION market_maker_keep_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'market maker financial and execution records are immutable' USING ERRCODE='check_violation'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER treasury_issuances_keep_record BEFORE UPDATE OR DELETE ON treasury_issuances
FOR EACH ROW EXECUTE FUNCTION market_maker_keep_record();
--> statement-breakpoint
CREATE TRIGGER market_maker_allocations_keep_record BEFORE UPDATE OR DELETE ON market_maker_allocations
FOR EACH ROW EXECUTE FUNCTION market_maker_keep_record();
--> statement-breakpoint
CREATE TRIGGER market_maker_runs_keep_record BEFORE UPDATE OR DELETE ON market_maker_runs
FOR EACH ROW EXECUTE FUNCTION market_maker_keep_record();
--> statement-breakpoint
CREATE FUNCTION treasury_issuances_check_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a approval_requests%ROWTYPE; e ledger_entries%ROWTYPE; treasury bigint; ledger_xid xid;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('buddha:admin_roles'));
  SELECT * INTO a FROM approval_requests WHERE id=NEW.approval_id FOR UPDATE;
  SELECT * INTO e FROM ledger_entries WHERE id=NEW.ledger_entry_id;
  SELECT xmin INTO ledger_xid FROM ledger_entries WHERE id=NEW.ledger_entry_id;
  SELECT id INTO treasury FROM ledger_accounts WHERE kind='treasury';
  IF a.id IS NULL OR a.kind<>'treasury_issue' OR a.status<>'approved'
    OR a.target_type IS DISTINCT FROM 'treasury' OR a.target_id IS DISTINCT FROM 'treasury'
    OR a.requested_by IS DISTINCT FROM NEW.requested_by OR a.decided_by IS DISTINCT FROM NEW.approved_by
    OR NEW.requested_by=NEW.approved_by
    OR NOT EXISTS(SELECT 1 FROM profiles WHERE user_id=NEW.requested_by AND role='admin' AND closed_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM profiles WHERE user_id=NEW.approved_by AND role='admin' AND closed_at IS NULL)
    OR jsonb_typeof(a.payload->'amountCoin') IS DISTINCT FROM 'string'
    OR a.payload->>'amountCoin' IS DISTINCT FROM NEW.amount_coin::text
    OR NEW.applied_txid IS DISTINCT FROM pg_current_xact_id()::text
    OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='transactionid'
      AND transactionid=ledger_xid AND mode='ExclusiveLock' AND granted)
    OR e.id IS NULL OR e.type<>'TREASURY_MINT' OR e.amount_coin<>NEW.amount_coin
    OR e.from_account_id IS NOT NULL OR e.to_account_id IS DISTINCT FROM treasury
    OR e.market_id IS NOT NULL OR e.ref_type<>'approval_request' OR e.ref_id<>a.id::text
    OR e.idempotency_key<>a.id::text OR e.created_at<>NEW.created_at
    OR NOT EXISTS(SELECT 1 FROM balances b WHERE b.account_id=treasury AND b.locked_coin=0
      AND b.available_coin=b.ledger_coin AND b.ledger_coin=e.to_balance_after_coin
      AND b.ledger_coin=ledger_account_last_after(treasury)
      AND b.ledger_coin=(SELECT coalesce(sum(CASE WHEN le.to_account_id=treasury THEN le.amount_coin ELSE -le.amount_coin END),0)
        FROM ledger_entries le WHERE le.to_account_id=treasury OR le.from_account_id=treasury)) THEN
    RAISE EXCEPTION 'treasury issuance needs its exact current two-admin approved mint' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER treasury_issuances_check_insert BEFORE INSERT ON treasury_issuances
FOR EACH ROW EXECUTE FUNCTION treasury_issuances_check_insert();
--> statement-breakpoint
CREATE FUNCTION market_maker_allocations_check_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a approval_requests%ROWTYPE; v market_liquidity_versions%ROWTYPE; m markets%ROWTYPE;
  ev market_events%ROWTYPE; e ledger_entries%ROWTYPE; treasury bigint; funds bigint; ledger_xid xid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.market_id::text));
  SELECT * INTO m FROM markets WHERE id=NEW.market_id;
  SELECT * INTO ev FROM market_events WHERE id=NEW.approved_event_id;
  SELECT * INTO a FROM approval_requests WHERE id=NEW.approval_id;
  SELECT * INTO v FROM market_liquidity_versions WHERE market_id=NEW.market_id AND version=NEW.liquidity_version;
  SELECT * INTO e FROM ledger_entries WHERE id=NEW.ledger_entry_id;
  SELECT xmin INTO ledger_xid FROM ledger_entries WHERE id=NEW.ledger_entry_id;
  SELECT id INTO treasury FROM ledger_accounts WHERE kind='treasury';
  SELECT id INTO funds FROM ledger_accounts WHERE kind='market_maker_funds' AND market_id=NEW.market_id;
  -- The historic approval remains valid after its admins lose their roles. It already passed
  -- current-role/two-person controls when decided; do not re-approve it at a scheduled opening.
  IF m.id IS NULL OR m.status<>'scheduled' OR m.status_event_id IS DISTINCT FROM ev.id
    OR m.current_liquidity_version IS DISTINCT FROM NEW.liquidity_version
    OR ev.id IS NULL OR ev.market_id<>m.id OR ev.type<>'approved' OR ev.from_status IS DISTINCT FROM 'review'
    OR ev.to_status IS DISTINCT FROM 'scheduled' OR ev.payload->>'approvalId' IS DISTINCT FROM a.id::text
    OR ev.actor_id IS DISTINCT FROM a.decided_by
    OR a.id IS NULL OR a.kind<>'market_review' OR a.status<>'approved' OR a.decided_at IS NULL
    OR a.target_type IS DISTINCT FROM 'market' OR a.target_id IS DISTINCT FROM m.id::text
    OR a.decided_by IS NULL OR a.decided_by=a.requested_by
    OR v.version IS NULL OR v.created_at>a.decided_at OR v.budget_coin<>NEW.amount_coin
    OR (a.payload ? 'liquidityVersion' AND a.payload->>'liquidityVersion' IS DISTINCT FROM NEW.liquidity_version::text)
    OR NEW.applied_txid IS DISTINCT FROM pg_current_xact_id()::text
    OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='transactionid'
      AND transactionid=ledger_xid AND mode='ExclusiveLock' AND granted)
    OR e.id IS NULL OR e.type<>'BOT_ALLOCATION' OR e.amount_coin<>NEW.amount_coin
    OR e.from_account_id IS DISTINCT FROM treasury OR e.to_account_id IS DISTINCT FROM funds
    OR e.market_id IS DISTINCT FROM m.id OR e.ref_type<>'approval_request' OR e.ref_id<>a.id::text
    OR e.idempotency_key<>a.id::text OR e.created_at<>NEW.created_at
    OR EXISTS(SELECT 1 FROM reconciliation_holds h WHERE h.market_id=m.id AND h.recovered_at IS NULL)
    OR EXISTS(SELECT 1 FROM market_pauses p WHERE p.market_id=m.id AND p.reason='ledger_failure'
      AND (p.ended_at IS NULL OR p.end_kind='closed_at_close')
      AND NOT EXISTS(SELECT 1 FROM reconciliation_recoveries r WHERE r.legacy_pause_id=p.id))
    OR EXISTS(SELECT 1 FROM positions p JOIN ledger_accounts f ON f.id=funds
      WHERE p.market_id=m.id AND p.user_id=f.owner_id)
    OR EXISTS(SELECT 1 FROM ledger_entries le WHERE (le.from_account_id=funds OR le.to_account_id=funds) AND le.id<>e.id)
    OR NOT EXISTS(SELECT 1 FROM balances b WHERE b.account_id=funds AND b.locked_coin=0
      AND b.available_coin=NEW.amount_coin AND b.ledger_coin=NEW.amount_coin)
    OR NOT EXISTS(SELECT 1 FROM balances b WHERE b.account_id=treasury AND b.locked_coin=0
      AND b.available_coin=b.ledger_coin AND b.ledger_coin=e.from_balance_after_coin
      AND b.ledger_coin=ledger_account_last_after(treasury)
      AND b.ledger_coin=(SELECT coalesce(sum(CASE WHEN le.to_account_id=treasury THEN le.amount_coin ELSE -le.amount_coin END),0)
        FROM ledger_entries le WHERE le.to_account_id=treasury OR le.from_account_id=treasury)) THEN
    RAISE EXCEPTION 'initial allocation needs its current approved market and exact liquidity version' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER market_maker_allocations_check_insert BEFORE INSERT ON market_maker_allocations
FOR EACH ROW EXECUTE FUNCTION market_maker_allocations_check_insert();
--> statement-breakpoint
CREATE FUNCTION ledger_entries_market_maker_binding() RETURNS trigger
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
      AND i.approval_id::text=NEW.idempotency_key AND i.amount_coin=NEW.amount_coin AND i.market_id=NEW.market_id) THEN
      RAISE EXCEPTION 'bot allocation lacks its permanent approved allocation' USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_market_maker_binding AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.type IN ('TREASURY_MINT','BOT_ALLOCATION'))
EXECUTE FUNCTION ledger_entries_market_maker_binding();
--> statement-breakpoint
CREATE FUNCTION market_maker_allocation_open_link() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  -- At INSERT the market was scheduled; by COMMIT its opening and runtime must exist. Do not
  -- compare status_event_id with the earlier approval now: opening replaced that pointer.
  IF NOT EXISTS(SELECT 1 FROM markets m JOIN market_maker_runtime r ON r.market_id=m.id
    WHERE m.id=NEW.market_id AND m.opened_liquidity_version=NEW.liquidity_version
      AND m.open_at=NEW.created_at AND m.status NOT IN ('draft','review','scheduled')
      AND EXISTS(SELECT 1 FROM market_events ev WHERE ev.market_id=m.id AND ev.type='opened'
        AND ev.from_status='scheduled' AND ev.to_status='open' AND ev.created_at=NEW.created_at
        AND ev.id>NEW.approved_event_id)) THEN
    RAISE EXCEPTION 'initial allocation, runtime and scheduled opening must commit together' USING ERRCODE='check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER market_maker_allocation_open_link AFTER INSERT ON market_maker_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION market_maker_allocation_open_link();
--> statement-breakpoint
CREATE FUNCTION market_maker_runtime_guard() RETURNS trigger
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
CREATE TRIGGER market_maker_runtime_guard BEFORE INSERT OR UPDATE OR DELETE ON market_maker_runtime
FOR EACH ROW EXECUTE FUNCTION market_maker_runtime_guard();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION market_maker_keep_record(), treasury_issuances_check_insert(),
  market_maker_allocations_check_insert(), ledger_entries_market_maker_binding(),
  market_maker_allocation_open_link(), market_maker_runtime_guard() FROM PUBLIC;
