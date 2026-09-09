import { Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type Redis } from 'ioredis';
import {
  REDIS,
  REDIS_ADAPTER_SUBSCRIBER,
  REDIS_QUEUE,
  REDIS_SUBSCRIBER,
  redisAdapterSubscriberProvider,
  redisProvider,
  redisQueueProvider,
  redisSubscriberProvider,
} from './redis.provider.js';

/** quit() flushes pending commands and is legal in subscriber mode; fall back to
 *  disconnect() if the connection is already gone. */
async function closeClient(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

@Module({
  providers: [
    redisProvider,
    redisSubscriberProvider,
    redisAdapterSubscriberProvider,
    redisQueueProvider,
  ],
  exports: [REDIS, REDIS_SUBSCRIBER, REDIS_ADAPTER_SUBSCRIBER, REDIS_QUEUE],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  // Injected here and nowhere else for the two subscribers: the module owns their shutdown,
  // and a provider nobody injects is never instantiated (so never closed).
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
    @Inject(REDIS_ADAPTER_SUBSCRIBER) private readonly adapterSubscriber: Redis,
    @Inject(REDIS_QUEUE) private readonly queueClient: Redis,
  ) {}

  // onApplicationShutdown, not onModuleDestroy: it runs after dispose(), so the Socket.IO
  // server has closed and each RedisAdapter has punsubscribed before any client quits. The
  // queue client is quit here too: BullMQ never closes a connection it was handed (it marks
  // it shared), and JobsModule — which imports this module — has closed its Queue by then.
  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      [this.redis, this.subscriber, this.adapterSubscriber, this.queueClient].map((client) =>
        closeClient(client),
      ),
    );
    this.logger.log('Redis connections closed');
  }
}
