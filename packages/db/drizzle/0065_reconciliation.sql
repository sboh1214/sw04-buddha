-- #93: immutable observations, persistent holds, approved recoveries and narrowly approved Coin
-- corrections. No historical backfill. Legacy ledger pauses are imported on their first audit.
ALTER TYPE "public"."order_reject_reason" ADD VALUE 'ledger_hold';--> statement-breakpoint
-- A held account is rejected before reference/protection lookup. Cast the enum to text so the
-- new reason can be mentioned in the same migration transaction that adds its enum value.
ALTER TABLE "orders" DROP CONSTRAINT "orders_protection_check";
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_protection_check" CHECK (
  CASE "time_in_force"
    WHEN 'gtc' THEN "protected_limit_price" = "limit_price"
      AND "reference_price" IS NULL AND "protection_ticks" IS NULL
    ELSE CASE WHEN "protection_ticks" IS NULL
      THEN "reference_price" IS NULL AND "protected_limit_price" = "limit_price"
        AND "reject_reason" IS NOT NULL
        AND "reject_reason"::text IN ('not_open_yet', 'paused', 'closed', 'ledger_hold')
      ELSE ("reference_price" IS NULL AND "protected_limit_price" = "limit_price")
        OR ("side" = 'buy' AND "protected_limit_price"
            = LEAST("limit_price", "reference_price" + "protection_ticks", 99))
        OR ("side" = 'sell' AND "protected_limit_price"
            = GREATEST("limit_price", "reference_price" - "protection_ticks", 1))
      END
    END
);
--> statement-breakpoint
CREATE TABLE "reconciliation_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(20) NOT NULL,
	"target_key" text NOT NULL,
	"market_id" uuid,
	"user_id" text,
	"failure_result_id" bigint,
	"legacy_pause_id" uuid,
	"started_at" timestamp (3) with time zone NOT NULL,
	"recovered_at" timestamp (3) with time zone,
	CONSTRAINT "reconciliation_holds_target_check" CHECK (("reconciliation_holds"."scope" = 'market' AND "reconciliation_holds"."market_id" IS NOT NULL AND "reconciliation_holds"."user_id" IS NULL) OR ("reconciliation_holds"."scope" = 'account' AND "reconciliation_holds"."market_id" IS NULL AND "reconciliation_holds"."user_id" IS NOT NULL)),
	CONSTRAINT "reconciliation_holds_evidence_check" CHECK ("reconciliation_holds"."failure_result_id" IS NOT NULL OR "reconciliation_holds"."legacy_pause_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hold_id" uuid NOT NULL,
	"result_id" bigint NOT NULL,
	"approval_id" uuid NOT NULL,
	"legacy_pause_id" uuid,
	"requested_by" text NOT NULL,
	"approved_by" text NOT NULL,
	"recovered_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "reconciliation_recoveries_hold_unique" UNIQUE("hold_id"),
	CONSTRAINT "reconciliation_recoveries_approval_unique" UNIQUE("approval_id"),
	CONSTRAINT "reconciliation_recoveries_pause_unique" UNIQUE("legacy_pause_id"),
	CONSTRAINT "reconciliation_recoveries_other_admin_check" CHECK ("reconciliation_recoveries"."requested_by" <> "reconciliation_recoveries"."approved_by")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" varchar(20) NOT NULL,
	"target_key" text NOT NULL,
	"market_id" uuid,
	"account_id" bigint,
	"user_id" text,
	"source" varchar(20) NOT NULL,
	"actor_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"passed" boolean NOT NULL,
	"checked_at" timestamp (3) with time zone NOT NULL,
	"ledger_cursor" bigint NOT NULL,
	"findings" jsonb NOT NULL,
	"facts" jsonb NOT NULL,
	CONSTRAINT "reconciliation_results_scope_check" CHECK ("reconciliation_results"."scope" IN ('market','account','supply')),
	CONSTRAINT "reconciliation_results_target_check" CHECK (("reconciliation_results"."scope"='market' AND "reconciliation_results"."market_id" IS NOT NULL AND "reconciliation_results"."account_id" IS NULL AND "reconciliation_results"."user_id" IS NULL AND "reconciliation_results"."target_key"='market:'||"reconciliation_results"."market_id"::text) OR ("reconciliation_results"."scope"='account' AND "reconciliation_results"."market_id" IS NULL AND (("reconciliation_results"."user_id" IS NOT NULL AND "reconciliation_results"."target_key"='user:'||"reconciliation_results"."user_id") OR ("reconciliation_results"."user_id" IS NULL AND "reconciliation_results"."account_id" IS NOT NULL AND "reconciliation_results"."target_key"='account:'||"reconciliation_results"."account_id"::text))) OR ("reconciliation_results"."scope"='supply' AND "reconciliation_results"."market_id" IS NULL AND "reconciliation_results"."account_id" IS NULL AND "reconciliation_results"."user_id" IS NULL AND "reconciliation_results"."target_key"='supply')),
	CONSTRAINT "reconciliation_results_source_check" CHECK ("reconciliation_results"."source" IN ('scheduled','manual','recovery')),
	CONSTRAINT "reconciliation_results_findings_check" CHECK (jsonb_typeof("reconciliation_results"."findings") = 'array' AND "reconciliation_results"."passed" = (jsonb_array_length("reconciliation_results"."findings") = 0))
);
--> statement-breakpoint
ALTER TABLE "market_pauses" ALTER COLUMN "paused_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_holds" ADD CONSTRAINT "reconciliation_holds_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_holds" ADD CONSTRAINT "reconciliation_holds_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_holds" ADD CONSTRAINT "reconciliation_holds_failure_result_id_reconciliation_results_id_fk" FOREIGN KEY ("failure_result_id") REFERENCES "public"."reconciliation_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_holds" ADD CONSTRAINT "reconciliation_holds_legacy_pause_id_market_pauses_id_fk" FOREIGN KEY ("legacy_pause_id") REFERENCES "public"."market_pauses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_recoveries" ADD CONSTRAINT "reconciliation_recoveries_hold_id_reconciliation_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."reconciliation_holds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_recoveries" ADD CONSTRAINT "reconciliation_recoveries_result_id_reconciliation_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."reconciliation_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_recoveries" ADD CONSTRAINT "reconciliation_recoveries_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_recoveries" ADD CONSTRAINT "reconciliation_recoveries_legacy_pause_id_market_pauses_id_fk" FOREIGN KEY ("legacy_pause_id") REFERENCES "public"."market_pauses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_recoveries" ADD CONSTRAINT "reconciliation_recoveries_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_recoveries" ADD CONSTRAINT "reconciliation_recoveries_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_holds_target_active_uidx" ON "reconciliation_holds" USING btree ("target_key") WHERE "reconciliation_holds"."recovered_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reconciliation_results_target_latest_idx" ON "reconciliation_results" USING btree ("target_key","id" desc);--> statement-breakpoint
CREATE INDEX "reconciliation_results_checked_idx" ON "reconciliation_results" USING btree ("checked_at" desc,"id" desc);--> statement-breakpoint
ALTER TABLE "market_pauses" ADD CONSTRAINT "market_pauses_system_actor_check" CHECK ("market_pauses"."paused_by" IS NOT NULL OR ("market_pauses"."reason"='ledger_failure' AND "market_pauses"."note"='담보·원장 대사에서 불일치가 확인되어 거래를 일시 중단했습니다.'));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE reconciliation_results, reconciliation_recoveries FROM buddha_app;
--> statement-breakpoint
REVOKE DELETE ON TABLE reconciliation_holds FROM buddha_app;
--> statement-breakpoint
CREATE FUNCTION reconciliation_keep_record() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is a permanent reconciliation record', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reconciliation_results_keep_record BEFORE UPDATE OR DELETE ON reconciliation_results
FOR EACH ROW EXECUTE FUNCTION reconciliation_keep_record();
--> statement-breakpoint
CREATE TRIGGER reconciliation_recoveries_keep_record BEFORE UPDATE OR DELETE ON reconciliation_recoveries
FOR EACH ROW EXECUTE FUNCTION reconciliation_keep_record();
--> statement-breakpoint
CREATE FUNCTION reconciliation_holds_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE observation reconciliation_results%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'a reconciliation hold is permanent' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF NEW.market_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.market_id::text));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('reconciliation:user'),hashtext(NEW.user_id));
  END IF;
  IF NEW.target_key IS DISTINCT FROM (CASE WHEN NEW.scope='market' THEN 'market:'||NEW.market_id::text ELSE 'user:'||NEW.user_id END) THEN
    RAISE EXCEPTION 'hold target does not match its key' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.recovered_at IS NOT NULL OR
       (NEW.id,NEW.scope,NEW.target_key,NEW.market_id,NEW.user_id,NEW.started_at)
         IS DISTINCT FROM (OLD.id,OLD.scope,OLD.target_key,OLD.market_id,OLD.user_id,OLD.started_at) OR
       (OLD.legacy_pause_id IS NOT NULL AND NEW.legacy_pause_id IS DISTINCT FROM OLD.legacy_pause_id) THEN
      RAISE EXCEPTION 'a hold changes only for new failure evidence or approved recovery' USING ERRCODE='integrity_constraint_violation';
    END IF;
    IF NEW.recovered_at IS NOT NULL THEN
      IF (NEW.failure_result_id,NEW.legacy_pause_id) IS DISTINCT FROM (OLD.failure_result_id,OLD.legacy_pause_id)
        OR NOT EXISTS (SELECT 1 FROM reconciliation_recoveries r WHERE r.hold_id=NEW.id AND r.recovered_at=NEW.recovered_at) THEN
        RAISE EXCEPTION 'a hold ends only with its approved recovery' USING ERRCODE='integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.failure_result_id IS DISTINCT FROM OLD.failure_result_id
      AND coalesce(NEW.failure_result_id,0)<=coalesce(OLD.failure_result_id,0) THEN
      RAISE EXCEPTION 'a hold cannot forget failure evidence' USING ERRCODE='integrity_constraint_violation';
    END IF;
  ELSIF NEW.recovered_at IS NOT NULL THEN
    RAISE EXCEPTION 'a new hold starts active' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF NEW.failure_result_id IS NOT NULL THEN
    SELECT * INTO observation FROM reconciliation_results WHERE id=NEW.failure_result_id;
    IF NOT FOUND OR observation.passed OR observation.target_key<>NEW.target_key THEN
      RAISE EXCEPTION 'a hold must name a failed observation of its target' USING ERRCODE='integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.legacy_pause_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM market_pauses p WHERE p.id=NEW.legacy_pause_id AND p.market_id=NEW.market_id
      AND p.reason='ledger_failure' AND (p.ended_at IS NULL OR p.end_kind='closed_at_close')
      AND NOT EXISTS (SELECT 1 FROM reconciliation_recoveries r WHERE r.legacy_pause_id=p.id)) THEN
    RAISE EXCEPTION 'a legacy hold names an unrecovered ledger pause' USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reconciliation_holds_check BEFORE INSERT OR UPDATE OR DELETE ON reconciliation_holds
FOR EACH ROW EXECUTE FUNCTION reconciliation_holds_check();
--> statement-breakpoint
CREATE FUNCTION reconciliation_recoveries_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE held reconciliation_holds%ROWTYPE;
observation reconciliation_results%ROWTYPE;
approval approval_requests%ROWTYPE;
evidence jsonb;
BEGIN
  SELECT * INTO held FROM reconciliation_holds WHERE id=NEW.hold_id FOR UPDATE;
  SELECT * INTO observation FROM reconciliation_results WHERE id=NEW.result_id;
  SELECT * INTO approval FROM approval_requests WHERE id=NEW.approval_id;
  IF held.id IS NULL OR held.recovered_at IS NOT NULL OR observation.id IS NULL OR NOT observation.passed
    OR observation.target_key<>held.target_key OR observation.source<>'recovery'
    OR observation.actor_id IS DISTINCT FROM NEW.approved_by
    OR observation.id IS DISTINCT FROM (SELECT max(id) FROM reconciliation_results WHERE target_key=held.target_key)
    OR observation.checked_at<held.started_at OR NEW.recovered_at<observation.checked_at
    OR NEW.legacy_pause_id IS DISTINCT FROM held.legacy_pause_id
    OR approval.status IS DISTINCT FROM 'approved' OR approval.requested_by IS DISTINCT FROM NEW.requested_by
    OR approval.decided_by IS DISTINCT FROM NEW.approved_by THEN
    RAISE EXCEPTION 'recovery needs its active hold, latest fresh pass and approved other admin' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF approval.kind='market_pause_decision' THEN
    IF held.market_id IS NULL OR approval.target_type IS DISTINCT FROM 'market' OR approval.target_id IS DISTINCT FROM held.market_id::text THEN
      RAISE EXCEPTION 'pause recovery approval target mismatch' USING ERRCODE='integrity_constraint_violation';
    END IF;
    evidence:=approval.payload->'recovery';
  ELSIF approval.kind='reconciliation_recovery' THEN
    IF approval.target_type IS DISTINCT FROM 'reconciliation_hold' OR approval.target_id IS DISTINCT FROM held.id::text THEN
      RAISE EXCEPTION 'recovery approval target mismatch' USING ERRCODE='integrity_constraint_violation';
    END IF;
    evidence:=approval.payload;
  ELSE
    RAISE EXCEPTION 'approval kind cannot recover a hold' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF evidence->>'holdId' IS DISTINCT FROM held.id::text OR NOT (evidence ? 'failureResultId')
    OR evidence->>'failureResultId' IS DISTINCT FROM held.failure_result_id::text THEN
    RAISE EXCEPTION 'recovery approval evidence is stale' USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reconciliation_recoveries_check BEFORE INSERT ON reconciliation_recoveries
FOR EACH ROW EXECUTE FUNCTION reconciliation_recoveries_check();
--> statement-breakpoint
CREATE FUNCTION reconciliation_recovery_completed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reconciliation_holds h WHERE h.id=NEW.hold_id AND h.recovered_at=NEW.recovered_at) THEN
    RAISE EXCEPTION 'recovery and hold completion must commit together' USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER reconciliation_recovery_completed AFTER INSERT ON reconciliation_recoveries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconciliation_recovery_completed();

--> statement-breakpoint
CREATE TABLE "reconciliation_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" bigint NOT NULL,
	"ledger_entry_id" bigint,
	"approval_id" uuid NOT NULL,
	"failure_result_id" bigint NOT NULL,
	"audit_failure_id" bigint NOT NULL,
	"hold_id" uuid,
	"account_id" bigint NOT NULL,
	"user_id" text,
	"mode" varchar(24) NOT NULL,
	"amount_coin" bigint NOT NULL,
	"balance_delta_coin" bigint NOT NULL,
	"balance_before_coin" bigint NOT NULL,
	"balance_after_coin" bigint NOT NULL,
	"ledger_before_coin" bigint NOT NULL,
	"ledger_after_coin" bigint NOT NULL,
	"locked_coin" bigint NOT NULL,
	"candidate" jsonb NOT NULL,
	"user_reason" text,
	"requested_by" text NOT NULL,
	"approved_by" text NOT NULL,
	"applied_txid" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "reconciliation_corrections_mode_check" CHECK ("reconciliation_corrections"."mode" IN ('restore_actual','replenish_ledger','fund_collateral','return_collateral')),
	CONSTRAINT "reconciliation_corrections_amount_check" CHECK ("reconciliation_corrections"."amount_coin">0 AND "reconciliation_corrections"."balance_before_coin">=0 AND "reconciliation_corrections"."balance_after_coin">=0 AND "reconciliation_corrections"."ledger_before_coin">=0 AND "reconciliation_corrections"."ledger_after_coin">=0 AND "reconciliation_corrections"."locked_coin">=0),
	CONSTRAINT "reconciliation_corrections_admin_check" CHECK ("reconciliation_corrections"."requested_by"<>"reconciliation_corrections"."approved_by"),
	CONSTRAINT "reconciliation_corrections_user_reason_check" CHECK (("reconciliation_corrections"."user_id" IS NULL AND "reconciliation_corrections"."user_reason" IS NULL) OR ("reconciliation_corrections"."user_id" IS NOT NULL AND "reconciliation_corrections"."user_reason" IS NOT NULL AND length(btrim("reconciliation_corrections"."user_reason")) BETWEEN 1 AND 500)),
	CONSTRAINT "reconciliation_corrections_delta_check" CHECK ("reconciliation_corrections"."balance_after_coin"-"reconciliation_corrections"."balance_before_coin"="reconciliation_corrections"."balance_delta_coin"),
	CONSTRAINT "reconciliation_corrections_entry_check" CHECK (("reconciliation_corrections"."mode"='restore_actual')=("reconciliation_corrections"."ledger_entry_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "reconciliation_corrections" ADD CONSTRAINT "reconciliation_corrections_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_corrections" ADD CONSTRAINT "reconciliation_corrections_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_corrections" ADD CONSTRAINT "reconciliation_corrections_failure_result_id_reconciliation_results_id_fk" FOREIGN KEY ("failure_result_id") REFERENCES "public"."reconciliation_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_corrections" ADD CONSTRAINT "reconciliation_corrections_audit_failure_id_audit_failures_id_fk" FOREIGN KEY ("audit_failure_id") REFERENCES "public"."audit_failures"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_corrections" ADD CONSTRAINT "reconciliation_corrections_hold_id_reconciliation_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."reconciliation_holds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_corrections" ADD CONSTRAINT "reconciliation_corrections_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_corrections" ADD CONSTRAINT "reconciliation_corrections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_corrections" ADD CONSTRAINT "reconciliation_corrections_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_corrections" ADD CONSTRAINT "reconciliation_corrections_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_corrections_approval_unique" ON "reconciliation_corrections" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_corrections_event_unique" ON "reconciliation_corrections" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_corrections_ledger_unique" ON "reconciliation_corrections" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE INDEX "reconciliation_corrections_user_event_idx" ON "reconciliation_corrections" USING btree ("user_id","event_id");--> statement-breakpoint
CREATE INDEX "reconciliation_corrections_account_idx" ON "reconciliation_corrections" USING btree ("account_id","event_id");
--> statement-breakpoint
-- #93 Coin correction. Read helpers have no side effects. The sole financial writer below
-- owns its table INSERT; no GUC, temporary object, or caller-supplied amount authorizes a gap.
CREATE FUNCTION reconciliation_correction_book(of_account bigint) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'accountId', a.id::text, 'accountKind', a.kind::text,
    'userId', CASE WHEN a.kind='user' THEN a.owner_id END, 'marketId',a.market_id,
    'available',b.available_coin::text,'locked',b.locked_coin::text,'ledger',b.ledger_coin::text,
    'sum',(SELECT coalesce(sum(CASE WHEN e.to_account_id=a.id THEN e.amount_coin ELSE -e.amount_coin END),0)::text
      FROM ledger_entries e WHERE e.from_account_id=a.id OR e.to_account_id=a.id),
    'last',ledger_account_last_after(a.id)::text,
    'cursor',greatest(
      (SELECT coalesce(max(id),0) FROM ledger_entries e WHERE e.from_account_id=a.id OR e.to_account_id=a.id),
      (SELECT coalesce(max(event_id),0) FROM reconciliation_corrections c WHERE c.account_id=a.id))::text,
    'expectedLocked',(SELECT coalesce(sum(o.protected_limit_price::bigint*(o.qty-o.filled_qty)),0)::text
      FROM orders o WHERE o.status IN ('open','partially_filled') AND o.side='buy'
        AND ((a.kind='user' AND o.user_id=a.owner_id)
          OR (a.kind='market_maker_funds' AND o.market_id=a.market_id AND o.user_id=a.owner_id))))
  FROM ledger_accounts a LEFT JOIN balances b ON b.account_id=a.id WHERE a.id=of_account
$$;
--> statement-breakpoint
-- NULL means that a Coin correction would hide a contract/lock/settlement defect. This mirrors
-- the settlement claim checks, but deliberately leaves collateral's Coin amount for correction.
CREATE FUNCTION reconciliation_correction_obligation(of_market uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE m markets%ROWTYPE; collateral bigint; principal bigint; y bigint; n bigint;
owed bigint; paid bigint; settling boolean;
BEGIN
  SELECT * INTO m FROM markets WHERE id=of_market;
  IF m.id IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM positions WHERE market_id=m.id AND qty=0 AND cost_basis_coin<>0) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM positions p LEFT JOIN profiles pr ON pr.user_id=p.user_id
    WHERE p.market_id=m.id AND p.qty>0 AND is_human_account(p.user_id)
      AND (pr.user_id IS NULL OR pr.closed_at IS NOT NULL)) THEN RETURN NULL; END IF;
  settling := m.status IN ('settling','settled');
  IF settling AND m.resolved_result IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO collateral FROM ledger_accounts WHERE kind='market_collateral' AND market_id=m.id;
  IF EXISTS (SELECT 1 FROM orders o WHERE o.market_id=m.id AND o.status IN ('open','partially_filled')
    AND NOT is_human_account(o.user_id)) AND NOT EXISTS
    (SELECT 1 FROM ledger_accounts WHERE market_id=m.id AND kind='market_maker_funds') THEN RETURN NULL; END IF;
  IF EXISTS (
    WITH expected AS (SELECT user_id,outcome,sum(qty-filled_qty) AS qty FROM orders
      WHERE market_id=m.id AND status IN ('open','partially_filled') AND side='sell' GROUP BY user_id,outcome)
    SELECT 1 FROM (SELECT * FROM positions WHERE market_id=m.id) p FULL JOIN expected e
      ON p.user_id=e.user_id AND p.outcome=e.outcome WHERE coalesce(p.locked_qty,0)<>coalesce(e.qty,0)
  ) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM positions WHERE market_id=m.id AND settled AND (qty<>0 OR cost_basis_coin<>0 OR locked_qty<>0))
    OR (m.status='settled' AND EXISTS (SELECT 1 FROM positions WHERE market_id=m.id AND NOT settled))
    OR (m.status='settled' AND EXISTS (SELECT 1 FROM orders WHERE market_id=m.id AND status IN ('open','partially_filled')))
    THEN RETURN NULL; END IF;
  IF NOT settling AND (EXISTS (SELECT 1 FROM position_settlements WHERE market_id=m.id)
    OR EXISTS (SELECT 1 FROM ledger_entries WHERE market_id=m.id AND type='SETTLEMENT_PAYOUT')) THEN RETURN NULL; END IF;
  IF settling AND m.judgement_version IS NOT NULL AND NOT EXISTS (SELECT 1 FROM market_judgements j
    WHERE j.market_id=m.id AND j.version=m.judgement_version AND j.result=m.resolved_result
      AND j.rule_version IS NOT DISTINCT FROM m.rule_version) THEN RETURN NULL; END IF;
  IF settling AND EXISTS (
    SELECT 1 FROM position_settlements s LEFT JOIN positions p
      ON p.market_id=s.market_id AND p.user_id=s.user_id AND p.outcome=s.outcome
    LEFT JOIN ledger_entries e ON e.id=s.ledger_entry_id
    LEFT JOIN ledger_accounts recipient ON recipient.id=e.to_account_id
    WHERE s.market_id=m.id AND (p.user_id IS NULL OR NOT p.settled OR p.qty<>0 OR p.locked_qty<>0 OR p.cost_basis_coin<>0
      OR s.judgement_version IS DISTINCT FROM m.judgement_version OR s.rule_version IS DISTINCT FROM m.rule_version
      OR s.result<>m.resolved_result OR s.qty<=0 OR s.cost_basis_coin<0
      OR s.payout_per_contract_coin<>CASE WHEN m.resolved_result='VOID' THEN 50 WHEN m.resolved_result::text=s.outcome::text THEN 100 ELSE 0 END
      OR s.payout_coin<>s.qty::bigint*s.payout_per_contract_coin
      OR s.settlement_pnl_coin<>s.payout_coin-s.cost_basis_coin
      OR p.realized_pnl_coin<>s.realized_pnl_before_coin+s.settlement_pnl_coin
      OR (s.payout_coin=0 AND s.ledger_entry_id IS NOT NULL)
      OR (s.payout_coin>0 AND (e.id IS NULL OR e.type<>'SETTLEMENT_PAYOUT' OR e.amount_coin<>s.payout_coin
        OR e.from_account_id IS DISTINCT FROM collateral OR e.market_id IS DISTINCT FROM m.id
        OR e.ref_type<>'market' OR e.ref_id<>m.id::text OR e.created_at<>s.settled_at
        OR e.idempotency_key<>m.id::text||':'||coalesce(s.judgement_version::text,'legacy')||':'||s.user_id||':'||s.outcome::text
        OR recipient.owner_id IS DISTINCT FROM s.user_id
        OR NOT ((recipient.kind='user' AND is_human_account(s.user_id))
          OR (recipient.kind='market_maker_funds' AND recipient.market_id=m.id AND NOT is_human_account(s.user_id))))))
  ) THEN RETURN NULL; END IF;
  IF settling AND EXISTS (SELECT 1 FROM ledger_entries e WHERE e.market_id=m.id AND e.type='SETTLEMENT_PAYOUT'
    AND NOT EXISTS (SELECT 1 FROM position_settlements s WHERE s.market_id=m.id AND s.ledger_entry_id=e.id)) THEN RETURN NULL; END IF;
  SELECT coalesce(sum(CASE WHEN outcome='YES' THEN qty ELSE 0 END),0),
    coalesce(sum(CASE WHEN outcome='NO' THEN qty ELSE 0 END),0) INTO y,n FROM (
    SELECT outcome,qty FROM positions WHERE market_id=m.id AND NOT settled
    UNION ALL SELECT outcome,qty FROM position_settlements WHERE market_id=m.id) claims;
  SELECT coalesce(sum(CASE WHEN type='PAIR_MINT_COLLATERAL' THEN amount_coin
    WHEN type='PAIR_BURN_RETURN' THEN -amount_coin ELSE 0 END),0) INTO principal FROM ledger_entries WHERE market_id=m.id;
  IF y<>n OR principal<>y*100 THEN RETURN NULL; END IF;
  IF NOT settling THEN RETURN y*100; END IF;
  SELECT coalesce(sum(qty::bigint*CASE WHEN m.resolved_result='VOID' THEN 50
    WHEN m.resolved_result::text=outcome::text THEN 100 ELSE 0 END),0) INTO owed
    FROM positions WHERE market_id=m.id AND NOT settled;
  SELECT coalesce(sum(payout_coin),0) INTO paid FROM position_settlements WHERE market_id=m.id;
  IF owed+paid<>principal THEN RETURN NULL; END IF;
  RETURN owed;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION reconciliation_correction_candidates(of_result bigint) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r reconciliation_results%ROWTYPE; a ledger_accounts%ROWTYPE; b jsonb; original jsonb;
held uuid; obligation bigint; actual bigint; carried bigint; gap bigint; original_gap bigint;
amount bigint; delta bigint; mode text; snapshot jsonb; scope_books jsonb;
BEGIN
  SELECT * INTO r FROM reconciliation_results WHERE id=of_result;
  IF r.id IS NULL OR r.passed OR r.scope='supply' OR NOT EXISTS
    (SELECT 1 FROM audit_failures f WHERE f.kind=r.scope||'_reconciliation_mismatch' AND f.payload->>'resultId'=r.id::text)
    THEN RETURN; END IF;
  SELECT id INTO held FROM reconciliation_holds WHERE target_key=r.target_key AND recovered_at IS NULL;
  IF (r.market_id IS NOT NULL OR r.user_id IS NOT NULL) AND held IS NULL THEN RETURN; END IF;
  -- A later generation is a different incident even if its numbers happen to be identical.
  IF held IS NOT NULL AND (SELECT started_at FROM reconciliation_holds WHERE id=held)>r.checked_at THEN RETURN; END IF;
  IF r.market_id IS NOT NULL THEN
    obligation:=reconciliation_correction_obligation(r.market_id);
    IF obligation IS NULL THEN RETURN; END IF;
    SELECT jsonb_agg(reconciliation_correction_book(id) ORDER BY id) INTO scope_books
      FROM ledger_accounts WHERE market_id=r.market_id;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(scope_books,'[]')) x
      WHERE x->>'available' IS NULL OR x->>'ledger' IS DISTINCT FROM x->>'sum'
        OR x->>'last' IS DISTINCT FROM x->>'sum' OR x->>'locked' IS DISTINCT FROM x->>'expectedLocked') THEN RETURN; END IF;
    snapshot:=jsonb_build_object('accounts',scope_books,'obligation',obligation::text,
      'market',(SELECT jsonb_build_object('status',status,'result',resolved_result,'judgementVersion',judgement_version,'ruleVersion',rule_version)
        FROM markets WHERE id=r.market_id),
      'positions',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY user_id,outcome),'[]') FROM positions p WHERE market_id=r.market_id),
      'records',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY user_id,outcome),'[]') FROM position_settlements s WHERE market_id=r.market_id),
      'orders',(SELECT coalesce(jsonb_agg(jsonb_build_array(id,status,side,qty,filled_qty,protected_limit_price) ORDER BY id),'[]')
        FROM orders WHERE market_id=r.market_id AND status IN ('open','partially_filled')));
  END IF;
  FOR a IN SELECT * FROM ledger_accounts WHERE (r.market_id IS NOT NULL AND market_id=r.market_id)
    OR (r.market_id IS NULL AND id=r.account_id) ORDER BY id LOOP
    b:=reconciliation_correction_book(a.id);
    IF b->>'available' IS NULL OR b->>'ledger' IS DISTINCT FROM b->>'sum' OR b->>'last' IS DISTINCT FROM b->>'sum'
      OR b->>'locked' IS DISTINCT FROM b->>'expectedLocked'
      OR (a.kind='user' AND NOT EXISTS (SELECT 1 FROM profiles WHERE user_id=a.owner_id AND closed_at IS NULL)) THEN CONTINUE; END IF;
    IF r.market_id IS NOT NULL THEN
      SELECT x INTO original FROM jsonb_array_elements(r.facts->'accounts') x WHERE x->>'accountId'=a.id::text;
    ELSE original:=r.facts; END IF;
    IF original IS NULL OR original->>'accountId' IS DISTINCT FROM a.id::text THEN CONTINUE; END IF;
    actual:=(b->>'available')::bigint+(b->>'locked')::bigint; carried:=(b->>'ledger')::bigint; gap:=actual-carried;
    original_gap:=(original->>'availableCoin')::bigint+(original->>'lockedCoin')::bigint-(original->>'ledgerSumCoin')::bigint;
    IF original->>'ledgerCoin' IS DISTINCT FROM original->>'ledgerSumCoin' THEN CONTINUE; END IF;
    mode:=NULL; amount:=0; delta:=0;
    IF gap<0 AND gap=original_gap THEN mode:='restore_actual'; amount:=-gap; delta:=amount;
    ELSIF gap>0 AND gap=original_gap AND a.kind<>'treasury' THEN mode:='replenish_ledger'; amount:=gap;
    ELSIF gap=0 AND a.kind='market_collateral' AND actual<>obligation
      AND r.facts->>'requiredCollateralCoin'=obligation::text AND original_gap=0
      AND (original->>'availableCoin')::bigint+(original->>'lockedCoin')::bigint=actual THEN
      amount:=abs(obligation-actual); delta:=obligation-actual;
      mode:=CASE WHEN delta>0 THEN 'fund_collateral' ELSE 'return_collateral' END;
    END IF;
    IF mode IS NULL OR amount<=0 THEN CONTINUE; END IF;
    RETURN NEXT jsonb_build_object('accountId',a.id::text,'accountKind',a.kind::text,
      'userId',CASE WHEN a.kind='user' THEN a.owner_id END,'marketId',a.market_id,'holdId',held,
      'mode',mode,'amountCoin',amount::text,'balanceDeltaCoin',delta::text,
      'balanceBeforeCoin',actual::text,'balanceAfterCoin',(actual+delta)::text,
      'ledgerBeforeCoin',carried::text,'ledgerAfterCoin',(CASE WHEN mode='restore_actual' THEN carried
        WHEN mode='replenish_ledger' THEN carried+amount ELSE carried+delta END)::text,
      'snapshotKey',md5(jsonb_build_object('target',b,'scope',snapshot,'holdId',held)::text));
  END LOOP;
END;
$$;
--> statement-breakpoint
-- The identical lock order is used by the TypeScript request/decision path before approval rows.
CREATE FUNCTION lock_reconciliation_correction(of_result bigint, of_account bigint) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r reconciliation_results%ROWTYPE; a ledger_accounts%ROWTYPE;
BEGIN
  SELECT * INTO r FROM reconciliation_results WHERE id=of_result;
  SELECT * INTO a FROM ledger_accounts WHERE id=of_account;
  IF r.id IS NULL OR a.id IS NULL OR NOT ((r.market_id IS NOT NULL AND a.market_id=r.market_id)
    OR (r.market_id IS NULL AND r.account_id=a.id)) THEN
    RAISE EXCEPTION 'reconciliation_correction:not_found'; END IF;
  IF a.market_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(a.market_id::text));
    PERFORM 1 FROM markets WHERE id=a.market_id FOR UPDATE;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtext('buddha:admin_roles'));
  IF a.kind='user' THEN
    PERFORM pg_advisory_xact_lock(hashtext('reconciliation:user'),hashtext(a.owner_id));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('reconciliation:account'),hashtext(a.id::text));
  END IF;
  INSERT INTO ledger_accounts(kind) VALUES ('treasury') ON CONFLICT DO NOTHING;
  PERFORM 1 FROM balances b JOIN ledger_accounts la ON la.id=b.account_id
    WHERE la.id=a.id OR la.kind='treasury' OR (a.market_id IS NOT NULL AND la.market_id=a.market_id)
    ORDER BY b.account_id FOR UPDATE OF b;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION apply_reconciliation_correction(of_approval uuid, requester text, approver text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE approval approval_requests%ROWTYPE; c jsonb; old_record reconciliation_corrections%ROWTYPE;
r reconciliation_results%ROWTYPE; target ledger_accounts%ROWTYPE; t balances%ROWTYPE; b balances%ROWTYPE;
treasury bigint; amount bigint; delta bigint; ledger_after bigint; mode text; eid bigint; record_id uuid;
failure bigint; at timestamptz; from_id bigint; to_id bigint; from_after bigint; to_after bigint;
BEGIN
  SELECT * INTO approval FROM approval_requests WHERE id=of_approval;
  IF approval.id IS NULL THEN RAISE EXCEPTION 'reconciliation_correction:not_found'; END IF;
  PERFORM lock_reconciliation_correction((approval.payload->>'failureResultId')::bigint,
    (approval.payload->'candidate'->>'accountId')::bigint);
  SELECT * INTO approval FROM approval_requests WHERE id=of_approval FOR UPDATE;
  IF requester=approver THEN RAISE EXCEPTION 'reconciliation_correction:requester'; END IF;
  IF approval.kind<>'reconciliation_correction' OR approval.status<>'approved'
    OR approval.requested_by IS DISTINCT FROM requester OR approval.decided_by IS DISTINCT FROM approver
    OR NOT EXISTS (SELECT 1 FROM profiles WHERE user_id=requester AND role='admin' AND closed_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM profiles WHERE user_id=approver AND role='admin' AND closed_at IS NULL)
    OR approval.target_type IS DISTINCT FROM 'ledger_account'
    OR approval.target_id IS DISTINCT FROM approval.payload->'candidate'->>'accountId' THEN
    RAISE EXCEPTION 'reconciliation_correction:approval'; END IF;
  SELECT * INTO old_record FROM reconciliation_corrections WHERE approval_id=approval.id;
  IF old_record.id IS NOT NULL THEN RETURN jsonb_build_object('id',old_record.id,'recorded',false); END IF;
  SELECT * INTO r FROM reconciliation_results WHERE id=(approval.payload->>'failureResultId')::bigint;
  SELECT candidate INTO c FROM reconciliation_correction_candidates(r.id) candidate
    WHERE candidate=approval.payload->'candidate';
  IF c IS NULL THEN RAISE EXCEPTION 'reconciliation_correction:stale'; END IF;
  SELECT * INTO target FROM ledger_accounts WHERE id=(c->>'accountId')::bigint;
  SELECT * INTO b FROM balances WHERE account_id=target.id;
  SELECT id INTO treasury FROM ledger_accounts WHERE kind='treasury';
  SELECT * INTO t FROM balances WHERE account_id=treasury;
  mode:=c->>'mode'; amount:=(c->>'amountCoin')::bigint; delta:=(c->>'balanceDeltaCoin')::bigint;
  ledger_after:=(c->>'ledgerAfterCoin')::bigint;
  IF (target.kind='user' AND (approval.payload->>'userReason' IS NULL OR length(btrim(approval.payload->>'userReason')) NOT BETWEEN 1 AND 500))
    OR (target.kind<>'user' AND approval.payload->>'userReason' IS NOT NULL) THEN
    RAISE EXCEPTION 'reconciliation_correction:approval'; END IF;
  IF mode<>'restore_actual' THEN
    IF t.account_id IS NULL OR t.locked_coin<>0 OR t.available_coin<>t.ledger_coin
      OR t.ledger_coin<>ledger_account_last_after(treasury)
      OR t.ledger_coin<>(reconciliation_correction_book(treasury)->>'sum')::bigint THEN
      RAISE EXCEPTION 'reconciliation_correction:unsupported'; END IF;
    IF mode IN ('replenish_ledger','fund_collateral') AND t.available_coin<amount THEN
      RAISE EXCEPTION 'reconciliation_correction:insufficient_treasury'; END IF;
    IF mode='return_collateral' AND (b.available_coin<amount OR b.ledger_coin<amount) THEN
      RAISE EXCEPTION 'reconciliation_correction:stale'; END IF;
  END IF;
  SELECT id INTO failure FROM audit_failures WHERE kind=r.scope||'_reconciliation_mismatch'
    AND payload->>'resultId'=r.id::text ORDER BY id LIMIT 1;
  at:=clock_timestamp(); eid:=nextval('public.ledger_entries_id_seq'); record_id:=gen_random_uuid();
  IF mode<>'restore_actual' THEN
    from_id:=CASE WHEN mode='return_collateral' THEN target.id ELSE treasury END;
    to_id:=CASE WHEN mode='return_collateral' THEN treasury ELSE target.id END;
    from_after:=CASE WHEN mode='return_collateral' THEN ledger_after ELSE t.ledger_coin-amount END;
    to_after:=CASE WHEN mode='return_collateral' THEN t.ledger_coin+amount ELSE ledger_after END;
    INSERT INTO ledger_entries(id,type,amount_coin,from_account_id,to_account_id,from_balance_after_coin,to_balance_after_coin,
      market_id,ref_type,ref_id,idempotency_key,created_at)
    VALUES(eid,'RECONCILIATION_CORRECTION',amount,from_id,to_id,from_after,to_after,target.market_id,
      'audit_failure',failure::text,approval.id::text,at);
  END IF;
  INSERT INTO reconciliation_corrections(id,event_id,ledger_entry_id,approval_id,failure_result_id,audit_failure_id,
    hold_id,account_id,user_id,mode,amount_coin,balance_delta_coin,balance_before_coin,balance_after_coin,
    ledger_before_coin,ledger_after_coin,locked_coin,candidate,user_reason,requested_by,approved_by,applied_txid,created_at)
    VALUES(record_id,eid,CASE WHEN mode='restore_actual' THEN NULL ELSE eid END,approval.id,r.id,failure,
      (c->>'holdId')::uuid,target.id,CASE WHEN target.kind='user' THEN target.owner_id END,mode,amount,delta,
      (c->>'balanceBeforeCoin')::bigint,(c->>'balanceAfterCoin')::bigint,b.ledger_coin,ledger_after,b.locked_coin,
      c,approval.payload->>'userReason',requester,approver,pg_current_xact_id()::text,at);
  UPDATE balances SET available_coin=available_coin+delta,ledger_coin=ledger_after,updated_at=at WHERE account_id=target.id;
  IF mode<>'restore_actual' THEN
    UPDATE balances SET available_coin=available_coin+CASE WHEN mode='return_collateral' THEN amount ELSE -amount END,
      ledger_coin=ledger_coin+CASE WHEN mode='return_collateral' THEN amount ELSE -amount END,updated_at=at WHERE account_id=treasury;
  END IF;
  RETURN jsonb_build_object('id',record_id,'recorded',true);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION apply_reconciliation_correction(uuid,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION apply_reconciliation_correction(uuid,text,text) TO buddha_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE reconciliation_corrections FROM buddha_app;
--> statement-breakpoint
CREATE TRIGGER reconciliation_corrections_keep_record BEFORE UPDATE OR DELETE ON reconciliation_corrections
FOR EACH ROW EXECUTE FUNCTION reconciliation_keep_record();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION balances_keep_ledger_gap() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.available_coin+NEW.locked_coin)-NEW.ledger_coin IS DISTINCT FROM
    (OLD.available_coin+OLD.locked_coin)-OLD.ledger_coin AND NOT EXISTS (
    SELECT 1 FROM reconciliation_corrections c WHERE c.account_id=NEW.account_id
      AND c.applied_txid=pg_current_xact_id()::text AND c.mode IN ('restore_actual','replenish_ledger')
      AND c.balance_before_coin=OLD.available_coin+OLD.locked_coin
      AND c.balance_after_coin=NEW.available_coin+NEW.locked_coin
      AND c.ledger_before_coin=OLD.ledger_coin AND c.ledger_after_coin=NEW.ledger_coin
      AND c.locked_coin=OLD.locked_coin AND NEW.locked_coin=OLD.locked_coin
  ) THEN
    RAISE EXCEPTION 'ledger account % moves its total apart from its ledger''s (% Coin, ledger %)',
      NEW.account_id,NEW.available_coin+NEW.locked_coin,NEW.ledger_coin
      USING ERRCODE='integrity_constraint_violation',CONSTRAINT=TG_NAME;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Even a regular recordLedgerEntry caller cannot invent a correction transfer. Only the
-- guarded function can insert the matching permanent record; validate after both rows exist.
CREATE FUNCTION ledger_entries_reconciliation_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c reconciliation_corrections%ROWTYPE; treasury bigint;
BEGIN
  SELECT * INTO c FROM reconciliation_corrections WHERE ledger_entry_id=NEW.id;
  SELECT id INTO treasury FROM ledger_accounts WHERE kind='treasury';
  IF c.id IS NULL OR c.applied_txid<>pg_current_xact_id()::text OR c.event_id<>NEW.id
    OR NEW.amount_coin<>c.amount_coin OR NEW.ref_type<>'audit_failure' OR NEW.ref_id<>c.audit_failure_id::text
    OR NEW.idempotency_key<>c.approval_id::text OR NEW.created_at<>c.created_at
    OR NEW.from_account_id IS DISTINCT FROM (CASE WHEN c.mode='return_collateral' THEN c.account_id ELSE treasury END)
    OR NEW.to_account_id IS DISTINCT FROM (CASE WHEN c.mode='return_collateral' THEN treasury ELSE c.account_id END) THEN
    RAISE EXCEPTION 'correction ledger entry needs its exact approved correction record'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_reconciliation_binding AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type='RECONCILIATION_CORRECTION')
EXECUTE FUNCTION ledger_entries_reconciliation_binding();
--> statement-breakpoint
-- A restoration consumes a ledger sequence id without a ledger row. Later raw writers must
-- still advance that account's public cursor; ledger_entries_check already holds both balances.
CREATE FUNCTION ledger_entries_restore_cursor() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM reconciliation_corrections c
    WHERE c.account_id IN (NEW.from_account_id,NEW.to_account_id) AND c.event_id>=NEW.id) THEN
    RAISE EXCEPTION 'ledger entry must follow the approved correction cursor'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_restore_cursor BEFORE INSERT ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger_entries_restore_cursor();

--> statement-breakpoint
CREATE INDEX "reconciliation_corrections_user_created_idx" ON "reconciliation_corrections" USING btree ("user_id","created_at" desc,"id" desc);
