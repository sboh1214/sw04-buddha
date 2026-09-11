-- Two-level categories (Kalshi's "Economics → Housing / Jobs / Inflation" shape): a sub-category
-- names its parent, a top-level row keeps NULL. Existing rows are all top-level, so no backfill;
-- the seed adds the leaves and moves its own markets under them (a re-seed never rewrites a
-- market an admin has touched, so admin-created markets stay filed where they were).
--
-- No index on parent_id: the table holds ~30 rows and the only reader joins it by primary key
-- (`GET /markets?category=` walks child → parent, never parent → children).
ALTER TABLE "categories" ADD COLUMN "parent_id" integer;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;
