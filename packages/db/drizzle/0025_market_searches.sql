-- #15 최근 검색 (ADR-0061 decision 3, the #15 rows; ADR-0066): one row per search a signed-in
-- account submitted, the term and the time only. Deletable by the member (one term, or all), so
-- buddha_app keeps SELECT, INSERT and DELETE of the default privileges of
-- docker/postgres/init/01-roles.sql; migration 0026 revokes UPDATE (a recorded search is never
-- changed in place). As generated; only this comment was added. The snapshot is as generated.
CREATE TABLE "market_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"query" varchar(100) NOT NULL,
	"searched_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_searches" ADD CONSTRAINT "market_searches_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_searches_user_id_query_searched_at_id_idx" ON "market_searches" USING btree ("user_id","query","searched_at" desc,"id" desc);