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

/**
 * Upper bound on one command's reply (ms), armed when the command is issued. A Redis that
 * keeps the connection but stops answering — a PUBLISH whose reply never comes, a command
 * parked in the offline queue behind a handshake that never completes — would otherwise park
 * the caller forever; after a trade has COMMITted, that caller is the HTTP response of a
 * trade that succeeded. `connectTimeout` covers the TCP connect only and
 * `maxRetriesPerRequest` the reconnects; neither bounds a reply. The handshake (HELLO/INFO)
 * and `quit()` at shutdown run under the same bound, so a Redis that accepts TCP and never
 * answers surfaces as `connection error: Command timed out` and reconnects.
 *
 * A timeout rejects the caller and keeps the connection: ioredis matches replies to commands
 * in order, so a reply that arrives late lands on the entry that already timed out and the
 * queue stays aligned — a spurious timeout costs nothing. Every consumer degrades on the
 * rejection: the publisher logs, the role cache falls back to Postgres, the health probe
 * reports `error`.
 *
 * It does not, however, free the command: `Command.setTimeout` only settles the promise, and
 * the queue entry — which holds the serialized event — leaves `commandQueue` only when a
 * reply arrives or the socket closes. On a connection that answered the handshake and then
 * went silent, every later publish adds one more, so `socketTimeout` below is what bounds it.
 */
export const REDIS_COMMAND_TIMEOUT_MS = 2_000;

/**
 * Upper bound on silence (ms) on a connection that has a command outstanding — the answer to
 * Q-M3-7. ioredis arms this only while `commandQueue` is non-empty and clears it on any
 * inbound byte, so it is not an idle timer: an idle client, and a subscriber waiting for
 * messages, never arm it. When it fires the socket is destroyed and the client reconnects,
 * which is what drops the retained entries.
 *
 * Twice `REDIS_COMMAND_TIMEOUT_MS`, and it must stay strictly greater: a merely slow reply
 * has to fail on the caller's own bound and leave the connection up, so the socket goes only
 * when nothing at all has arrived for twice that.
 *
 * `autoResendUnfulfilledCommands: false` is part of the same decision, not a separate knob.
 * The default re-sends the queue on reconnect, which would republish events that already
 * timed out (`market:trade` has no ordering key a client could use to drop a duplicate).
 * With it false, ioredis DROPS those entries rather than rejecting them — despite what the
 * option's own docstring says, `socketTimeout` settles nothing — so `commandTimeout` must
 * stay set on every client this factory builds, or a caller could wait forever.
 */
export const REDIS_SOCKET_TIMEOUT_MS = 4_000;

/** The shared client's options; exported so a test can build one against a mock server. */
export function createRedisClient(
  url: string,
  options: { commandTimeoutMs?: number; socketTimeoutMs?: number } = {},
): Redis {
  const logger = new Logger('Redis');
  const redis = new Redis(url, {
    // Fail commands fast when the server is unreachable instead of queueing
    // them forever; the health check relies on this.
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: options.commandTimeoutMs ?? REDIS_COMMAND_TIMEOUT_MS,
    socketTimeout: options.socketTimeoutMs ?? REDIS_SOCKET_TIMEOUT_MS,
    autoResendUnfulfilledCommands: false,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  // ioredis emits 'error' on every failed (re)connect; without a listener it
  // prints a noisy warning. Keep it to a single line.
  redis.on('error', (err: Error & { code?: string }) => {
    logger.warn(`connection error: ${describeError(err)}`);
  });
  return redis;
}

export const redisProvider: Provider<Redis> = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): Redis =>
    createRedisClient(config.get('REDIS_URL', { infer: true })),
};

/**
 * The M4 gateway's own pub/sub connection (`market:*`, `user:*`). A connection in subscriber
 * mode refuses ordinary commands, so it cannot be the shared client.
 */
export const REDIS_SUBSCRIBER = Symbol('REDIS_SUBSCRIBER');

/**
 * The connection `@socket.io/redis-adapter` puts in subscriber mode. Kept apart from
 * REDIS_SUBSCRIBER so the adapter owns its own (p)subscribe lifecycle and its notepack frames
 * never interleave with our JSON on one `pmessage` listener.
 */
export const REDIS_ADAPTER_SUBSCRIBER = Symbol('REDIS_ADAPTER_SUBSCRIBER');

/**
 * A subscriber built by the same factory as the shared client — never `redis.duplicate()`,
 * which would copy the options object but skip the error logger, and never a hand-rolled
 * `new Redis(url)`, which would drop every bound above.
 *
 * Both bounds are deliberately kept, because neither one measures the wait for messages:
 * `commandTimeout` is armed per command when it is issued, so on a subscriber it bounds only
 * the reply to a command WE send (PSUBSCRIBE, the keep-alive PING, QUIT) and is cleared when
 * that reply lands — a delivered `pmessage` is not a command reply and needs no queue entry.
 * `socketTimeout` is armed only while `commandQueue` is non-empty (see above), so a connection
 * parked on `pmessage` never arms it either; `market-publisher.test.ts` pins exactly that.
 * What is left is a PSUBSCRIBE rejected on `commandTimeout` against a live-but-silent Redis,
 * which — with `autoResendUnfulfilledCommands: false` — is dropped rather than resent and
 * produces no later `ready`. That is a gateway concern, not a client one, and MarketGateway
 * answers it with a bounded re-arm retry (Q-M3-7).
 */
function subscriberProvider(token: symbol): Provider<Redis> {
  return {
    provide: token,
    inject: [ConfigService],
    useFactory: (config: ConfigService<Env, true>): Redis =>
      createRedisClient(config.get('REDIS_URL', { infer: true })),
  };
}

export const redisSubscriberProvider = subscriberProvider(REDIS_SUBSCRIBER);
export const redisAdapterSubscriberProvider = subscriberProvider(REDIS_ADAPTER_SUBSCRIBER);
