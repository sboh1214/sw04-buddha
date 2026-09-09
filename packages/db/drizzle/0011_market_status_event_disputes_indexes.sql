-- markets.status_event_id: the market_events.id of the transition that produced the current
-- status - the ordering key of market:status and of the market DTOs (M5, A-M3-19, Q-M3-8 (3)).
-- Every transition writes it in the same transaction as its event row, under the market's
-- advisory lock, so it is the market's commit order. No FK: market_events is append-only and an
-- id is never reused. Backfilled from the newest transition event of every existing market;
-- rules_edited is not a transition and is left out, so a market whose last event is an edit
-- keys on the transition before it. Rows with no transition event at all stay null (the rank
-- fallback of statusSupersedes orders those).
-- disputes: three indexes for the three M5 reads - one user's disputes newest first
-- (GET /me/disputes), one status newest first (GET /admin/disputes), one market's counts per
-- status (the admin market detail).
-- Renamed from drizzle-kit's generated tag; the journal entry matches.
ALTER TABLE "markets" ADD COLUMN "status_event_id" bigint;--> statement-breakpoint
UPDATE "markets" m
SET "status_event_id" = e.id
FROM (
  SELECT "market_id", max("id") AS id
  FROM "market_events"
  WHERE "type" IN ('created', 'opened', 'closed', 'resolve_proposed', 'result_changed', 'finalized', 'voided')
  GROUP BY "market_id"
) e
WHERE e."market_id" = m."id";--> statement-breakpoint
CREATE INDEX "disputes_user_id_created_at_idx" ON "disputes" USING btree ("user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "disputes_status_created_at_idx" ON "disputes" USING btree ("status","created_at" desc);--> statement-breakpoint
CREATE INDEX "disputes_market_id_status_idx" ON "disputes" USING btree ("market_id","status");
