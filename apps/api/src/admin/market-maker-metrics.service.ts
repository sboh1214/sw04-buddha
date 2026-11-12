import { Inject, Injectable } from '@nestjs/common';
import {
  readMarketMakerMetrics,
  readMarketMakerMetricsOverview,
  readMarketMakerMetricsPage,
  type Db,
} from '@buddha/db';
import type {
  AdminMarketMakerMetrics,
  AdminMarketMakerMetricsOverview,
  CursorQuery,
  ReleaseSettingsRegistry,
} from '@buddha/shared';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { RELEASE_SETTINGS_REGISTRY } from '../release-settings/release-settings.registry.js';

/** Every response reads one database snapshot; none of these paths allocates or repairs assets. */
@Injectable()
export class AdminMarketMakerMetricsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELEASE_SETTINGS_REGISTRY) private readonly registry: ReleaseSettingsRegistry,
  ) {}

  list(query: CursorQuery) {
    return this.db.transaction((tx) => readMarketMakerMetricsPage(tx, query, this.registry), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  overview(): Promise<AdminMarketMakerMetricsOverview> {
    return this.db.transaction((tx) => readMarketMakerMetricsOverview(tx, this.registry), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  get(marketId: string): Promise<AdminMarketMakerMetrics> {
    return this.db.transaction(
      async (tx) => {
        const metrics = await readMarketMakerMetrics(tx, marketId, this.registry);
        if (!metrics) throw new AppError('NOT_FOUND', { message: 'Market not found' });
        return metrics;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
