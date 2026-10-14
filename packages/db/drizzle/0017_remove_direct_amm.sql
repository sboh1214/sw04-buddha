-- #125: users no longer trade against the direct AMM, so its market state, the slippage guard
-- columns and the enum values only it wrote are dropped, and the deployed database is wiped
-- once — accounts included, testers sign up again (owner decisions D4, D13) — for the seed that
-- runs after every migrate to refill. Hand-edited after `drizzle-kit generate`:
--
-- 1. The wipe comes first: every table in schema `public` is truncated, RESTART IDENTITY
--    CASCADE. `drizzle.__drizzle_migrations` is another schema and survives. The list is read
--    from pg_tables, so no table is missed. The statement is WIPE_PUBLIC_TABLES_SQL
--    (src/wipe.ts), which deploy/reset-db.sh runs again; wipe.test.ts keeps the two identical.
--    TRUNCATE is the owner's privilege, and migrations run as buddha_migrate, the owner.
-- 2. With every table empty, drizzle-kit's own enum rebuild (column to text, DROP TYPE, CREATE
--    TYPE, cast back) has no row to fail the cast: MARKET_VOID_REFUND, the 'open' tick trigger
--    and the 'amm' counterparty go. market_mechanism goes with markets.mechanism.
-- 3. markets.last_price becomes nullable: NULL until the first fill (N02 §5). Its 1..99 CHECK
--    is unchanged and passes a NULL.
--
-- Redis is not touched: delayed close/finalize jobs that name a deleted market fail as not
-- found until they run out of attempts (the reset procedure flushes them).
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
ALTER TABLE "fills" DROP CONSTRAINT "fills_counterparty_check";--> statement-breakpoint
ALTER TABLE "markets" DROP CONSTRAINT "markets_liquidity_b_check";--> statement-breakpoint
ALTER TABLE "markets" DROP CONSTRAINT "markets_initial_prob_bp_check";--> statement-breakpoint
ALTER TABLE "markets" DROP CONSTRAINT "markets_reserve_p_check";--> statement-breakpoint
ALTER TABLE "fills" ALTER COLUMN "counterparty_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."counterparty_type";--> statement-breakpoint
CREATE TYPE "public"."counterparty_type" AS ENUM('order');--> statement-breakpoint
ALTER TABLE "fills" ALTER COLUMN "counterparty_type" SET DATA TYPE "public"."counterparty_type" USING "counterparty_type"::"public"."counterparty_type";--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."ledger_entry_type";--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('DEPOSIT', 'TRADE_BUY', 'TRADE_SELL', 'FEE', 'SETTLEMENT_PAYOUT', 'ADMIN_ADJUST', 'BONUS', 'PAYMENT_CANCEL', 'PAYMENT_CANCEL_REVERSAL');--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "type" SET DATA TYPE "public"."ledger_entry_type" USING "type"::"public"."ledger_entry_type";--> statement-breakpoint
ALTER TABLE "price_ticks" ALTER COLUMN "trigger" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."price_tick_trigger";--> statement-breakpoint
CREATE TYPE "public"."price_tick_trigger" AS ENUM('trade', 'resolve');--> statement-breakpoint
ALTER TABLE "price_ticks" ALTER COLUMN "trigger" SET DATA TYPE "public"."price_tick_trigger" USING "trigger"::"public"."price_tick_trigger";--> statement-breakpoint
ALTER TABLE "markets" ALTER COLUMN "last_price" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" DROP COLUMN "mechanism";--> statement-breakpoint
ALTER TABLE "markets" DROP COLUMN "liquidity_b";--> statement-breakpoint
ALTER TABLE "markets" DROP COLUMN "q_yes";--> statement-breakpoint
ALTER TABLE "markets" DROP COLUMN "q_no";--> statement-breakpoint
ALTER TABLE "markets" DROP COLUMN "initial_prob_bp";--> statement-breakpoint
ALTER TABLE "markets" DROP COLUMN "reserve_p";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "max_cost_p";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "min_proceeds_p";--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_counterparty_check" CHECK ("fills"."counterparty_type" = 'order' AND "fills"."counterparty_order_id" IS NOT NULL);--> statement-breakpoint
DROP TYPE "public"."market_mechanism";