import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { TradeService } from './trade.service.js';
import { MeTradesController } from './trades.controller.js';

/**
 * The caller's positions and orders (PLAN 7.2, M3): `GET /me/positions`, `GET /me/orders`. The
 * direct AMM `POST /trades` is gone (#125); order entry comes with the CLOB (#119).
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [MeTradesController],
  providers: [TradeService],
  exports: [TradeService],
})
export class TradesModule {}
