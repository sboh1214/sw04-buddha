-- #81 테마 (ADR-0069 decision 4, the #81 rows; owner decisions 2026-10-19, ADR-0088): markets an
-- admin gathers under a name, an introduction and a period of Korean dates (themes; both days
-- included: 진행 중 from 00:00 KST of start_date, 종료 from 00:00 KST of the day after end_date), at
-- an address the admin chooses (slug, fixed once first_published_at is set), the markets in each
-- (theme_markets, one row per pair, any number, a market in any number of themes) and the page's
-- own plain-text notices (theme_notices). A theme is unpublished (published_at NULL), never
-- deleted, and a notice is hidden (hidden_at), never deleted: buddha_app's DELETE on both is revoked
-- by hand below, and it keeps SELECT, INSERT and UPDATE of the default privileges of
-- docker/postgres/init/01-roles.sql. Taking a market out of a theme deletes its theme_markets row,
-- so that table keeps every privilege. The history of every write (actor and time, no reason) is
-- admin_actions, the theme_* types. As generated otherwise; the snapshot is as generated.
CREATE TABLE "theme_markets" (
	"theme_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "theme_markets_theme_id_market_id_pk" PRIMARY KEY("theme_id","market_id")
);
--> statement-breakpoint
CREATE TABLE "theme_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"theme_id" uuid NOT NULL,
	"title" varchar(100) NOT NULL,
	"body" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp (3) with time zone,
	"hidden_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(80) NOT NULL,
	"name" varchar(100) NOT NULL,
	"intro" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"published_at" timestamp (3) with time zone,
	"first_published_at" timestamp (3) with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "themes_slug_unique" UNIQUE("slug"),
	CONSTRAINT "themes_period_check" CHECK ("themes"."end_date" >= "themes"."start_date")
);
--> statement-breakpoint
ALTER TABLE "theme_markets" ADD CONSTRAINT "theme_markets_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_markets" ADD CONSTRAINT "theme_markets_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_markets" ADD CONSTRAINT "theme_markets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_notices" ADD CONSTRAINT "theme_notices_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_notices" ADD CONSTRAINT "theme_notices_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "theme_markets_market_id_idx" ON "theme_markets" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "theme_notices_theme_id_created_at_id_idx" ON "theme_notices" USING btree ("theme_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "themes_published_end_date_idx" ON "themes" USING btree ("end_date","start_date") WHERE "themes"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "themes_created_at_id_idx" ON "themes" USING btree ("created_at" desc,"id" desc);--> statement-breakpoint
REVOKE DELETE ON TABLE "themes", "theme_notices" FROM buddha_app;
