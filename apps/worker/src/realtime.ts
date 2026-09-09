import { type MarketRealtimeEvent, type UserRealtimeEvent } from '@buddha/shared';
import { type Redis } from 'ioredis';
import { type Logger } from 'pino';

/**
 * What a job hands its realtime events to after its transaction COMMITS. Channel names come
 * from `marketChannel` / `userChannel` in @buddha/shared, the same functions the API's
 * MarketPublisher and the Socket.IO gateway use, so a worker publish reaches the same rooms.
 */
export type Publish = (
  channel: string,
  event: MarketRealtimeEvent | UserRealtimeEvent,
) => Promise<void>;

/**
 * The worker's half of PLAN 8's publish path (the API's is `MarketPublisher`): after a close
 * or a settlement commits, the events go to Redis and the gateway fans them out to rooms.
 *
 * Best effort by design, exactly like the API's. The transaction has committed when this runs,
 * so a failure here must not fail the job — a retry would find the market already closed or
 * settled (skipped) and never republish, so a throw would only put a finished settlement in
 * the failed set. It is logged and swallowed; the client's REST snapshot carries the truth
 * (PLAN 8: "REST로 스냅샷 → 구독"). Callers with several events issue them back to back and
 * await them together: ioredis writes them in call order on the one connection, so the order
 * on the wire is kept. The shared worker connection is fine for PUBLISH — only SUBSCRIBE would
 * put a connection into subscriber mode, and the worker never subscribes.
 */
export function createPublisher(redis: Redis, logger: Logger): Publish {
  return async (channel, event) => {
    try {
      // P amounts are already decimal strings in every event schema (never bigint), so a
      // plain JSON.stringify is safe.
      await redis.publish(channel, JSON.stringify(event));
    } catch (err) {
      logger.warn({ err, channel, eventType: event.type }, 'realtime publish failed');
    }
  };
}
