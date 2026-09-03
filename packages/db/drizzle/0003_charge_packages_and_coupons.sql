CREATE TABLE "charge_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"amount_p" bigint NOT NULL,
	"price_krw" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charge_packages_amount_p_check" CHECK ("charge_packages"."amount_p" > 0),
	CONSTRAINT "charge_packages_price_krw_check" CHECK ("charge_packages"."price_krw" > 0),
	CONSTRAINT "charge_packages_price_within_face_value_check" CHECK ("charge_packages"."price_krw" <= "charge_packages"."amount_p")
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coupon_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"amount_p" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_redemptions_coupon_id_user_id_unique" UNIQUE("coupon_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"amount_p" bigint NOT NULL,
	"max_redemptions" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"memo" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_unique" UNIQUE("code"),
	CONSTRAINT "coupons_amount_p_check" CHECK ("coupons"."amount_p" > 0),
	CONSTRAINT "coupons_max_redemptions_check" CHECK ("coupons"."max_redemptions" is null or "coupons"."max_redemptions" > 0),
	CONSTRAINT "coupons_redeemed_count_check" CHECK ("coupons"."redeemed_count" >= 0)
);
--> statement-breakpoint
-- Backfill before NOT NULL: rows written before charge packages existed were bought at face
-- value (1P = 1원), which is exactly amount_p. Amounts are capped far below 2^31, so the cast
-- to integer is safe.
ALTER TABLE "payments" ADD COLUMN "price_krw" integer;--> statement-breakpoint
UPDATE "payments" SET "price_krw" = "amount_p"::integer WHERE "price_krw" IS NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "price_krw" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "package_id" uuid;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "charge_packages_active_sort_idx" ON "charge_packages" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_user_id_created_at_idx" ON "coupon_redemptions" USING btree ("user_id","created_at" desc);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_package_id_charge_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."charge_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_price_krw_check" CHECK ("payments"."price_krw" > 0);