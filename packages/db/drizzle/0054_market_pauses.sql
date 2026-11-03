-- #114 거래 일시 중단·재개·조기 마감 (ADR-0093 decision 1 #173 items 1–4 and 13, decision 2 #172 item
-- 14, decision 3 '#114 조기 결과의 공개 시각', the owner's answers of 2026-11-02; ADR-0102). Generated
-- by `drizzle-kit generate`, then hand-edited where marked: this header and the tail. The snapshot
-- is as generated.
--
-- - market_pauses: one row per pause of a market (OPEN → PAUSED by one admin, its `paused` event):
--   the reason (three only, #173 item 3), the admin's note (1–500), for `early_result` alone the
--   publication instant the operator confirmed (UTC, never after the pause), who paused, when and
--   the event. Ended once: 재개 (`resumed`) or 조기 마감 (`early_closed`) by an approved
--   `market_pause_decision` request — the approver, the request, the end event, and for a
--   `basis_change` pause its review result (`not_judgeable` only with an early close) — or the
--   worker's close at `close_at` (`closed_at_close`: no approver, no request). At most one lasts
--   per market (the partial unique index). Permanent facts (N04 §5): no retention; buddha_app has
--   no DELETE, and a trigger refuses a DELETE whoever writes and lets an UPDATE only end a lasting
--   pause (below).
-- - No new column elsewhere: the event and admin action types and the approval kind are varchar
--   values (@buddha/shared), and an early close keeps `markets.close_at`, a rule-version item
--   (0053's guard) — the actual close is the `closed` event's `closedAt`. D4: nothing to migrate,
--   since no market has been PAUSED.
CREATE TABLE "market_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"reason" varchar(40) NOT NULL,
	"note" text NOT NULL,
	"result_published_at" timestamp (3) with time zone,
	"paused_at" timestamp (3) with time zone NOT NULL,
	"paused_by" text NOT NULL,
	"pause_event_id" bigint NOT NULL,
	"review_result" varchar(40),
	"end_kind" varchar(40),
	"ended_at" timestamp (3) with time zone,
	"ended_by" text,
	"end_event_id" bigint,
	"end_approval_id" uuid,
	CONSTRAINT "market_pauses_end_approval_id_unique" UNIQUE("end_approval_id"),
	CONSTRAINT "market_pauses_reason_check" CHECK ("market_pauses"."reason" IN ('early_result', 'ledger_failure', 'basis_change')),
	CONSTRAINT "market_pauses_note_check" CHECK (btrim("market_pauses"."note") <> '' AND char_length("market_pauses"."note") <= 500),
	CONSTRAINT "market_pauses_result_published_at_check" CHECK (("market_pauses"."result_published_at" IS NOT NULL) = ("market_pauses"."reason" = 'early_result') AND ("market_pauses"."result_published_at" IS NULL OR "market_pauses"."result_published_at" <= "market_pauses"."paused_at")),
	CONSTRAINT "market_pauses_review_result_check" CHECK ("market_pauses"."review_result" IN ('judgeable', 'not_judgeable')),
	CONSTRAINT "market_pauses_end_kind_check" CHECK ("market_pauses"."end_kind" IN ('resumed', 'early_closed', 'closed_at_close')),
	CONSTRAINT "market_pauses_end_check" CHECK (("market_pauses"."end_kind" IS NULL) = ("market_pauses"."ended_at" IS NULL) AND ("market_pauses"."end_kind" IS NULL) = ("market_pauses"."end_event_id" IS NULL) AND ("market_pauses"."ended_at" IS NULL OR "market_pauses"."ended_at" >= "market_pauses"."paused_at") AND (coalesce("market_pauses"."end_kind", '') IN ('resumed', 'early_closed')) = ("market_pauses"."end_approval_id" IS NOT NULL) AND (coalesce("market_pauses"."end_kind", '') IN ('resumed', 'early_closed')) = ("market_pauses"."ended_by" IS NOT NULL)),
	CONSTRAINT "market_pauses_review_check" CHECK (("market_pauses"."review_result" IS NOT NULL) = ("market_pauses"."reason" = 'basis_change' AND coalesce("market_pauses"."end_kind", '') IN ('resumed', 'early_closed')) AND ("market_pauses"."review_result" IS DISTINCT FROM 'not_judgeable' OR "market_pauses"."end_kind" = 'early_closed'))
);
--> statement-breakpoint
ALTER TABLE "market_pauses" ADD CONSTRAINT "market_pauses_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_pauses" ADD CONSTRAINT "market_pauses_paused_by_user_id_fk" FOREIGN KEY ("paused_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_pauses" ADD CONSTRAINT "market_pauses_pause_event_id_market_events_id_fk" FOREIGN KEY ("pause_event_id") REFERENCES "public"."market_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_pauses" ADD CONSTRAINT "market_pauses_ended_by_user_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_pauses" ADD CONSTRAINT "market_pauses_end_event_id_market_events_id_fk" FOREIGN KEY ("end_event_id") REFERENCES "public"."market_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_pauses" ADD CONSTRAINT "market_pauses_end_approval_id_approval_requests_id_fk" FOREIGN KEY ("end_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_pauses_market_id_lasting_unique" ON "market_pauses" USING btree ("market_id") WHERE "market_pauses"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "market_pauses_market_id_paused_at_idx" ON "market_pauses" USING btree ("market_id","paused_at");--> statement-breakpoint
-- Hand-edited: a pause is a permanent fact (N04 §5), never removed. buddha_app keeps SELECT, INSERT
-- and UPDATE of the default privileges in docker/postgres/init/01-roles.sql (the end is an UPDATE)
-- and loses DELETE.
REVOKE DELETE ON TABLE "market_pauses" FROM buddha_app;--> statement-breakpoint
-- Hand-edited: nor does any other role (the migration role, a script) delete one or rewrite what it
-- recorded: the judging record shows the reason and the pause and end times (#173 item 13, #24),
-- and a pause ends once. An UPDATE ends a lasting pause — the end columns and the review result,
-- set once — and changes nothing the pause recorded; an ended pause takes none. TRUNCATE fires no
-- row trigger: the wipe (wipe.ts) still empties the table.
CREATE FUNCTION market_pauses_keep_record() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pause % of market % is a permanent record and takes no DELETE', OLD.id,
      OLD.market_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
    RAISE EXCEPTION 'pause % of market % changes only once, by its end', OLD.id, OLD.market_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW.market_id, NEW.reason, NEW.note, NEW.result_published_at, NEW.paused_at,
      NEW.paused_by, NEW.pause_event_id)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.reason, OLD.note, OLD.result_published_at, OLD.paused_at,
      OLD.paused_by, OLD.pause_event_id) THEN
    RAISE EXCEPTION 'pause % of market % keeps what its pause recorded', OLD.id, OLD.market_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER market_pauses_keep_record
  BEFORE UPDATE OR DELETE ON "market_pauses"
  FOR EACH ROW EXECUTE FUNCTION market_pauses_keep_record();
