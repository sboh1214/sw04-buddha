-- Two-level categories (Kalshi's "Economics → Housing / Jobs / Inflation" shape): a sub-category
-- names its parent, a top-level row keeps NULL. Existing rows are all top-level, so no backfill;
-- the seed adds the leaves but never rewrites an existing market (the slug is its idempotency
-- key), so a market seeded before this migration stays on its parent until it is moved by hand
-- (ADR-0041, A-UI-6). A parent still lists it: `?category=economy` covers the parent itself.
--
-- No index on parent_id: every reader filters on it (`GET /markets?category=` resolves
-- `parent_id IN (select id … where slug = $1)`, `GET /categories` filters and orders by it, and
-- the RESTRICT check scans it on a parent delete), but the table holds ~30 rows, where a
-- sequential scan is cheaper than an index probe.
ALTER TABLE "categories" ADD COLUMN "parent_id" integer;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;
