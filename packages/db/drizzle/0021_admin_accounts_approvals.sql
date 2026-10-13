-- #171 admin accounts and the two-person rule: approval_requests (a request, then one decision
-- by an admin other than its requester) and the index the grant/revoke history reads
-- admin_actions through. Hand-edited after `drizzle-kit generate` at the end only (marked below);
-- the snapshot is as generated.
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(40) NOT NULL,
	"target_type" varchar(32),
	"target_id" text,
	"payload" jsonb,
	"requested_by" text NOT NULL,
	"request_reason" text NOT NULL,
	"requested_at" timestamp (3) with time zone NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decision_reason" text,
	"decided_at" timestamp (3) with time zone,
	CONSTRAINT "approval_requests_decision_check" CHECK (("approval_requests"."status" = 'pending') = ("approval_requests"."decided_by" IS NULL) AND ("approval_requests"."decided_by" IS NULL) = ("approval_requests"."decided_at" IS NULL) AND ("approval_requests"."decided_by" IS NULL) = ("approval_requests"."decision_reason" IS NULL)),
	CONSTRAINT "approval_requests_decider_not_requester_check" CHECK ("approval_requests"."decided_by" IS DISTINCT FROM "approval_requests"."requested_by"),
	CONSTRAINT "approval_requests_reasons_check" CHECK (btrim("approval_requests"."request_reason") <> '' AND btrim("approval_requests"."decision_reason") IS DISTINCT FROM '')
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_actions_role_change_created_at_id_idx" ON "admin_actions" USING btree ("created_at" desc,"id" desc) WHERE "admin_actions"."type" IN ('admin_grant', 'admin_revoke');--> statement-breakpoint
-- Hand-edited: a request is the record of who asked and who decided, so it is never removed;
-- buddha_app keeps SELECT/INSERT/UPDATE of the default privileges in
-- docker/postgres/init/01-roles.sql and loses DELETE.
REVOKE DELETE ON TABLE "approval_requests" FROM buddha_app;--> statement-breakpoint
-- Hand-edited: a request is written once and decided once. The request columns never change, and
-- a decided row does not change at all — not its decision, not back to pending. The CHECKs tie
-- the decision columns to the status and refuse a decision by the requester; this refuses the
-- rest, whoever writes (owner decision 2026-10-13: the rule holds in every environment).
CREATE FUNCTION approval_requests_keep_record() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'approval request % was decided (%) and cannot change', OLD.id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW.kind, NEW.target_type, NEW.target_id, NEW.payload, NEW.requested_by,
      NEW.request_reason, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.kind, OLD.target_type, OLD.target_id, OLD.payload, OLD.requested_by,
      OLD.request_reason, OLD.requested_at) THEN
    RAISE EXCEPTION 'approval request % cannot change what was requested', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER approval_requests_keep_record
  BEFORE UPDATE ON "approval_requests"
  FOR EACH ROW EXECUTE FUNCTION approval_requests_keep_record();
