import { Inject, Injectable } from '@nestjs/common';
import { readObservationMetrics, type Db } from '@buddha/db';
import { type AdminObservationMetrics } from '@buddha/shared';
import { DB } from '../infra/db/db.provider.js';

/**
 * 관측 지표 (#96, ADR-0169): the four weekly metrics — 첫 체결 전환, 정산 후 재참여, 유효 토론 and 신고
 * 처리 시간 — recomputed from the source tables on every read (95-8) in one REPEATABLE READ, READ
 * ONLY transaction of @buddha/db (observation-metrics.ts), the instant compared with being the
 * transaction's own `now()`. Service-wide counts and durations only (95-6, 95-10); already in DTO
 * shape. The only importer of `readObservationMetrics` outside packages/db (the controller test
 * pins it), so no member or public surface can read the module.
 */
@Injectable()
export class ObservationMetricsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  read(): Promise<AdminObservationMetrics> {
    return readObservationMetrics(this.db);
  }
}
