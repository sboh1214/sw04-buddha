import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  marketBookEvent,
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
 * `supersedes` (`realtime.ts`); `ts` is for display, and `market:status` is ordered by its
 * `statusEventId` the same way (`statusSupersedes`).
 */
@Injectable()
export class MarketPublisher {
  private readonly logger = new Logger(MarketPublisher.name);
  /** The last event a failed `user:` publish was logged for (`type@ts`): one line per event. */
  private lastMemberFailure: string | undefined;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Room `market:<id>` (public). */
  async publishMarket(marketId: string, event: MarketRealtimeEvent): Promise<void> {
    await this.publish(marketChannel(marketId), event);
  }

  /**
   * `market:book` (#179, ADR-0114) in each market's room, once per market however often it is
   * named: the signal that its public book changed, for a writer whose committed transaction
   * changed live orders there. Issued together, awaited together; a signal carries no state, so
   * their order does not matter (the receiver re-reads `GET /markets/:id/book`).
   */
  async publishBook(marketIds: Iterable<string>, at: Date): Promise<void> {
    await Promise.all(
      [...new Set(marketIds)].map((id) => this.publishMarket(id, marketBookEvent(id, at))),
    );
  }

  /**
   * Room `user:<id>` (the account's own balance and positions). A failure is logged by the
   * channel's kind alone (`user`), its error with the id cut out, and once per event (its type
   * and `ts`) however many members it signals: a line per member would list who was told and how
   * many — a market's watchers and holders (#54, ADR-0159; ADR-0064).
   */
  async publishUser(userId: string, event: UserRealtimeEvent): Promise<void> {
    await this.publish(userChannel(userId), event, userId);
  }

  private async publish(
    channel: string,
    event: MarketRealtimeEvent | UserRealtimeEvent,
    memberId?: string,
  ) {
    try {
      // Coin amounts are already decimal strings in every event schema (never bigint), so a
      // plain JSON.stringify is safe.
      await this.redis.publish(channel, JSON.stringify(event));
    } catch (error) {
      if (memberId === undefined) {
        this.logger.warn(`publish to ${channel} failed (${event.type}): ${String(error)}`);
        return;
      }
      const key = `${event.type}@${'ts' in event ? event.ts : ''}`;
      if (key === this.lastMemberFailure) return;
      this.lastMemberFailure = key;
      // A reply error may quote the channel (Redis 7.2's ACL refusal names it).
      const reason = String(error).split(memberId).join('<member>');
      this.logger.warn(`publish to user failed (${event.type}): ${reason}`);
    }
  }
}
