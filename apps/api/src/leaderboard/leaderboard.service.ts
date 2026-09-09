import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { LEADERBOARD_LIMIT, type LeaderboardEntry } from '@buddha/shared';
import { asc, desc, eq, ne, sql } from 'drizzle-orm';
import { DB } from '../infra/db/db.provider.js';

/**
 * The global ranking by realized profit and loss (PLAN M6 선택; PLAN 6.3 "랭킹은
 * positions.realized_pnl_p, fills, ledger_entries에서 사용자별로 집계 가능하도록").
 *
 * Aggregated from `positions` on every read rather than kept in a table, which is what PLAN 6.3
 * decided when it said the aggregate table belongs to the group milestone. At MVP scale the
 * grouping is over one row per (account, market, outcome) an account has ever touched — the
 * same rows `/me/positions` already reads per user, without the per-user filter.
 */
@Injectable()
export class LeaderboardService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async top(): Promise<LeaderboardEntry[]> {
    const { positions, profiles } = schema;
    // `sql<string>`, never `sql<number>`: this is a sum of bigints and PLAN 0.2 forbids a
    // double anywhere near a P amount. node-postgres hands an int8 back as a string, so the
    // value crosses the boundary exactly as it left Postgres and `pAmountSchema` accepts it.
    const total = sql<string>`sum(${positions.realizedPnlP})`;
    const rows = await this.db
      .select({ nickname: profiles.nickname, realizedPnlP: total })
      .from(positions)
      .innerJoin(profiles, eq(profiles.userId, positions.userId))
      .groupBy(positions.userId, profiles.nickname)
      // Accounts that have realized nothing are left out, not ranked at zero. A position row
      // exists from the first BUY, so without this the board on a young deployment is twenty
      // accounts tied at 0 P ordered by an opaque id — a ranking that ranks nothing. Losses
      // stay in: "상위 20" is by amount, and hiding them would make the board a claim about
      // the product rather than about the accounts.
      .having(ne(total, sql`0`))
      // The tie-break is not decoration. Two accounts on the same total reorder between two
      // reads without it, so the server-rendered HTML and the client's own refetch would
      // disagree — the class of bug `market-keys.ts` and the SSR hydration rules exist for.
      .orderBy(desc(total), asc(positions.userId))
      .limit(LEADERBOARD_LIMIT);
    return rows.map((row, index) => ({
      rank: index + 1,
      nickname: row.nickname,
      realizedPnlP: String(row.realizedPnlP),
    }));
  }
}
