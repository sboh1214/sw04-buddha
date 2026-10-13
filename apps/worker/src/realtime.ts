import { type MarketRealtimeEvent, type UserRealtimeEvent } from '@buddha/shared';
import { Redis } from 'ioredis';
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
 * Upper bound on one PUBLISH's reply (ms) and on silence on a connection with a command
 * outstanding — the same two figures, for the same two reasons, as `REDIS_COMMAND_TIMEOUT_MS`
 * and `REDIS_SOCKET_TIMEOUT_MS` in `apps/api/src/infra/redis/redis.provider.ts` (A-M3-28), whose
 * doc block is the full argument. `socketTimeout` must stay strictly greater than
 * `commandTimeout`: a merely slow reply has to fail on the caller's own bound and leave the
 * connection up, and only total silence for twice that takes the socket down.
 *
 * Copied rather than imported: `apps/worker` may not import from `apps/api` (PLAN 4.1), and
 * `@buddha/shared` is the domain and protocol layer — job names live there because producer and
 * consumer must read one module, but a client's own reply bound is not a contract between the
 * two processes, and that package is bundled into apps/web.
 */
export const REDIS_PUBLISH_COMMAND_TIMEOUT_MS = 2_000;
export const REDIS_PUBLISH_SOCKET_TIMEOUT_MS = 4_000;

/**
 * The connection realtime events go out on — NOT the shared BullMQ one, and that split is the
 * whole point of this function.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on a connection its Workers use, so their
 * blocking commands never fail on a transient reconnect; ioredis then never flushes the offline
 * queue with an error (`event_handler.js` does that only when the option is a NUMBER), and a
 * `commandTimeout` cannot be added to make up for it either, because ioredis arms that timer for
 * every command — BRPOPLPUSH and BZPOPMIN included — and would reject BullMQ's blocking reads
 * every two seconds. So on that connection an `await redis.publish(...)` has no bound at all:
 * the command is parked in the offline queue with no timer, or written to a socket that has gone
 * silent, and never settles. The `catch` below would never see it.
 *
 * That is not a lost event, it is a stopped worker. Both publishes happen AFTER their
 * transaction commits, `runScan` walks a scan's markets sequentially, and the `markets` queue is
 * `concurrency: 1` — so one parked publish holds every market behind it in that scan and every
 * later close and settlement job behind that, with `/health` still answering ready because the
 * flag was set at boot. This is the same reason the API keeps `REDIS_QUEUE` apart from its
 * shared client (redis.provider.ts): one connection cannot carry both option sets.
 *
 * Built here rather than in `main.ts` so the bounds are a value a test can pin without booting
 * the worker. `options` is for tests that need a shorter bound than two seconds, nothing else.
 */
export function createPublisherRedis(
  url: string,
  logger: Logger,
  options: { commandTimeoutMs?: number; socketTimeoutMs?: number } = {},
): Redis {
  const redis = new Redis(url, {
    // Fail a command fast when the server is unreachable instead of queueing it forever; the
    // publish is best effort and its caller has already committed.
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: options.commandTimeoutMs ?? REDIS_PUBLISH_COMMAND_TIMEOUT_MS,
    socketTimeout: options.socketTimeoutMs ?? REDIS_PUBLISH_SOCKET_TIMEOUT_MS,
    // The default re-sends the outstanding queue on reconnect, which would republish events
    // that already timed out; `user:balance` and `user:position` carry ordering keys but
    // `market:trade` has none a client could dedup on (A-M3-28). With it false ioredis DROPS
    // those entries when the socket goes, which is what `socketTimeout` is for, so
    // `commandTimeout` must stay set or a caller could still wait forever.
    autoResendUnfulfilledCommands: false,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
    // `CLIENT LIST` tells this apart from 'buddha-worker', the BullMQ connection.
    connectionName: 'buddha-worker-publish',
  });
  // ioredis emits 'error' on every failed (re)connect, and an EventEmitter 'error' with no
  // listener is thrown — which would take the worker down on a Redis blip.
  redis.on('error', (err) => logger.warn({ err }, 'realtime publish connection error'));
  return redis;
}

/**
 * The worker's half of PLAN 8's publish path (the API's is `MarketPublisher`): after a close
 * or a settlement commits, the events go to Redis and the gateway fans them out to rooms.
 *
 * Best effort by design, exactly like the API's. The transaction has committed when this runs,
 * so a failure here must not fail the job — a retry would find the market already closed or
 * settled (skipped) and never republish, so a throw would only put a finished settlement in
 * the failed set. It is logged and swallowed; the client's REST snapshot carries the truth
 * (PLAN 8: "REST로 스냅샷 → 구독"). Nor may it HOLD the caller: the connection bounds every reply
 * (`createPublisherRedis`), so a Redis that keeps the socket and stops answering ends here as a
 * logged timeout rather than as a scan that never reaches its next market. Callers with several
 * events issue them back to back and await them together: ioredis writes them in call order on
 * the one connection, so the order on the wire is kept and a stalled Redis costs one bound for
 * the batch, not one per event.
 */
export function createPublisher(redis: Redis, logger: Logger): Publish {
  return async (channel, event) => {
    try {
      // Coin amounts are already decimal strings in every event schema (never bigint), so a
      // plain JSON.stringify is safe.
      await redis.publish(channel, JSON.stringify(event));
    } catch (err) {
      logger.warn({ err, channel, eventType: event.type }, 'realtime publish failed');
    }
  };
}
