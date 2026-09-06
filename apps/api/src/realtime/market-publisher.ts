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
 * PLAN 8's publish path: after a trade or a status change COMMITS, the API publishes the
 * event to Redis; the M4 Socket.IO gateway subscribes to these channels and emits to the
 * matching rooms. Even a single process goes through Redis, so a second instance needs no
 * code change (PLAN 16).
 *
 * Best effort by design. The transaction has already committed when this runs, so a failure
 * here must not turn a successful trade into an error response: it is logged and swallowed,
 * and the client's REST snapshot (PLAN 8: "REST로 스냅샷 → 구독") carries the truth. Two
 * trades on one market may publish out of commit order (the lock is released at COMMIT, the
 * publish happens after); every event carries `ts`, so the client keeps the newest.
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
      // P amounts are already decimal strings in every event schema (never bigint), so a
      // plain JSON.stringify is safe.
      await this.redis.publish(channel, JSON.stringify(event));
    } catch (error) {
      this.logger.warn(`publish to ${channel} failed (${event.type}): ${String(error)}`);
    }
  }
}
