-- PLAN M6 "인덱스 점검": the global keyset lists A-M3-10 deferred, plus the home page's default
-- sort and the unfiltered admin market list.
--
-- Landed TOGETHER with the row-comparison cursor predicate (apps/api common/keyset.ts). The M2
-- and M3 reviews refused four separate "add an index" requests and wrote "전역 키셋 목록 넷 +
-- 행 비교 술어" into this milestone precisely because the two halves are one change: an ordered
-- index under the old `a < $1 OR (a = $1 AND b < $2)` predicate pulls the planner off a bounded
-- `Seq Scan + top-N Sort` and onto an index walk whose Filter then discards every row in front
-- of the cursor. Measured at 2,000,000 rows, deep page, index WITHOUT the new predicate:
-- coupons 198 ms -> 1158 ms, markets(volume) 355 ms -> 2053 ms, audit_failures 172 ms -> 647 ms.
-- With both, every one of them is an Index Cond in well under a millisecond.
--
-- `markets_status_created_at_id_idx` was measured and deliberately NOT added: with
-- `markets_created_at_id_idx` present the planner serves `?sort=newest` from it at the same
-- 0.11 ms, and the dedicated one would cost another 95 MB at that volume.
-- Renamed from drizzle-kit's generated tag; the journal entry matches.
CREATE INDEX "audit_failures_created_at_id_idx" ON "audit_failures" USING btree ("created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "coupons_created_at_id_idx" ON "coupons" USING btree ("created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "disputes_created_at_id_idx" ON "disputes" USING btree ("created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "markets_status_volume_p_id_idx" ON "markets" USING btree ("status","volume_p" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "markets_created_at_id_idx" ON "markets" USING btree ("created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "payments_created_at_id_idx" ON "payments" USING btree ("created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "profiles_created_at_user_id_idx" ON "profiles" USING btree ("created_at" desc,"user_id" desc);