import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { TradeService } from './trade.service.js';
import { MeTradesController, TradesController } from './trades.controller.js';

/** Trading (PLAN 5.4, 7.2, M3): `POST /trades`, `GET /me/positions`, `GET /me/orders`. */
@Module({
  imports: [DbModule, AuthModule, RealtimeModule],
  controllers: [TradesController, MeTradesController],
  providers: [TradeService],
  exports: [TradeService],
})
export class TradesModule {}
