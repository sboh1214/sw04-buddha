import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { MeSearchHistoryController } from './search-history.controller.js';
import { SearchHistoryService } from './search-history.service.js';

/**
 * The caller's 최근 검색 (#15, ADR-0066): `GET` and `POST /me/search-history`, `POST
 * /me/search-history/:id/delete` and `POST /me/search-history/clear`. A module of its own like
 * `WatchlistModule`: it owns two tables nothing else reads (`market_searches`, and the
 * per-term `market_search_terms` the migration 0026 triggers keep), and the search it records is
 * the public `GET /markets?q=`, which it does not touch.
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [MeSearchHistoryController],
  providers: [SearchHistoryService],
})
export class SearchHistoryModule {}
