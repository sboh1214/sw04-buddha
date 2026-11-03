import { Module } from '@nestjs/common';
import { RedisModule } from '../infra/redis/redis.module.js';
import { MarketJobs } from './market-jobs.service.js';

/**
 * PLAN 9 producer side (M5): the API registers the delayed `market.open` (#21, ADR-0100) /
 * `market.close` / `market.resolve` (#152, ADR-0103) jobs the worker consumes (m5 design 3.2; the
 * worker registers `market.finalize` itself since #152). Imports RedisModule for the producer's
 * own connection (REDIS_QUEUE), which that module also closes — after MarketJobs has closed its
 * Queue, since a module's shutdown hooks run before those of the modules it imports.
 */
@Module({
  imports: [RedisModule],
  providers: [MarketJobs],
  exports: [MarketJobs],
})
export class JobsModule {}
