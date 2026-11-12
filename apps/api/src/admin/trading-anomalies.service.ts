import { Inject, Injectable } from '@nestjs/common';
import { readTradingAnomalies, type Db } from '@buddha/db';
import type {
  ReleaseSettingsRegistry,
  TradingAnomalyQuery,
  TradingAnomalyReport,
} from '@buddha/shared';
import { DB } from '../infra/db/db.provider.js';
import { RELEASE_SETTINGS_REGISTRY } from '../release-settings/release-settings.registry.js';

@Injectable()
export class TradingAnomaliesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELEASE_SETTINGS_REGISTRY) private readonly registry: ReleaseSettingsRegistry,
  ) {}

  /** The whole bounded report shares one snapshot; client paging performs no new query. */
  read(query: TradingAnomalyQuery): Promise<TradingAnomalyReport> {
    return this.db.transaction((tx) => readTradingAnomalies(tx, query, this.registry), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }
}
