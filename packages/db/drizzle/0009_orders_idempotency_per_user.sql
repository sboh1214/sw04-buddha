-- Client Idempotency-Key per trade (PLAN 5.4), unique per account like payments (0008):
-- a client-minted key must not collide with, or probe, another user's order. The API replays
-- from the orders/fills/ledger rows themselves; there is no Redis fast path (ADR-0027).
-- Renamed from drizzle-kit's generated tag; the journal entry matches.
ALTER TABLE "orders" DROP CONSTRAINT "orders_idempotency_key_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "orders_user_id_idempotency_key_unique" ON "orders" USING btree ("user_id","idempotency_key");