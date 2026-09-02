import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { type Env } from '../../config/env.js';

/** Injection token for the shared ioredis client. */
export const REDIS = Symbol('REDIS');

/** Node's happy-eyeballs ECONNREFUSED is an AggregateError with an empty message. */
function describeError(err: Error & { code?: string }): string {
  return [err.code, err.message].filter(Boolean).join(' ') || err.name;
}

export const redisProvider: Provider<Redis> = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): Redis => {
    const logger = new Logger('Redis');
    const redis = new Redis(config.get('REDIS_URL', { infer: true }), {
      // Fail commands fast when the server is unreachable instead of queueing
      // them forever; the health check relies on this.
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
    // ioredis emits 'error' on every failed (re)connect; without a listener it
    // prints a noisy warning. Keep it to a single line.
    redis.on('error', (err: Error & { code?: string }) => {
      logger.warn(`connection error: ${describeError(err)}`);
    });
    return redis;
  },
};
