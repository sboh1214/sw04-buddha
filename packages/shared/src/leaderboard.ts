import * as z from 'zod';
import { pAmountSchema } from './api/p-amount.js';
import { nicknameSchema } from './me.js';

/**
 * `GET /leaderboard` returns this many accounts (PLAN M6 선택: 실현 손익 상위 20).
 *
 * A fixed slice, not a page. PLAN 7's cursor pagination exists for lists that continue; a
 * ranking of twenty does not, and a cursor here would need a shape that does not exist —
 * `SORT_VALUE_SHAPES.int` is digits only and realized P&L is SIGNED, so a sort cursor could not
 * carry a loss. Modelled on `FILLS_RECENT_LIMIT`, the other fixed public slice.
 */
export const LEADERBOARD_LIMIT = 20;

/**
 * One row of the board.
 *
 * NO USER ID. The board is public (PLAN 7.1's reads serve anonymous visitors) and the only
 * thing a visitor needs is who and how much; an id would turn a ranking into a handle for
 * correlating a person's positions, and PLAN 7.1 already keeps `fills` anonymous for the same
 * reason. The nickname is public by design — PLAN 6.3 made it mandatory precisely so rankings
 * (and, then, disputes — removed by ADR-0046) could name someone without exposing an account.
 *
 * `realizedPnlP` is a SIGNED decimal string, like every other P amount: it is a sum of bigints
 * and a JSON number cannot hold one. Never `Number()` it — `use-portfolio.test.ts` already pins
 * what that costs.
 */
export const leaderboardEntrySchema = z
  .object({
    /** 1-based, dense: the position in this slice, not a global rank across ties. */
    rank: z.int().min(1),
    nickname: nicknameSchema,
    realizedPnlP: pAmountSchema,
  })
  .meta({ id: 'LeaderboardEntry' });
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;
