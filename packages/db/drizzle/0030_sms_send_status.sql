-- #183 SMS 발송 현황 (owner decision 2026-10-18, second round, ADR-0070): the admin's send status
-- counts what the provider said of each send. phone_verification_codes.send_outcome is 'unknown'
-- from the insert (the row is written before the provider is asked) until the provider takes the
-- text ('accepted'); a send whose answer never came stays 'unknown' (SMS_SEND_UNCONFIRMED). Rows
-- before this migration (local databases only: 0028 and 0029 ship with it) read 'unknown' — nothing
-- recorded what their provider said. A send the provider certainly refused is still deleted from
-- phone_verification_codes (no limit counts it); phone_verification_refused_sends keeps its time
-- alone — no account, number, name or address — and the API deletes its rows older than eight
-- days. buddha_app keeps SELECT, INSERT and DELETE of the default privileges of
-- docker/postgres/init/01-roles.sql; UPDATE is revoked by hand below (a refusal's time never
-- changes). As generated otherwise; the snapshot is as generated.
CREATE TABLE "phone_verification_refused_sends" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"attempted_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phone_verification_codes" ADD COLUMN "send_outcome" varchar(8) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
CREATE INDEX "phone_verification_refused_sends_attempted_at_idx" ON "phone_verification_refused_sends" USING btree ("attempted_at");--> statement-breakpoint
ALTER TABLE "phone_verification_codes" ADD CONSTRAINT "phone_verification_codes_send_outcome_check" CHECK ("phone_verification_codes"."send_outcome" IN ('accepted', 'unknown'));--> statement-breakpoint
REVOKE UPDATE ON TABLE "phone_verification_refused_sends" FROM buddha_app;
