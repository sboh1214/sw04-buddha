CREATE TYPE "public"."counterparty_type" AS ENUM('amm', 'order');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('DEPOSIT', 'TRADE_BUY', 'TRADE_SELL', 'FEE', 'SETTLEMENT_PAYOUT', 'MARKET_VOID_REFUND', 'ADMIN_ADJUST', 'BONUS');--> statement-breakpoint
CREATE TYPE "public"."market_mechanism" AS ENUM('lmsr', 'clob');--> statement-breakpoint
CREATE TYPE "public"."market_status" AS ENUM('draft', 'open', 'closed', 'resolving', 'settled', 'voided');--> statement-breakpoint
CREATE TYPE "public"."market_visibility" AS ENUM('public', 'group');--> statement-breakpoint
CREATE TYPE "public"."order_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('open', 'partially_filled', 'filled', 'cancelled', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('market', 'limit');--> statement-breakpoint
CREATE TYPE "public"."outcome" AS ENUM('YES', 'NO');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."price_tick_trigger" AS ENUM('trade', 'open', 'resolve');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."time_in_force" AS ENUM('ioc', 'gtc');--> statement-breakpoint
CREATE TABLE "admin_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" text NOT NULL,
	"type" varchar(40) NOT NULL,
	"target_type" varchar(32),
	"target_id" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_failures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" varchar(40) NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balances" (
	"user_id" text PRIMARY KEY NOT NULL,
	"available_p" bigint DEFAULT 0 NOT NULL,
	"locked_p" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balances_available_p_check" CHECK ("balances"."available_p" >= 0),
	CONSTRAINT "balances_locked_p_check" CHECK ("balances"."locked_p" >= 0)
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(32) NOT NULL,
	"name_ko" varchar(32) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_url" text,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"admin_note" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_market_id_user_id_unique" UNIQUE("market_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"counterparty_type" "counterparty_type" NOT NULL,
	"counterparty_order_id" uuid,
	"outcome" "outcome" NOT NULL,
	"side" "order_side" NOT NULL,
	"qty" integer NOT NULL,
	"amount_p" bigint NOT NULL,
	"price_avg_bp" integer NOT NULL,
	"fee_p" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fills_qty_check" CHECK ("fills"."qty" > 0),
	CONSTRAINT "fills_amount_p_check" CHECK ("fills"."amount_p" >= 0),
	CONSTRAINT "fills_price_avg_bp_check" CHECK ("fills"."price_avg_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "fills_fee_p_check" CHECK ("fills"."fee_p" >= 0),
	CONSTRAINT "fills_counterparty_check" CHECK (("fills"."counterparty_type" = 'amm' AND "fills"."counterparty_order_id" IS NULL) OR ("fills"."counterparty_type" = 'order' AND "fills"."counterparty_order_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" "ledger_entry_type" NOT NULL,
	"amount_p" bigint NOT NULL,
	"balance_after_p" bigint NOT NULL,
	"ref_type" varchar(32),
	"ref_id" text,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" uuid NOT NULL,
	"type" varchar(40) NOT NULL,
	"actor_id" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(80) NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" text,
	"rules" text NOT NULL,
	"resolution_source" text,
	"category_id" integer NOT NULL,
	"image_url" text,
	"mechanism" "market_mechanism" DEFAULT 'lmsr' NOT NULL,
	"status" "market_status" DEFAULT 'draft' NOT NULL,
	"visibility" "market_visibility" DEFAULT 'public' NOT NULL,
	"group_id" uuid,
	"liquidity_b" numeric(18, 6) NOT NULL,
	"q_yes" numeric(24, 10) NOT NULL,
	"q_no" numeric(24, 10) NOT NULL,
	"initial_prob_bp" smallint NOT NULL,
	"reserve_p" bigint NOT NULL,
	"last_price" smallint NOT NULL,
	"volume_p" bigint DEFAULT 0 NOT NULL,
	"trade_count" integer DEFAULT 0 NOT NULL,
	"trader_count" integer DEFAULT 0 NOT NULL,
	"taker_fee_bps" smallint DEFAULT 0 NOT NULL,
	"settlement_fee_bps" smallint DEFAULT 0 NOT NULL,
	"open_at" timestamp with time zone,
	"close_at" timestamp with time zone NOT NULL,
	"resolved_result" "outcome",
	"resolved_at" timestamp with time zone,
	"dispute_until" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_slug_unique" UNIQUE("slug"),
	CONSTRAINT "markets_liquidity_b_check" CHECK ("markets"."liquidity_b" > 0),
	CONSTRAINT "markets_initial_prob_bp_check" CHECK ("markets"."initial_prob_bp" >= 1 AND "markets"."initial_prob_bp" <= 9999),
	CONSTRAINT "markets_last_price_check" CHECK ("markets"."last_price" >= 1 AND "markets"."last_price" <= 99),
	CONSTRAINT "markets_reserve_p_check" CHECK ("markets"."reserve_p" >= 0),
	CONSTRAINT "markets_volume_p_check" CHECK ("markets"."volume_p" >= 0),
	CONSTRAINT "markets_trade_count_check" CHECK ("markets"."trade_count" >= 0),
	CONSTRAINT "markets_trader_count_check" CHECK ("markets"."trader_count" >= 0),
	CONSTRAINT "markets_fee_bps_check" CHECK ("markets"."taker_fee_bps" BETWEEN 0 AND 10000 AND "markets"."settlement_fee_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"market_id" uuid NOT NULL,
	"outcome" "outcome" NOT NULL,
	"side" "order_side" NOT NULL,
	"type" "order_type" NOT NULL,
	"limit_price" smallint,
	"qty" integer NOT NULL,
	"filled_qty" integer DEFAULT 0 NOT NULL,
	"status" "order_status" NOT NULL,
	"time_in_force" time_in_force DEFAULT 'ioc' NOT NULL,
	"idempotency_key" text NOT NULL,
	"max_cost_p" bigint,
	"min_proceeds_p" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "orders_qty_check" CHECK ("orders"."qty" > 0),
	CONSTRAINT "orders_filled_qty_check" CHECK ("orders"."filled_qty" >= 0 AND "orders"."filled_qty" <= "orders"."qty"),
	CONSTRAINT "orders_limit_price_check" CHECK ("orders"."limit_price" IS NULL OR "orders"."limit_price" BETWEEN 1 AND 99),
	CONSTRAINT "orders_type_limit_price_check" CHECK (("orders"."type" = 'limit') = ("orders"."limit_price" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"amount_p" bigint NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_ref" text,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_p_check" CHECK ("payments"."amount_p" > 0)
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"user_id" text NOT NULL,
	"market_id" uuid NOT NULL,
	"outcome" "outcome" NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"cost_basis_p" bigint DEFAULT 0 NOT NULL,
	"realized_pnl_p" bigint DEFAULT 0 NOT NULL,
	"settled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_user_id_market_id_outcome_pk" PRIMARY KEY("user_id","market_id","outcome"),
	CONSTRAINT "positions_qty_check" CHECK ("positions"."qty" >= 0),
	CONSTRAINT "positions_cost_basis_p_check" CHECK ("positions"."cost_basis_p" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_ticks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"p_yes_bp" integer NOT NULL,
	"trigger" "price_tick_trigger" NOT NULL,
	CONSTRAINT "price_ticks_p_yes_bp_check" CHECK ("price_ticks"."p_yes_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"nickname" varchar(20) NOT NULL,
	"role" "role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_nickname_unique" UNIQUE("nickname")
);
--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_admin_id_user_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_counterparty_order_id_orders_id_fk" FOREIGN KEY ("counterparty_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_events" ADD CONSTRAINT "market_events_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_ticks" ADD CONSTRAINT "price_ticks_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "fills_market_id_created_at_idx" ON "fills" USING btree ("market_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "fills_order_id_idx" ON "fills" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_user_id_created_at_idx" ON "ledger_entries" USING btree ("user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "ledger_entries_ref_type_ref_id_idx" ON "ledger_entries" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "market_events_market_id_created_at_idx" ON "market_events" USING btree ("market_id","created_at");--> statement-breakpoint
CREATE INDEX "markets_status_close_at_idx" ON "markets" USING btree ("status","close_at");--> statement-breakpoint
CREATE INDEX "markets_category_id_status_idx" ON "markets" USING btree ("category_id","status");--> statement-breakpoint
CREATE INDEX "orders_user_id_created_at_idx" ON "orders" USING btree ("user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "orders_market_id_status_idx" ON "orders" USING btree ("market_id","status");--> statement-breakpoint
CREATE INDEX "positions_market_id_settled_idx" ON "positions" USING btree ("market_id","settled");--> statement-breakpoint
CREATE INDEX "price_ticks_market_id_ts_idx" ON "price_ticks" USING btree ("market_id","ts");