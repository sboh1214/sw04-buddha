import { Inject, Injectable } from '@nestjs/common';
import { recordMarketVisit, type Db } from '@buddha/db';
import { AppError } from '../common/errors/app-error.js';
import { closedAccountRefusal } from '../common/errors/closed-account.js';
import { DB } from '../infra/db/db.provider.js';

/**
 * 방문 기록 (#151, ADR-0170; owner answers 151-3, 151-4; ADR-0167 결정 6): records that the session
 * account opened a public market's detail today (KST). The one caller of packages/db's
 * `recordMarketVisit` — the writer that decides what is kept: one row per account, market and
 * Korean date, never an admin's (by the grant and revoke records at that instant, 96-10) nor an
 * operating account's (#115). Nothing here reads a visit back; the rows serve the two
 * visit-based observation metrics alone (결정 6 "지표에만 쓴다").
 */
@Injectable()
export class MarketVisitsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Records the visit, or merges it into today's row of the pair (95-4). An excluded account (an
   * admin now by the records, an operating account) writes nothing and hears nothing of it: the
   * route answers 204 either way (151-3). A market that is not public (DRAFT, REVIEW) or does not
   * exist is NOT_FOUND, as every public read of it is. A visit of an account closed since the
   * request passed SessionGuard is refused by the database (`market_visits_open_account`,
   * migration 0082) and answered as the session that ended (`closedAccountRefusal`).
   */
  async record(userId: string, marketId: string): Promise<void> {
    let result: Awaited<ReturnType<typeof recordMarketVisit>>;
    try {
      result = await recordMarketVisit(this.db, { userId, marketId });
    } catch (error) {
      throw closedAccountRefusal(error) ?? error;
    }
    if (result === 'not_found') {
      throw new AppError('NOT_FOUND', { message: 'Market not found' });
    }
  }
}
