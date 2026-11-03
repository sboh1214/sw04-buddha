-- #23 시장 규칙 항목 (ADR-0093 decision 2 #172 items 7–10, ADR-0097): a market's rules become one
-- item each — 배경 (`description`, kept as it was), YES 조건, NO 조건, 사건 기한, 1차·대체 출처, 전환
-- 조건, 장기 지연 기한 and 지연·취소·무효 처리 — in place of the single `rules` text and the free-text
-- `resolution_source`, which are dropped with their text: an old `rules` mixes YES, NO, the
-- deadline and the delay clause, and a source a name and an address, so neither is converted
-- (D4). No wipe (ADR-0093 plans none at #23): a market from before has its new items blank, which
-- the open-items check names, and the seed fills them in each of its own drafts that still has the
-- seed's title and no admin record of rule items (ADR-0097).
--
-- - markets: the texts are NOT NULL DEFAULT '' (blank is not filled in; no CHECK holds the API's
--   5,000, as none held `rules`'), `event_deadline` and `long_delay_days` NULL until written, the
--   latter 1..365 days.
-- - market_sources: a market's 1차 출처 at priority 0 and its 대체 출처 at 1..3 in order, a name
--   and an http(s) address each (either case of the scheme), '' while not filled in, never both.
--   A write of a market's sources deletes and inserts its rows, as market_tags does, so buddha_app
--   keeps every privilege of docker/postgres/init/01-roles.sql; the market RESTRICTs.
--
-- As generated; the snapshot is as generated.
CREATE TABLE "market_sources" (
	"market_id" uuid NOT NULL,
	"priority" smallint NOT NULL,
	"name" varchar(500) DEFAULT '' NOT NULL,
	"url" varchar(500) DEFAULT '' NOT NULL,
	CONSTRAINT "market_sources_market_id_priority_pk" PRIMARY KEY("market_id","priority"),
	CONSTRAINT "market_sources_priority_check" CHECK ("market_sources"."priority" BETWEEN 0 AND 3),
	CONSTRAINT "market_sources_url_check" CHECK ("market_sources"."url" = '' OR "market_sources"."url" ~* '^https?://'),
	CONSTRAINT "market_sources_not_empty_check" CHECK ("market_sources"."name" <> '' OR "market_sources"."url" <> '')
);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "yes_condition" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "no_condition" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "event_deadline" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "fallback_condition" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "long_delay_days" smallint;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "delay_handling" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "market_sources" ADD CONSTRAINT "market_sources_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" DROP COLUMN "rules";--> statement-breakpoint
ALTER TABLE "markets" DROP COLUMN "resolution_source";--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_long_delay_days_check" CHECK ("markets"."long_delay_days" BETWEEN 1 AND 365);