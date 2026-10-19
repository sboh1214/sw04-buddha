import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { MarketsModule } from '../markets/markets.module.js';
import { AdminThemesController } from './admin-themes.controller.js';
import { ThemeAdminService } from './theme-admin.service.js';
import { MarketThemesController, ThemesController } from './themes.controller.js';
import { ThemesService } from './themes.service.js';

/**
 * 테마 (#81): the public reads (`/themes`, `/markets/:id/themes`) and the admin's writes
 * (`/admin/themes`). A module of its own: it owns three tables nothing else writes, and it borrows
 * the public market check (MarketService, exported by MarketsModule) and the market row mappers.
 * DbModule and RedisModule are imported for AdminGuard, which reads the role through the Redis
 * cache and is instantiated in the module that declares the controller.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule, MarketsModule],
  controllers: [ThemesController, MarketThemesController, AdminThemesController],
  providers: [ThemesService, ThemeAdminService],
})
export class ThemesModule {}
