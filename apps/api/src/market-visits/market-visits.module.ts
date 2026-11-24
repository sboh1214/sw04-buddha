import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { MeMarketVisitsController } from './market-visits.controller.js';
import { MarketVisitsService } from './market-visits.service.js';

/**
 * 방문 기록 (#151, ADR-0170): `POST /me/market-visits`, the one way a market-detail visit is
 * written. A module of its own like `SearchHistoryModule`: it writes one table nothing else
 * writes (`market_visits`, through packages/db's `recordMarketVisit`), and nothing here reads it —
 * only the two visit-based observation metrics do, in packages/db's reader (#96's module).
 * DbModule and AuthModule also serve the guards (SessionGuard, OnboardedGuard).
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [MeMarketVisitsController],
  providers: [MarketVisitsService],
})
export class MarketVisitsModule {}
