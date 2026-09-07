import { Module } from '@nestjs/common';
import { AuthInstanceModule } from '../auth/auth.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { MarketPublisher } from './market-publisher.js';
import { MarketGateway } from './market.gateway.js';

/** PLAN 8: the M3 publish path plus the M4 gateway that forwards it to the `/ws` rooms. */
@Module({
  // AuthInstanceModule, not AuthModule, is the minimal export of AUTH: the gateway resolves the
  // handshake session itself because SessionGuard and @CurrentUser are HTTP-only.
  imports: [RedisModule, AuthInstanceModule],
  providers: [MarketPublisher, MarketGateway],
  exports: [MarketPublisher],
})
export class RealtimeModule {}
