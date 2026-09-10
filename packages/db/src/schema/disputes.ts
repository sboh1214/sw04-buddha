import { desc } from 'drizzle-orm';
import { index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz } from './columns.js';
import { disputeStatusEnum } from './enums.js';
import { markets } from './markets.js';

/**
 * User objections during `resolving` (PLAN 5.5). One per user per market (the UNIQUE below is
 * what turns a second filing into DUPLICATE_REQUEST). The three indexes serve the three reads
 * (M5): `GET /me/disputes` walks one user newest first, `GET /admin/disputes` walks a status
 * newest first, and the admin market detail counts one market's disputes per status.
 */
export const disputes = pgTable(
  'disputes',
  {
    id: uuid().primaryKey().defaultRandom(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    reason: text().notNull(),
    evidenceUrl: text(),
    status: disputeStatusEnum().notNull().default('open'),
    adminNote: text(),
    /** Reviewing admin's user id. No FK (PLAN 6.2): the review record outlives the account. */
    reviewedBy: text(),
    reviewedAt: timestampTz(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('disputes_market_id_user_id_unique').on(t.marketId, t.userId),
    index('disputes_user_id_created_at_idx').on(t.userId, desc(t.createdAt)),
    index('disputes_status_created_at_idx').on(t.status, desc(t.createdAt)),
    index('disputes_market_id_status_idx').on(t.marketId, t.status),
    /**
     * `GET /admin/disputes` with NO status filter, ordered `(created_at DESC, id DESC)` — the
     * one branch the three indexes above cannot serve.
     *
     * A round of the PR #6 review asked for exactly this index and it was REFUSED, on the
     * ground that the index alone would not help: "커서 술어가 OR 분리형이라 Index Cond가 아니라
     * Filter로 붙는다". That was correct, and M6 measured it — with this index and the old
     * predicate the deep page is 1281 ms and 1.75M buffers at 2M rows. The same round deferred
     * the whole family to M6 so the index and the predicate could land together, and now they
     * do: 5614 ms -> 3.81 ms first page, 2424 ms -> 3.74 ms deep (128,024 -> 206 buffers).
     * `UNIQUE (market_id, user_id)` still caps how large this table can get, which is a product
     * question rather than a reason to leave the page quadratic in cursor depth.
     */
    index('disputes_created_at_id_idx').on(desc(t.createdAt), desc(t.id)),
  ],
);
