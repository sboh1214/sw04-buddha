-- #22 시장 시간 (ADR-0093 decision 2 #172 items 11–14, ADR-0098): a market's times become one
-- column each beside `close_at` (거래 마감, unchanged) — 예정 개장 (`scheduled_open_at`; `open_at` stays
-- the actual open, ADR-0065), 발표 예정 (`scheduled_announcement_at`, null is '없음'), 예정 판정
-- (`scheduled_judgement_at`) and 판정 기준 시간대 (`judgement_time_zone`, an IANA name the API checks;
-- no default, the form pre-fills Asia/Seoul for the operator to confirm) — and the 선행 마감 gap a
-- market's lead close was last checked against (`lead_close_gap_minutes`, the release setting's
-- reading the open stores, >= 0).
--
-- - The order CHECKs: scheduled open < close <= scheduled judgement (#172 item 12) and 사건 기한 <=
--   scheduled judgement (owner answer 2026-10-31 A1), in whole minutes, each held once both of
--   its columns are set. Each instant is truncated `AT TIME ZONE 'UTC'`: a bare `date_trunc` on a
--   timestamptz follows the session's TimeZone, so a CHECK written so would hold one row in one
--   session and refuse it in another. The lead close depends on a setting and is the API's.
-- - No wipe (ADR-0093 plans none at #22; E1 of ADR-0097): every existing market stays, its new
--   columns null — nothing exists to convert (D4) — so every CHECK passes on it, and the
--   open-items check names its missing times. The seed fills them in each of its own drafts it
--   left untouched (ADR-0098). No index: nothing lists or orders by them yet.
--
-- As generated; the snapshot is as generated.
ALTER TABLE "markets" ADD COLUMN "scheduled_open_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "scheduled_announcement_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "scheduled_judgement_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "judgement_time_zone" varchar(64);--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "lead_close_gap_minutes" integer;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_open_before_close_check" CHECK (date_trunc('minute', "markets"."scheduled_open_at" AT TIME ZONE 'UTC') < date_trunc('minute', "markets"."close_at" AT TIME ZONE 'UTC'));--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_close_by_judgement_check" CHECK (date_trunc('minute', "markets"."close_at" AT TIME ZONE 'UTC') <= date_trunc('minute', "markets"."scheduled_judgement_at" AT TIME ZONE 'UTC'));--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_deadline_by_judgement_check" CHECK (date_trunc('minute', "markets"."event_deadline" AT TIME ZONE 'UTC') <= date_trunc('minute', "markets"."scheduled_judgement_at" AT TIME ZONE 'UTC'));--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_lead_close_gap_minutes_check" CHECK ("markets"."lead_close_gap_minutes" >= 0);