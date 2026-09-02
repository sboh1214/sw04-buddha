import { Inject, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { type Redis } from 'ioredis';
import { REDIS, redisProvider } from './redis.provider.js';

@Module({
  providers: [redisProvider],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    // quit() flushes pending commands; fall back to disconnect() if the
    // connection is already gone.
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
    this.logger.log('Redis connection closed');
  }
}
