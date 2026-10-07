-- ADR-0046 (#19): the judgement is final at once, there is no dispute stage, and settlement is
-- tracked per step. Hand-edited after `drizzle-kit generate`:
--
-- 1. drizzle-kit rebuilt `market_status` (column to text, DROP TYPE, CREATE TYPE, cast back),
--    which fails on every `resolving` row ('resolving'::market_status no longer exists) and
--    rewrites the table and its status indexes. RENAME VALUE changes the label in place: no
--    rewrite, every `resolving` market becomes `resolved`, and the enum keeps the order of
--    MARKET_STATUSES. It is not ADD VALUE, so the label may be used later in this transaction
--    (55P04 does not apply), which the backfill below does.
-- 2. The backfill of `market_settlement_steps` was added: one `coin` row per judged market, so
--    the worker finds every step it must finish. A settled market's step is done at its
--    `settled_at`; a market that was `resolving` gets a pending step and is settled by the
--    worker's next scan (its dispute window ends here, O-7). A voided market gets none.
-- 3. `disputes` goes last, with its type (O-8). Its rows are dropped on purpose (owner decision,
--    no backup); a dispute's deadline also survives in the `resolve_proposed`/`result_changed`
--    event payloads, and the append-only `market_events`/`admin_actions` rows are not touched.
ALTER TYPE "public"."market_status" RENAME VALUE 'resolving' TO 'resolved';--> statement-breakpoint
ALTER TABLE "markets" DROP COLUMN "dispute_until";--> statement-breakpoint
CREATE TABLE "market_settlement_steps" (
	"market_id" uuid NOT NULL,
	"step" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp (3) with time zone,
	"last_error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_settlement_steps_market_id_step_pk" PRIMARY KEY("market_id","step"),
	CONSTRAINT "market_settlement_steps_attempts_check" CHECK ("market_settlement_steps"."attempts" >= 0),
	CONSTRAINT "market_settlement_steps_completed_at_check" CHECK (("market_settlement_steps"."status" = 'done') = ("market_settlement_steps"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "market_settlement_steps" ADD CONSTRAINT "market_settlement_steps_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "market_settlement_steps" ("market_id", "step", "status", "attempts", "completed_at")
SELECT "id", 'coin', 'done', 1, COALESCE("settled_at", "updated_at") FROM "markets" WHERE "status" = 'settled';--> statement-breakpoint
INSERT INTO "market_settlement_steps" ("market_id", "step")
SELECT "id", 'coin' FROM "markets" WHERE "status" = 'resolved';--> statement-breakpoint
DROP TABLE "disputes" CASCADE;--> statement-breakpoint
DROP TYPE "public"."dispute_status";
