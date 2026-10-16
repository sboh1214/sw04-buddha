-- #89 관심 시장 (ADR-0061 decision 3, ADR-0064): the markets an account watches now, one row per
-- (account, market), and the append-only history of every watch and unwatch (#95). As generated,
-- with this comment and the REVOKE at the end added by hand; the snapshot is as generated.
CREATE TABLE "market_watch_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"market_id" uuid NOT NULL,
	"action" varchar(16) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_watch_events_action_check" CHECK ("market_watch_events"."action" IN ('watch', 'unwatch'))
);
--> statement-breakpoint
CREATE TABLE "market_watches" (
	"user_id" text NOT NULL,
	"market_id" uuid NOT NULL,
	"watched_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_watches_user_id_market_id_pk" PRIMARY KEY("user_id","market_id")
);
--> statement-breakpoint
ALTER TABLE "market_watch_events" ADD CONSTRAINT "market_watch_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_watch_events" ADD CONSTRAINT "market_watch_events_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_watches" ADD CONSTRAINT "market_watches_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_watches" ADD CONSTRAINT "market_watches_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_watch_events_market_id_id_idx" ON "market_watch_events" USING btree ("market_id","id");--> statement-breakpoint
CREATE INDEX "market_watch_events_user_id_id_idx" ON "market_watch_events" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "market_watches_user_id_watched_at_market_id_idx" ON "market_watches" USING btree ("user_id","watched_at" desc,"market_id" desc);--> statement-breakpoint
CREATE INDEX "market_watches_market_id_idx" ON "market_watches" USING btree ("market_id");--> statement-breakpoint
-- Hand-edited: append-only like ledger_entries, market_events, admin_actions (0001) and
-- payment_events (0015). The default privileges of docker/postgres/init/01-roles.sql granted
-- buddha_app full DML at CREATE time above; this REVOKE, issued by the owner, leaves INSERT/SELECT.
-- market_watches keeps them all: an unwatch DELETEs its row.
REVOKE UPDATE, DELETE ON TABLE "market_watch_events" FROM buddha_app;
