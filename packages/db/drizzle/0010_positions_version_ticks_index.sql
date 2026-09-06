-- positions.version: strictly increasing per row (1 on insert, +1 on every ORM update via
-- $onUpdate) - the ordering key a user:position event carries where a millisecond ts could
-- tie (PLAN 8, ADR-0027 addendum, A-M3-19). price_ticks index (market_id, ts) -> (market_id,
-- ts, id): GET /markets/:id/ticks reads the newest TICKS_SCAN_MAX of a range as one backward
-- index scan with a LIMIT, no sort node (A-M3-20).
DROP INDEX "price_ticks_market_id_ts_idx";--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "price_ticks_market_id_ts_id_idx" ON "price_ticks" USING btree ("market_id","ts","id");