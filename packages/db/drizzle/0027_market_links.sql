-- #65 관련 시장 (ADR-0061 decision 1, item 19; ADR-0068): the pairs of markets an admin has linked,
-- one row per unordered pair (its smaller id, then its larger one; the CHECK keeps that order and
-- refuses a market with itself), read from either end. Unlinking deletes the row, so buddha_app
-- keeps every privilege; the history of links and unlinks is admin_actions (market_link /
-- market_unlink). As generated, with this comment added by hand; the snapshot is as generated.
CREATE TABLE "market_links" (
	"low_market_id" uuid NOT NULL,
	"high_market_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_links_low_market_id_high_market_id_pk" PRIMARY KEY("low_market_id","high_market_id"),
	CONSTRAINT "market_links_order_check" CHECK ("market_links"."low_market_id" < "market_links"."high_market_id")
);
--> statement-breakpoint
ALTER TABLE "market_links" ADD CONSTRAINT "market_links_low_market_id_markets_id_fk" FOREIGN KEY ("low_market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_links" ADD CONSTRAINT "market_links_high_market_id_markets_id_fk" FOREIGN KEY ("high_market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_links" ADD CONSTRAINT "market_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_links_high_market_id_idx" ON "market_links" USING btree ("high_market_id");
