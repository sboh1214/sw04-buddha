import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  marketChannel,
  userChannel,
  type MarketRealtimeEvent,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { type Redis } from 'ioredis';
import { REDIS } from '../infra/redis/redis.provider.js';

/**
 * PLAN 8's publish path: after a status change or a balance change COMMITS, the API publishes
 * the event to Redis; the M4 Socket.IO gateway subscribes to these channels and emits to the
 * matching rooms. Even a single process goes through Redis, so a second instance needs no
 * code change (PLAN 16).
 *
 * Best effort by design. The transaction has already committed when this runs, so a failure
 * here must not turn a successful write into an error response: it is logged and swallowed,
 * and the client's REST snapshot (PLAN 8: "REST로 스냅샷 → 구독") carries the truth. Nor may
 * it hold that response: the client bounds every reply (`commandTimeout`, redis.provider.ts),
 * so a Redis that keeps the connection but stops answering ends here as a logged timeout.
 * Callers with several events issue them back to back and await them together — ioredis
 * writes them in call order on the one connection, so the order on the wire is kept, and a
 * stalled Redis costs one bound, not one per event. Two writes to one entity may publish out
 * of commit order (the lock is released at COMMIT, the publish happens after), so an event
 * whose entity can change again carries a strictly ordered key the client compares with
 * `supersedes` (`realtime.ts`); `ts` is for display, and `market:status` is ordered by
 * status rank instead.
 */
@Injectable()
export class MarketPublisher {
  private readonly logger = new Logger(MarketPublisher.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Room `market:<id>` (public). */
  async publishMarket(marketId: string, event: MarketRealtimeEvent): Promise<void> {
    await this.publish(marketChannel(marketId), event);
  }

  /** Room `user:<id>` (the account's own balance and positions). */
  async publishUser(userId: string, event: UserRealtimeEvent): Promise<void> {
    await this.publish(userChannel(userId), event);
  }

  private async publish(channel: string, event: MarketRealtimeEvent | UserRealtimeEvent) {
    try {
      // Coin amounts are already decimal strings in every event schema (never bigint), so a
      // plain JSON.stringify is safe.
      await this.redis.publish(channel, JSON.stringify(event));
    } catch (error) {
      this.logger.warn(`publish to ${channel} failed (${event.type}): ${String(error)}`);
    }
  }
}
