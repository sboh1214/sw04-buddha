CREATE TABLE "fill_classifications" (
	"revision" bigint PRIMARY KEY NOT NULL,
	"approval_id" uuid NOT NULL,
	"fill_id" bigint NOT NULL,
	"market_id" uuid NOT NULL,
	"action" varchar(8) NOT NULL,
	"base_revision" bigint NOT NULL,
	"before_stats_revision" bigint NOT NULL,
	"after_stats_revision" bigint NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text NOT NULL,
	"performed_at" timestamp (3) with time zone NOT NULL,
	"applied_txid" text NOT NULL,
	CONSTRAINT "fill_classifications_action_check" CHECK ("fill_classifications"."action" IN ('mark','clear')),
	CONSTRAINT "fill_classifications_revision_check" CHECK ("fill_classifications"."revision">0 AND "fill_classifications"."base_revision">=0 AND "fill_classifications"."base_revision"<"fill_classifications"."revision"),
	CONSTRAINT "fill_classifications_stats_check" CHECK ("fill_classifications"."before_stats_revision">=0 AND "fill_classifications"."after_stats_revision"="fill_classifications"."before_stats_revision"+1),
	CONSTRAINT "fill_classifications_admin_check" CHECK ("fill_classifications"."requested_by"<>"fill_classifications"."approved_by")
);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "stats_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fill_classifications" ADD CONSTRAINT "fill_classifications_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fill_classifications" ADD CONSTRAINT "fill_classifications_fill_id_fills_id_fk" FOREIGN KEY ("fill_id") REFERENCES "public"."fills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fill_classifications" ADD CONSTRAINT "fill_classifications_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fill_classifications" ADD CONSTRAINT "fill_classifications_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fill_classifications" ADD CONSTRAINT "fill_classifications_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fill_classifications_approval_unique" ON "fill_classifications" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "fill_classifications_fill_revision_idx" ON "fill_classifications" USING btree ("fill_id","revision" desc);--> statement-breakpoint
CREATE INDEX "fill_classifications_market_revision_idx" ON "fill_classifications" USING btree ("market_id","revision" desc);--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_stats_revision_check" CHECK ("markets"."stats_revision" >= 0);
--> statement-breakpoint
-- #132: decisions are immutable; only participant/ranking views change.
CREATE FUNCTION fill_classification_current_write(row_xid xid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE top_xid numeric:=pg_current_xact_id()::text::numeric; full_xid numeric;
BEGIN
  full_xid:=top_xid+mod(row_xid::text::numeric-mod(top_xid,4294967296)+4294967296,4294967296);
  RETURN pg_xact_status(full_xid::text::xid8)='in progress';
EXCEPTION WHEN invalid_parameter_value OR numeric_value_out_of_range THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION fill_classification_is_excluded(target bigint, cutoff bigint DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT action='mark' FROM fill_classifications
   WHERE fill_id=target AND revision<=coalesce(cutoff,(SELECT coalesce(max(revision),0) FROM fill_classifications))
   ORDER BY revision DESC LIMIT 1),false)
$$;
--> statement-breakpoint
CREATE FUNCTION fill_classification_participants(target uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT count(DISTINCT participant.id)::integer FROM fills f
 CROSS JOIN LATERAL (VALUES
   (f.incoming_owner_id,is_human_account_type(f.incoming_account_type)),
   (f.resting_owner_id,is_human_account_type(f.resting_account_type))
 ) participant(id,human)
 WHERE f.market_id=target AND participant.human AND NOT fill_classification_is_excluded(f.id)
$$;
--> statement-breakpoint
CREATE FUNCTION fill_classification_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a approval_requests%ROWTYPE; axid xid; f fills%ROWTYPE; prior fill_classifications%ROWTYPE;
 current_revision bigint; current_stats bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.market_id::text));
 PERFORM pg_advisory_xact_lock_shared(hashtext('buddha:admin_roles'));
 SELECT * INTO f FROM fills WHERE id=NEW.fill_id;
 IF NOT FOUND OR f.market_id<>NEW.market_id THEN RAISE EXCEPTION 'classification fill identity'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('buddha:fill_classifications'),1);
 SELECT coalesce(max(revision),0)+1 INTO current_revision FROM fill_classifications;
 IF current_revision IS NULL OR current_revision<>NEW.revision THEN RAISE EXCEPTION 'classification clock binding'; END IF;
 SELECT * INTO a FROM approval_requests WHERE id=NEW.approval_id FOR UPDATE;
 SELECT xmin INTO axid FROM approval_requests WHERE id=NEW.approval_id;
 IF a.id IS NULL OR a.kind<>'fill_classification' OR a.target_type IS DISTINCT FROM 'fill'
   OR a.target_id IS DISTINCT FROM NEW.fill_id::text OR a.status<>'approved'
   OR a.requested_by IS DISTINCT FROM NEW.requested_by OR a.decided_by IS DISTINCT FROM NEW.approved_by
   OR a.requested_by=a.decided_by OR NOT fill_classification_current_write(axid)
   OR NEW.applied_txid<>pg_current_xact_id()::text
   OR a.payload IS DISTINCT FROM jsonb_build_object('fillId',NEW.fill_id::text,'marketId',NEW.market_id::text,
     'action',NEW.action,'baseRevision',NEW.base_revision::text)
 THEN RAISE EXCEPTION 'classification approved request binding'; END IF;
 IF (SELECT count(*) FROM profiles WHERE user_id IN (NEW.requested_by,NEW.approved_by)
    AND role='admin' AND closed_at IS NULL)<>2 THEN RAISE EXCEPTION 'classification current administrators'; END IF;
 SELECT * INTO prior FROM fill_classifications WHERE fill_id=NEW.fill_id ORDER BY revision DESC LIMIT 1;
 IF NEW.base_revision<>coalesce(prior.revision,0) OR (NEW.action='mark')=coalesce(prior.action='mark',false)
 THEN RAISE EXCEPTION 'classification stale or unchanged'; END IF;
 SELECT stats_revision INTO current_stats FROM markets WHERE id=NEW.market_id;
 IF current_stats IS DISTINCT FROM NEW.before_stats_revision THEN RAISE EXCEPTION 'classification stats binding'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fill_classifications_insert_guard BEFORE INSERT ON fill_classifications
 FOR EACH ROW EXECUTE FUNCTION fill_classification_insert_guard();
--> statement-breakpoint
CREATE FUNCTION fill_classifications_keep_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'fill classifications are immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER fill_classifications_keep_record BEFORE UPDATE OR DELETE ON fill_classifications
 FOR EACH ROW EXECUTE FUNCTION fill_classifications_keep_record();
--> statement-breakpoint
CREATE FUNCTION fill_classifications_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m markets%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='fill_classifications' THEN
   SELECT * INTO m FROM markets WHERE id=NEW.market_id;
   IF m.trader_count<>fill_classification_participants(NEW.market_id) OR m.stats_revision<NEW.after_stats_revision
   THEN RAISE EXCEPTION 'classification requires participant projection'; END IF;
   IF (SELECT count(*) FROM profiles WHERE user_id IN(NEW.requested_by,NEW.approved_by)
       AND role='admin' AND closed_at IS NULL)<>2
   THEN RAISE EXCEPTION 'classification administrators changed before commit'; END IF;
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER fill_classifications_complete AFTER INSERT ON fill_classifications
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fill_classifications_complete();
--> statement-breakpoint
CREATE FUNCTION fill_classification_approval_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.kind='fill_classification' AND NEW.status='approved' AND NOT EXISTS(
   SELECT 1 FROM fill_classifications c WHERE c.approval_id=NEW.id AND c.applied_txid=pg_current_xact_id()::text
 ) THEN RAISE EXCEPTION 'approved classification requires immutable decision'; END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER fill_classification_approval_complete AFTER UPDATE ON approval_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fill_classification_approval_complete();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE fill_classifications FROM buddha_app;

--> statement-breakpoint
-- Requeue a classified market's final projection if it changes after an explicit constraint
-- flush. Ordinary intakes only read the latest indexed decision; they do not recount fills.
CREATE FUNCTION fill_classification_market_stats_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE latest fill_classifications%ROWTYPE; current_market markets%ROWTYPE;
BEGIN
 SELECT * INTO latest FROM fill_classifications WHERE market_id=NEW.id ORDER BY revision DESC LIMIT 1;
 IF NOT FOUND OR latest.applied_txid<>pg_current_xact_id()::text THEN RETURN NULL; END IF;
 SELECT * INTO current_market FROM markets WHERE id=NEW.id;
 IF current_market.trader_count<>fill_classification_participants(NEW.id)
    OR current_market.stats_revision<latest.after_stats_revision
 THEN RAISE EXCEPTION 'classification requires participant projection'; END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER fill_classification_market_stats_complete
 AFTER UPDATE OF trader_count,stats_revision ON markets DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN(OLD.trader_count IS DISTINCT FROM NEW.trader_count OR OLD.stats_revision IS DISTINCT FROM NEW.stats_revision)
 EXECUTE FUNCTION fill_classification_market_stats_complete();
--> statement-breakpoint
-- #132 locked intake: probe one market/owner on each side, rather than unrelated fill history.
CREATE INDEX "fills_market_id_incoming_owner_id_idx" ON "fills" USING btree ("market_id","incoming_owner_id");--> statement-breakpoint
CREATE INDEX "fills_market_id_resting_owner_id_idx" ON "fills" USING btree ("market_id","resting_owner_id");
