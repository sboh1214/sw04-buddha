-- SmartroPay (ADR-0042) and the member contact it needs (ADR-0043). Hand-edited after
-- `drizzle-kit generate` in two places, marked below; the snapshot is as generated.
--
-- payments gains what a real PG reports: the PayMethod of the approval, when it was approved
-- (the admin refund window counts from there), when a refund was confirmed, and the PG's last
-- ResultMsg. A PG transaction id may name one payment only, hence the partial unique index —
-- partial because a `pending` row has no reference yet.
--
-- payment_events is the append-only record of every exchange with the PG about a payment;
-- user_contacts holds the real name and mobile number sent as BuyerName / BuyerTel.
--
-- Uses none of the enum values 0014 adds: both files usually run in one transaction (55P04).
CREATE TABLE "payment_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"type" varchar(32) NOT NULL,
	"result_code" varchar(16),
	"result_message" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_contacts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"real_name" varchar(30) NOT NULL,
	"phone" varchar(11) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "method" varchar(16);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "approved_at" timestamp (3) with time zone;--> statement-breakpoint
-- Hand-edited: every charge written before this migration is a mock charge, credited in the
-- same transaction that set it `succeeded` — so its last update IS its approval. Without this
-- the refund window would have nothing to count from for them.
UPDATE "payments" SET "approved_at" = "updated_at" WHERE "status" = 'succeeded' AND "approved_at" IS NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refunded_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "result_message" text;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_contacts" ADD CONSTRAINT "user_contacts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_events_payment_id_id_idx" ON "payment_events" USING btree ("payment_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_provider_ref_unique" ON "payments" USING btree ("provider","provider_ref") WHERE "payments"."provider_ref" is not null;--> statement-breakpoint
-- Hand-edited: append-only like ledger_entries, market_events and admin_actions (0001). The
-- default privileges of docker/postgres/init/01-roles.sql granted buddha_app full DML at CREATE
-- time above; this REVOKE, issued by the owner, leaves INSERT/SELECT.
REVOKE UPDATE, DELETE ON TABLE "payment_events" FROM buddha_app;
