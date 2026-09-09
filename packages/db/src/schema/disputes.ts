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
  ],
);
