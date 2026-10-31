-- #17 카테고리와 태그 (ADR-0093 decision 2 #172 items 1 and 2, ADR-0096): a market's tags (tags, one
-- row per tag shared by every category; market_tags, a market's 1..5 in the order entered) and the
-- operators' category tree, which /admin/categories now writes. A tag is one per name ignoring
-- case (name_key, generated from name) and is never renamed or deleted: buddha_app's UPDATE and
-- DELETE on tags are revoked by hand below, and it keeps SELECT and INSERT of the default
-- privileges of docker/postgres/init/01-roles.sql. An edit of a market's tags deletes and inserts
-- its market_tags rows, so that table keeps every privilege. Two sibling categories never share a
-- name (categories_parent_name_ko_unique, the top level as parent 0); the seed's tree has none.
-- As generated otherwise; the snapshot is as generated.
CREATE TABLE "market_tags" (
	"market_id" uuid NOT NULL,
	"tag_id" integer NOT NULL,
	"position" smallint NOT NULL,
	CONSTRAINT "market_tags_market_id_tag_id_pk" PRIMARY KEY("market_id","tag_id"),
	CONSTRAINT "market_tags_market_id_position_unique" UNIQUE("market_id","position"),
	CONSTRAINT "market_tags_position_check" CHECK ("market_tags"."position" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(20) NOT NULL,
	"name_key" varchar(20) GENERATED ALWAYS AS (lower(name)) STORED NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_key_unique" UNIQUE("name_key")
);
--> statement-breakpoint
ALTER TABLE "market_tags" ADD CONSTRAINT "market_tags_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_tags" ADD CONSTRAINT "market_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_tags_tag_id_market_id_idx" ON "market_tags" USING btree ("tag_id","market_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_parent_name_ko_unique" ON "categories" USING btree (coalesce("parent_id", 0),"name_ko");--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "tags" FROM buddha_app;
