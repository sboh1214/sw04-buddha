import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ReleaseSettingsModule } from '../release-settings/release-settings.module.js';
import { OrderRateLimitGuard } from './order-rate-limit.guard.js';
import { OrderService } from './order.service.js';
import { MarketOrdersController, MeOrdersController } from './orders.controller.js';
import { TradeService } from './trade.service.js';
import { MeTradesController } from './trades.controller.js';

/**
 * The caller's trading (PLAN 7.2): positions (`GET /me/positions`, M3) and, since the CLOB (#119,
 * ADR-0112), the order submission (`POST /markets/:id/orders`) with the owner's reads of orders
 * and fills (`/me/orders`, `/me/fills`). ReleaseSettingsModule gives the registry `order.accepting`
 * is read through and `order.rate_limit` (OrderRateLimitGuard); RealtimeModule the publisher of
 * the `user:balance` and `user:position` events an order's fills cause. The direct AMM
 * `POST /trades` is gone (#125).
 */
@Module({
  imports: [DbModule, AuthModule, ReleaseSettingsModule, RealtimeModule],
  controllers: [MeTradesController, MarketOrdersController, MeOrdersController],
  providers: [TradeService, OrderService, OrderRateLimitGuard],
  exports: [TradeService, OrderService],
})
export class TradesModule {}
