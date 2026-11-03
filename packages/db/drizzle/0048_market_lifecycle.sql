-- #174: the market lifecycle becomes the plan's eleven statuses and the result type YES/NO/VOID
-- is stored apart from the status and from the contract side `outcome` (N03 §3, ADR-0093). The
-- deployed database is wiped once more — accounts included, testers sign up again — and the seed
-- that runs after every migrate refills it (ADR-0093 decision 3, the #174 'DB 초기화' row; it
-- stands in for ADR-0071 answer 1's reset after #70). Hand-edited after `drizzle-kit generate`:
--
-- 1. The wipe comes first, as in 0017: every table in schema `public` is truncated, RESTART
--    IDENTITY CASCADE; `drizzle.__drizzle_migrations` is another schema and survives. The
--    statement is WIPE_PUBLIC_TABLES_SQL (src/wipe.ts); wipe.test.ts keeps the copies identical.
-- 2. With every table empty, drizzle-kit's rebuild of `market_status` (column to text, DROP TYPE,
--    CREATE TYPE, cast back) has no row to fail the cast: `voided` goes and six values come,
--    eleven in all.
--    drizzle-kit also cast `market_events.from_status`/`to_status` there, before the ADD COLUMN
--    that creates them; those four statements were removed, and the columns are added after the
--    type exists.
-- 3. `markets.resolved_result` moves from the contract side `outcome` to the new `market_result`
--    (YES, NO, VOID); `voided_at` goes with the status.
--
-- Redis and the media bucket are not touched: delayed close/finalize jobs that name a deleted
-- market fail as not found until they run out of attempts, and the bucket keeps the images of the
-- deleted rows until deploy/reset-db.sh empties it (docs/RESET.md).
DO $$
DECLARE
  table_list text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename)
    INTO table_list
    FROM pg_tables
   WHERE schemaname = 'public';
  IF table_list IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY CASCADE';
  END IF;
END
$$;--> statement-breakpoint
CREATE TYPE "public"."market_result" AS ENUM('YES', 'NO', 'VOID');--> statement-breakpoint
ALTER TABLE "markets" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "markets" ALTER COLUMN "status" SET DEFAULT 'draft'::text;--> statement-breakpoint
DROP TYPE "public"."market_status";--> statement-breakpoint
CREATE TYPE "public"."market_status" AS ENUM('draft', 'review', 'scheduled', 'open', 'paused', 'closed', 'provisional', 'resolved', 'settling', 'settled', 'cancelled');--> statement-breakpoint
ALTER TABLE "markets" ALTER COLUMN "status" SET DEFAULT 'draft'::"public"."market_status";--> statement-breakpoint
ALTER TABLE "markets" ALTER COLUMN "status" SET DATA TYPE "public"."market_status" USING "status"::"public"."market_status";--> statement-breakpoint
ALTER TABLE "markets" ALTER COLUMN "resolved_result" SET DATA TYPE "public"."market_result" USING "resolved_result"::text::"public"."market_result";--> statement-breakpoint
ALTER TABLE "market_events" ADD COLUMN "from_status" "market_status";--> statement-breakpoint
ALTER TABLE "market_events" ADD COLUMN "to_status" "market_status";--> statement-breakpoint
ALTER TABLE "markets" DROP COLUMN "voided_at";--> statement-breakpoint
ALTER TABLE "market_events" ADD CONSTRAINT "market_events_status_change_check" CHECK ("market_events"."from_status" IS NULL OR ("market_events"."to_status" IS NOT NULL AND "market_events"."to_status" <> "market_events"."from_status"));