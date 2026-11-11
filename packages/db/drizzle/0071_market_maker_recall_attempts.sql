CREATE TABLE "market_maker_recall_attempts" (
	"market_id" uuid PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"state" varchar(16) NOT NULL,
	"reason" text,
	"last_attempt_at" timestamp (3) with time zone NOT NULL,
	"last_failure_at" timestamp (3) with time zone,
	"last_failure_reason" text,
	CONSTRAINT "market_maker_recall_attempts_count_check" CHECK ("market_maker_recall_attempts"."attempts" > 0),
	CONSTRAINT "market_maker_recall_attempts_state_check" CHECK ("market_maker_recall_attempts"."state" IN ('waiting','failed','completed')),
	CONSTRAINT "market_maker_recall_attempts_reason_check" CHECK (("market_maker_recall_attempts"."state"='completed' AND "market_maker_recall_attempts"."reason" IS NULL) OR ("market_maker_recall_attempts"."state"='waiting' AND "market_maker_recall_attempts"."reason" IS NOT NULL AND "market_maker_recall_attempts"."reason" IN ('ledger_hold','treasury_capacity')) OR ("market_maker_recall_attempts"."state"='failed' AND "market_maker_recall_attempts"."reason" IS NOT NULL AND "market_maker_recall_attempts"."reason" IN ('books_inconsistent','recall_inconsistent','execution_failed'))),
	CONSTRAINT "market_maker_recall_attempts_failure_check" CHECK (("market_maker_recall_attempts"."last_failure_at" IS NULL AND "market_maker_recall_attempts"."last_failure_reason" IS NULL) OR ("market_maker_recall_attempts"."last_failure_at" IS NOT NULL AND "market_maker_recall_attempts"."last_failure_reason" IS NOT NULL AND "market_maker_recall_attempts"."last_failure_reason" IN ('books_inconsistent','recall_inconsistent','execution_failed')))
);
--> statement-breakpoint
ALTER TABLE "market_maker_recall_attempts" ADD CONSTRAINT "market_maker_recall_attempts_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;