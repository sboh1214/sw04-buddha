CREATE TABLE "market_maker_recalls" (
	"market_id" uuid PRIMARY KEY NOT NULL,
	"terminal_status" varchar(16) NOT NULL,
	"status_event_id" bigint,
	"judgement_version" integer,
	"funds_account_id" bigint,
	"amount_coin" bigint NOT NULL,
	"ledger_entry_id" bigint,
	"applied_txid" text NOT NULL,
	"completed_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "market_maker_recalls_terminal_check" CHECK ("market_maker_recalls"."terminal_status" IN ('settled','cancelled')),
	CONSTRAINT "market_maker_recalls_amount_check" CHECK ("market_maker_recalls"."amount_coin" BETWEEN 0 AND 1000000000000000),
	CONSTRAINT "market_maker_recalls_ledger_check" CHECK (("market_maker_recalls"."amount_coin">0)=("market_maker_recalls"."ledger_entry_id" IS NOT NULL) AND ("market_maker_recalls"."funds_account_id" IS NOT NULL OR "market_maker_recalls"."amount_coin"=0))
);
--> statement-breakpoint
ALTER TABLE "market_maker_recalls" ADD CONSTRAINT "market_maker_recalls_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_recalls" ADD CONSTRAINT "market_maker_recalls_status_event_id_market_events_id_fk" FOREIGN KEY ("status_event_id") REFERENCES "public"."market_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_recalls" ADD CONSTRAINT "market_maker_recalls_funds_account_id_ledger_accounts_id_fk" FOREIGN KEY ("funds_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_maker_recalls" ADD CONSTRAINT "market_maker_recalls_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_maker_recalls_ledger_unique" ON "market_maker_recalls" USING btree ("ledger_entry_id");
--> statement-breakpoint
-- #181 has no execution-policy entry point yet. No legacy completion/ledger backfill.
REVOKE UPDATE, DELETE ON TABLE market_maker_recalls FROM buddha_app;
--> statement-breakpoint
CREATE TRIGGER market_maker_recalls_keep_record BEFORE UPDATE OR DELETE ON market_maker_recalls
FOR EACH ROW EXECUTE FUNCTION market_maker_keep_record();
--> statement-breakpoint
-- All current books must reconcile before transferring any Coin. This is read-only and is
-- shared by the internal primitive and the raw completion guard, including NULL-version legacy.
CREATE FUNCTION market_maker_recall_ready(of_market uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m markets%ROWTYPE; f ledger_accounts%ROWTYPE; treasury bigint;
BEGIN
  SELECT * INTO m FROM markets WHERE id=of_market;
  IF m.id IS NULL OR m.status NOT IN ('settled','cancelled') THEN RETURN false; END IF;
  IF m.status_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM market_events ev
    WHERE ev.id=m.status_event_id AND ev.market_id=m.id AND ev.type=CASE WHEN m.status='settled' THEN 'finalized' ELSE 'cancelled' END AND ev.to_status=m.status)
    THEN RETURN false; END IF;
  IF reconciliation_correction_obligation(m.id) IS DISTINCT FROM 0::bigint THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM orders WHERE market_id=m.id AND status IN ('open','partially_filled'))
    OR EXISTS(SELECT 1 FROM positions WHERE market_id=m.id AND (qty<>0 OR cost_basis_coin<>0 OR locked_qty<>0))
    THEN RETURN false; END IF;
  IF m.status='cancelled' AND (m.resolved_result IS NOT NULL OR EXISTS(SELECT 1 FROM fills
    WHERE market_id=m.id AND (is_human_account_type(incoming_account_type) OR is_human_account_type(resting_account_type))))
    THEN RETURN false; END IF;
  SELECT * INTO f FROM ledger_accounts WHERE kind='market_maker_funds' AND market_id=m.id;
  SELECT id INTO treasury FROM ledger_accounts WHERE kind='treasury';
  IF f.id IS NULL THEN
    IF EXISTS(SELECT 1 FROM market_maker_allocations WHERE market_id=m.id)
      OR EXISTS(SELECT 1 FROM positions WHERE market_id=m.id AND NOT is_human_account(user_id))
      OR EXISTS(SELECT 1 FROM orders WHERE market_id=m.id AND NOT is_human_account(user_id))
      THEN RETURN false; END IF;
  ELSIF treasury IS NULL OR NOT EXISTS(SELECT 1 FROM "user" u WHERE u.id=f.owner_id AND u.account_type='market_maker') THEN
    RETURN false;
  END IF;
  IF EXISTS(SELECT 1 FROM ledger_accounts a LEFT JOIN balances b ON b.account_id=a.id
    WHERE (a.market_id=m.id OR a.kind='treasury') AND
      (b.account_id IS NULL OR b.locked_coin<>0 OR b.available_coin<0 OR b.available_coin<>b.ledger_coin
       OR b.ledger_coin<>ledger_account_last_after(a.id)
       OR b.ledger_coin<>(SELECT coalesce(sum(CASE WHEN e.to_account_id=a.id THEN e.amount_coin ELSE -e.amount_coin END),0)
         FROM ledger_entries e WHERE e.to_account_id=a.id OR e.from_account_id=a.id)
       OR (a.kind='market_collateral' AND b.available_coin<>0))) THEN RETURN false; END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION market_maker_recall_findings(of_market uuid) RETURNS SETOF text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r market_maker_recalls%ROWTYPE; m markets%ROWTYPE; f bigint; treasury bigint; e ledger_entries%ROWTYPE; c bigint;
BEGIN
  SELECT * INTO r FROM market_maker_recalls WHERE market_id=of_market;
  SELECT id INTO f FROM ledger_accounts WHERE kind='market_maker_funds' AND market_id=of_market;
  SELECT count(*) INTO c FROM ledger_entries WHERE type='BOT_RECALL' AND (market_id=of_market OR from_account_id=f);
  IF r.market_id IS NULL THEN
    IF c<>0 THEN RETURN NEXT 'recall ledger has no permanent completion'; END IF;
    RETURN;
  END IF;
  SELECT * INTO m FROM markets WHERE id=of_market;
  IF m.id IS NULL OR m.status::text<>r.terminal_status OR m.status_event_id IS DISTINCT FROM r.status_event_id
    OR m.judgement_version IS DISTINCT FROM r.judgement_version THEN RETURN NEXT 'recall terminal evidence changed'; END IF;
  IF f IS DISTINCT FROM r.funds_account_id THEN RETURN NEXT 'recall funds identity changed'; END IF;
  IF f IS NOT NULL AND NOT EXISTS(SELECT 1 FROM balances b WHERE b.account_id=f
    AND b.available_coin=0 AND b.locked_coin=0 AND b.ledger_coin=0
    AND ledger_account_last_after(f)=0
    AND (SELECT coalesce(sum(CASE WHEN le.to_account_id=f THEN le.amount_coin ELSE -le.amount_coin END),0)
      FROM ledger_entries le WHERE le.to_account_id=f OR le.from_account_id=f)=0)
    THEN RETURN NEXT 'completed recall has remaining or inconsistent funds'; END IF;
  IF r.amount_coin=0 THEN
    IF r.ledger_entry_id IS NOT NULL OR c<>0 THEN RETURN NEXT 'zero recall has a ledger transfer'; END IF;
  ELSE
    SELECT * INTO e FROM ledger_entries WHERE id=r.ledger_entry_id;
    SELECT id INTO treasury FROM ledger_accounts WHERE kind='treasury';
    IF c<>1 OR e.id IS NULL OR e.type<>'BOT_RECALL' OR e.market_id IS DISTINCT FROM r.market_id
      OR e.from_account_id IS DISTINCT FROM f OR e.to_account_id IS DISTINCT FROM treasury
      OR e.amount_coin<>r.amount_coin OR e.from_balance_after_coin<>0
      OR e.ref_type<>'market' OR e.ref_id<>r.market_id::text OR e.idempotency_key<>r.market_id::text
      OR e.created_at<>r.completed_at THEN RETURN NEXT 'recall ledger does not match its completion'; END IF;
  END IF;
END;
$$;
--> statement-breakpoint
-- Take the market lock before the existing alphabetically later ledger_entries_check takes money.
CREATE FUNCTION ledger_entries_recall_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.market_id IS NULL THEN RAISE EXCEPTION 'recall needs its market' USING ERRCODE='check_violation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.market_id::text));
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_00_recall_lock BEFORE INSERT ON ledger_entries
FOR EACH ROW WHEN(NEW.type='BOT_RECALL') EXECUTE FUNCTION ledger_entries_recall_lock();
--> statement-breakpoint
CREATE FUNCTION market_maker_recalls_check_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m markets%ROWTYPE; f bigint; e ledger_entries%ROWTYPE; ledger_xid xid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.market_id::text));
  SELECT * INTO m FROM markets WHERE id=NEW.market_id FOR UPDATE;
  PERFORM b.account_id FROM balances b JOIN ledger_accounts a ON a.id=b.account_id
    WHERE a.market_id=NEW.market_id OR a.kind='treasury' ORDER BY b.account_id FOR UPDATE OF b;
  SELECT id INTO f FROM ledger_accounts WHERE kind='market_maker_funds' AND market_id=NEW.market_id;
  IF NEW.applied_txid IS DISTINCT FROM pg_current_xact_id()::text
    OR m.status::text IS DISTINCT FROM NEW.terminal_status
    OR m.status_event_id IS DISTINCT FROM NEW.status_event_id
    OR m.judgement_version IS DISTINCT FROM NEW.judgement_version
    OR f IS DISTINCT FROM NEW.funds_account_id
    OR NOT market_maker_recall_ready(NEW.market_id)
    OR EXISTS(SELECT 1 FROM reconciliation_holds WHERE market_id=NEW.market_id AND recovered_at IS NULL)
    OR EXISTS(SELECT 1 FROM market_pauses p WHERE p.market_id=NEW.market_id AND p.reason='ledger_failure'
      AND (p.ended_at IS NULL OR p.end_kind='closed_at_close')
      AND NOT EXISTS(SELECT 1 FROM reconciliation_recoveries r WHERE r.legacy_pause_id=p.id))
    OR (f IS NOT NULL AND NOT EXISTS(SELECT 1 FROM balances WHERE account_id=f AND available_coin=0 AND locked_coin=0 AND ledger_coin=0)) THEN
    RAISE EXCEPTION 'recall completion needs reconciled terminal books and zero remaining funds' USING ERRCODE='check_violation';
  END IF;
  IF NEW.amount_coin>0 THEN
    SELECT * INTO e FROM ledger_entries WHERE id=NEW.ledger_entry_id;
    SELECT xmin INTO ledger_xid FROM ledger_entries WHERE id=NEW.ledger_entry_id;
    IF e.id IS NULL OR e.type<>'BOT_RECALL' OR e.amount_coin<>NEW.amount_coin OR e.market_id IS DISTINCT FROM NEW.market_id
      OR e.from_account_id IS DISTINCT FROM f
      OR e.to_account_id IS DISTINCT FROM (SELECT id FROM ledger_accounts WHERE kind='treasury')
      OR e.from_balance_after_coin<>0 OR e.ref_type<>'market' OR e.ref_id<>NEW.market_id::text
      OR e.idempotency_key<>NEW.market_id::text OR e.created_at<>NEW.completed_at
      OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='transactionid'
        AND transactionid=ledger_xid AND mode='ExclusiveLock' AND granted) THEN
      RAISE EXCEPTION 'recall needs its exact full transfer in this transaction' USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER market_maker_recalls_check_insert BEFORE INSERT ON market_maker_recalls
FOR EACH ROW EXECUTE FUNCTION market_maker_recalls_check_insert();
--> statement-breakpoint
CREATE FUNCTION market_maker_recalls_check_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM market_maker_recall_findings(NEW.market_id))
    OR NOT market_maker_recall_ready(NEW.market_id)
    OR EXISTS(SELECT 1 FROM reconciliation_holds WHERE market_id=NEW.market_id AND recovered_at IS NULL)
    OR EXISTS(SELECT 1 FROM market_pauses p WHERE p.market_id=NEW.market_id AND p.reason='ledger_failure'
      AND (p.ended_at IS NULL OR p.end_kind='closed_at_close')
      AND NOT EXISTS(SELECT 1 FROM reconciliation_recoveries r WHERE r.legacy_pause_id=p.id)) THEN
    RAISE EXCEPTION 'recall completion and its full transfer must commit together' USING ERRCODE='check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER market_maker_recalls_check_commit AFTER INSERT ON market_maker_recalls
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION market_maker_recalls_check_commit();
--> statement-breakpoint
CREATE FUNCTION ledger_entries_recall_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM market_maker_recalls r WHERE r.ledger_entry_id=NEW.id
    AND r.market_id=NEW.market_id AND r.amount_coin=NEW.amount_coin
    AND r.applied_txid=pg_current_xact_id()::text)
    OR EXISTS(SELECT 1 FROM market_maker_recall_findings(NEW.market_id)) THEN
    RAISE EXCEPTION 'recall ledger lacks its exact permanent completion' USING ERRCODE='check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_recall_binding AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.type='BOT_RECALL')
EXECUTE FUNCTION ledger_entries_recall_binding();
