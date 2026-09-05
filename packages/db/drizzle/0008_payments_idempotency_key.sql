-- Client Idempotency-Key per charge (PLAN 5.4), unique per account. Hand-edited after
-- `drizzle-kit generate`: the column is NOT NULL like orders.idempotency_key (PLAN 6.2), so
-- payments written before this migration are stamped with a key no client holds.
ALTER TABLE "payments" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
UPDATE "payments" SET "idempotency_key" = 'legacy_' || "id"::text WHERE "idempotency_key" IS NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_user_id_idempotency_key_unique" ON "payments" USING btree ("user_id","idempotency_key");
