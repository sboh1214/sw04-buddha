-- #142 판정 지연 기록 (ADR-0093 decision 1 #173 items 2, 7, 11 and 13, decision 2 #172 item 14,
-- decision 3 '#142 지연 사유', decision 4, the owner's answers of 2026-11-03; ADR-0106). Generated
-- by `drizzle-kit generate`, then hand-edited where marked: this header and the tail. The snapshot
-- is as generated.
--
-- - market_judgement_delays: one row per 판정 지연 기록 — one admin's, no approval request (#173
--   item 2) — of a market that read '판정 지연' on the database clock under the market lock (a
--   CLOSED one past its scheduled judgement, a PROVISIONAL one held past its 이의 기한; #173 items
--   7 and 11): the reason (지연 사유, one public sentence, 1–500 trimmed — no classification), the
--   next review time (다음 검토 시각, UTC: after the record and at most 7 × 24 hours later, owner
--   answer (1) — '168 hours', an elapsed interval whatever the session TimeZone, where '7 days'
--   would follow a DST change), the status and judgement version it was recorded on (none on
--   CLOSED, the version on PROVISIONAL: the episode its current record is read in), the admin,
--   the instant and its `judgement_delay_recorded` event (one record each). The newest is the
--   greatest event id, the commit order under the market lock (the index). Permanent facts (N04
--   §5): no retention; no edit and no withdrawal (owner answer (4)) — a change is a new record,
--   the earlier ones its history — so buddha_app may INSERT and SELECT only, and a trigger refuses
--   an UPDATE or a DELETE whoever writes (below).
-- - No market column: a record changes no status, no result and no scheduled judgement (#172 item
--   14; #173 item 11: the time passing creates nothing either), and the event type
--   `judgement_delay_recorded` and the admin action type `market_delay_record` are varchar values
--   (@buddha/shared). D4: nothing to migrate, since no market has a record before this migration.
CREATE TABLE "market_judgement_delays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"next_review_at" timestamp (3) with time zone NOT NULL,
	"market_status" "market_status" NOT NULL,
	"judgement_version" integer,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"event_id" bigint NOT NULL,
	CONSTRAINT "market_judgement_delays_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "market_judgement_delays_reason_check" CHECK (btrim("market_judgement_delays"."reason") <> '' AND char_length("market_judgement_delays"."reason") <= 500),
	CONSTRAINT "market_judgement_delays_market_status_check" CHECK ("market_judgement_delays"."market_status" IN ('closed', 'provisional')),
	CONSTRAINT "market_judgement_delays_judgement_version_check" CHECK (("market_judgement_delays"."market_status" <> 'closed' OR "market_judgement_delays"."judgement_version" IS NULL) AND ("market_judgement_delays"."market_status" <> 'provisional' OR ("market_judgement_delays"."judgement_version" IS NOT NULL AND "market_judgement_delays"."judgement_version" >= 1))),
	CONSTRAINT "market_judgement_delays_next_review_at_check" CHECK ("market_judgement_delays"."next_review_at" > "market_judgement_delays"."recorded_at" AND "market_judgement_delays"."next_review_at" <= "market_judgement_delays"."recorded_at" + interval '168 hours')
);
--> statement-breakpoint
ALTER TABLE "market_judgement_delays" ADD CONSTRAINT "market_judgement_delays_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_judgement_delays" ADD CONSTRAINT "market_judgement_delays_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_judgement_delays" ADD CONSTRAINT "market_judgement_delays_event_id_market_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."market_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_judgement_delays_market_id_event_id_idx" ON "market_judgement_delays" USING btree ("market_id","event_id");--> statement-breakpoint
-- Hand-edited: a delay record is a permanent fact (N04 §5), never rewritten or removed. buddha_app
-- keeps SELECT/INSERT of the default privileges in docker/postgres/init/01-roles.sql and loses
-- UPDATE and DELETE.
REVOKE UPDATE, DELETE ON TABLE "market_judgement_delays" FROM buddha_app;--> statement-breakpoint
-- Hand-edited: nor does any other role (the migration role, a script): a change is a new record
-- and the earlier ones stay as its history (owner answer 2026-11-03 (4): no withdrawal, nothing
-- deleted or hidden), and who recorded what when is kept apart from the public sentence (decision
-- 3), so a record stays as it was written, whoever writes. TRUNCATE fires no row trigger: the wipe
-- (wipe.ts) still empties the table.
CREATE FUNCTION market_judgement_delays_keep_record() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'judgement delay % of market % is a permanent record and takes no %', OLD.id,
    OLD.market_id, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER market_judgement_delays_keep_record
  BEFORE UPDATE OR DELETE ON "market_judgement_delays"
  FOR EACH ROW EXECUTE FUNCTION market_judgement_delays_keep_record();
