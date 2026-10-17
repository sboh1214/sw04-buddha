import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { MeWatchlistController } from './watchlist.controller.js';
import { WatchlistService } from './watchlist.service.js';

/**
 * The caller's 관심 시장 (#89, ADR-0064): `GET /me/watchlist`, `GET` and `PUT
 * /me/watchlist/:marketId`. A module of its own beside `TradesModule` rather than inside
 * `MeModule` or `MarketsModule`: it owns two tables nothing else writes, and it borrows only the
 * market row mappers and the category resolution (markets/market.service.ts), which are plain
 * functions — no provider of the markets module is needed.
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [MeWatchlistController],
  providers: [WatchlistService],
})
export class WatchlistModule {}
