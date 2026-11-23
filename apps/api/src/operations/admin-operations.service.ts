import { Inject, Injectable } from '@nestjs/common';
import {
  readOperationsAwaitingJudgements,
  readOperationsClosingMarkets,
  readOperationsFailures,
  type Db,
} from '@buddha/db';
import {
  type AdminAwaitingJudgementMarketPage,
  type AdminClosingMarketPage,
  type AdminOperationsClosingQuery,
  type AdminOperationsFailurePage,
  type AdminOperationsFailuresQuery,
  type AdminOperationsJudgementsQuery,
} from '@buddha/shared';
import { DB } from '../infra/db/db.provider.js';

/**
 * 운영 대기열's three lists (#145, ADR-0163): 마감 예정 (145-1), 판정 대기·지연 (145-2, 145-11,
 * 145-17) and 정산 실패 with 처리 멈춤 and 봇 자금 회수 실패 (145-4, 145-8, 145-15). Each is one
 * statement of @buddha/db in its own REPEATABLE READ, READ ONLY transaction (operations-queues.ts):
 * a list only reads, so a scheduled judgement, a next review or a long-delay deadline passing while
 * an operator looks changes no status and no result (AC 3). Already in DTO shape.
 */
@Injectable()
export class AdminOperationsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  closing(query: AdminOperationsClosingQuery): Promise<AdminClosingMarketPage> {
    return readOperationsClosingMarkets(this.db, query);
  }

  judgements(query: AdminOperationsJudgementsQuery): Promise<AdminAwaitingJudgementMarketPage> {
    return readOperationsAwaitingJudgements(this.db, query);
  }

  failures(query: AdminOperationsFailuresQuery): Promise<AdminOperationsFailurePage> {
    return readOperationsFailures(this.db, query);
  }
}
