import { pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz } from './columns.js';
import { disputeStatusEnum } from './enums.js';
import { markets } from './markets.js';

/** User objections during `resolving` (PLAN 5.5). One per user per market. */
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
  (t) => [unique('disputes_market_id_user_id_unique').on(t.marketId, t.userId)],
);
