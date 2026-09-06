import { Module } from '@nestjs/common';
import { RedisModule } from '../infra/redis/redis.module.js';
import { MarketPublisher } from './market-publisher.js';

/** PLAN 8 publish path (M3). The Socket.IO gateway that consumes it arrives with M4. */
@Module({
  imports: [RedisModule],
  providers: [MarketPublisher],
  exports: [MarketPublisher],
})
export class RealtimeModule {}
