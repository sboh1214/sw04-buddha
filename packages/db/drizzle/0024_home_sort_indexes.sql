-- #63 시장 목록 정렬 (ADR-0061 decision 1, items 9-11; ADR-0065): the volume order is gone until
-- #132 brings it back, and with it the index that served it; 신규 is now the actual open time,
-- `open_at DESC NULLS LAST` written as coalesce(open_at, '-infinity') so the row-comparison
-- cursor can page across a NULL (apps/api/src/markets/market-order.ts spells the same
-- expression). As generated; only this comment was added. Data is untouched.
DROP INDEX "markets_status_volume_coin_id_idx";--> statement-breakpoint
CREATE INDEX "markets_status_open_at_id_idx" ON "markets" USING btree ("status",coalesce("open_at", '-infinity'::timestamptz) DESC,"id" desc);