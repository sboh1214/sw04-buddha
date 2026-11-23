import { Inject, Injectable } from '@nestjs/common';
import { readMarketWorkHistory, type Db } from '@buddha/db';
import { type AdminMarketWorkPage, type AdminMarketWorkQuery } from '@buddha/shared';
import { DB } from '../infra/db/db.provider.js';

/**
 * 시장별 작업 이력 (#145, ADR-0164; 145-5, 145-6, 145-7, 145-12, 145-13, 145-16): one market's admin
 * actions, approval requests and decisions, the records bound to it (the other end of a related
 * market link, its 대사 실행 and 대사 보류 복구, its fills' classification, the proposal linked to
 * it) and its system events as '시스템', oldest first, every kind or one. One UNION statement of
 * @buddha/db in a REPEATABLE READ, READ ONLY transaction (market-work.ts): reading writes nothing.
 * A market that is not there answers an empty page, as the other per-market records do.
 */
@Injectable()
export class MarketWorkService {
  constructor(@Inject(DB) private readonly db: Db) {}

  history(marketId: string, query: AdminMarketWorkQuery): Promise<AdminMarketWorkPage> {
    return readMarketWorkHistory(this.db, marketId, query);
  }
}
