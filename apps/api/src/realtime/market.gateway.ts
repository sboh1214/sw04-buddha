import { Inject, Logger, type OnApplicationShutdown, UseFilters } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import {
  MARKET_CHANNEL_PATTERN,
  REALTIME_NAMESPACE,
  REALTIME_ROOMS_MAX,
  RESYNC_EVENT,
  USER_CHANNEL_PATTERN,
  marketChannel,
  marketRealtimeEventSchema,
  subscribeBodySchema,
  userChannel,
  userRealtimeEventSchema,
} from '@buddha/shared';
import { fromNodeHeaders } from 'better-auth/node';
import { type Redis } from 'ioredis';
import { type DefaultEventsMap, type Namespace, type Socket } from 'socket.io';
import { AUTH, type Auth } from '../auth/auth.js';
import { AppError } from '../common/errors/app-error.js';
import { toValidationIssue } from '../common/pipes/validation.pipe.js';
import { REDIS_SUBSCRIBER } from '../infra/redis/redis.provider.js';
import { RealtimeExceptionFilter } from './realtime-exception.filter.js';

/** Keep-alive on the subscriber connection; unref'd so it never holds the process open. */
const PING_INTERVAL_MS = 30_000;
/** Delay before a rejected `psubscribe` is retried. */
const ARM_RETRY_MS = 1_000;

/** Per-socket state. Both fields are set by the handshake middleware, before any handler. */
interface RealtimeSocketData {
  /** From the handshake session; undefined for an anonymous socket (PLAN 8 admits those). */
  userId?: string;
  /** The `market:<id>` rooms this socket holds, for the REALTIME_ROOMS_MAX cap. */
  marketRooms: Set<string>;
}

type RealtimeSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  RealtimeSocketData
>;
type RealtimeNamespace = Namespace<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  RealtimeSocketData
>;

/**
 * PLAN 8's consumer side: the API publishes an event to Redis after a trade or a status change
 * commits (MarketPublisher, M3), and this gateway forwards it to the Socket.IO rooms of the
 * `/ws` namespace. Both paths coexist, and the whole multi-instance contract is one invariant:
 *
 *   EVERY emit driven by the domain Redis subscription is `.local`; only an emit from a
 *   request or a lifecycle context goes through the Redis adapter.
 *
 * Each instance holds the same two patterns, so each already has every event. Republishing one
 * through the adapter would deliver it N times to a client on N instances and cost N^2 adapter
 * messages per publish — and it is silent in single-instance dev, which is why the no-duplicate
 * test in market.gateway.test.ts pins it directly.
 *
 * Two fixed patterns rather than one SUBSCRIBE per room: joining a room stays a synchronous
 * in-process operation, so a `subscribe` never waits on a Redis round trip that could reject on
 * `commandTimeout`, and the reconnect re-arm of Q-M3-7 is two idempotent commands instead of a
 * rebuilt subscription set. The cost — every instance receives every market's events — is paid
 * back by the `adapter.rooms.has(channel)` check below, which drops a message for a market
 * nobody here watches for one Map lookup, before JSON.parse.
 */
@UseFilters(RealtimeExceptionFilter)
// A non-integer first argument sets PORT_METADATA 0, so the server attaches to the existing
// Fastify raw server instead of opening a second port.
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class MarketGateway
  implements
    OnGatewayInit<RealtimeNamespace>,
    OnGatewayConnection<RealtimeSocket>,
    OnApplicationShutdown
{
  private readonly logger = new Logger(MarketGateway.name);
  private namespace?: RealtimeNamespace;
  private ping?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private armed = false;
  private arming = false;

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {}

  afterInit(namespace: RealtimeNamespace): void {
    this.namespace = namespace;
    // A namespace middleware, not an async handleConnection: socket.io runs it before the
    // socket joins the namespace and before any packet is dispatched, so socket.data is
    // populated before a handler can read it. An async handleConnection returns at its first
    // await and would race a client that emits `subscribe` in the same tick.
    namespace.use((socket, next) => {
      void this.authenticate(socket, next);
    });
    // `/ws` is the only namespace this API speaks; a client that connects to the default one
    // is refused rather than left holding a socket that can never receive anything.
    namespace.server.of('/').use((_socket, next) => {
      next(new Error('unknown namespace'));
    });

    this.subscriber.on('pmessage', this.onChannelMessage);
    // ioredis re-issues CONFIRMED subscriptions on reconnect, but a psubscribe lost in flight
    // is dropped rather than resent (autoResendUnfulfilledCommands: false). Re-arming on every
    // `ready` is idempotent and covers exactly that gap (Q-M3-7).
    this.subscriber.on('ready', this.arm);
    this.arm();
    // socketTimeout arms only while a command is outstanding (A-M3-28), so a half-open
    // subscriber connection would otherwise stop delivering forever with nothing noticing.
    // PING is legal in subscriber mode; unref'd so it holds neither the process nor vitest open.
    this.ping = setInterval(() => {
      void this.subscriber.ping().catch(() => undefined);
    }, PING_INTERVAL_MS);
    this.ping.unref();
  }

  onApplicationShutdown(): void {
    if (this.ping) clearInterval(this.ping);
    if (this.retry) clearTimeout(this.retry);
    // RedisModule quits the connection itself; drop the listeners so a message arriving during
    // shutdown cannot emit into a namespace that is already closing.
    this.subscriber.off('pmessage', this.onChannelMessage);
    this.subscriber.off('ready', this.arm);
  }

  /**
   * `ready` alone is not enough: `commandTimeout` can reject a PSUBSCRIBE on a live-but-silent
   * Redis with no later `ready`, and the gateway would stay deaf for the life of the process.
   * A bounded retry closes that. On any re-arm after the first, events published in the gap are
   * gone, so the clients are told to re-read their REST snapshots (A-M3-19) — `.local`, because
   * this runs on every instance.
   */
  private readonly arm = (): void => {
    // One arm in flight at a time. The eager arm above is queued when the client is still
    // connecting, and ioredis flushes that queue and THEN emits `ready` (setStatus defers the
    // emit a tick), so without this guard every boot would psubscribe twice and the second
    // completion would announce a gap that never existed. A rejected arm clears the flag, so
    // the retry below is unaffected — and an arm dropped by a reconnect is settled by
    // `commandTimeout` (redis.provider.ts), never left pending forever.
    if (this.arming) return;
    this.arming = true;
    void this.subscriber
      .psubscribe(MARKET_CHANNEL_PATTERN, USER_CHANNEL_PATTERN)
      .then(() => {
        this.arming = false;
        if (this.armed) this.namespace?.local.emit(RESYNC_EVENT);
        this.armed = true;
      })
      .catch((error: unknown) => {
        this.arming = false;
        this.logger.warn(`psubscribe failed, retrying: ${String(error)}`);
        this.retry = setTimeout(this.arm, ARM_RETRY_MS);
        this.retry.unref();
      });
  };

  private readonly authenticate = async (
    socket: RealtimeSocket,
    next: (error?: Error) => void,
  ): Promise<void> => {
    socket.data.marketRooms = new Set();
    try {
      // The exact call SessionGuard makes; fromNodeHeaders is a pure loop over
      // IncomingHttpHeaders and needs no request object.
      const session = await this.auth.api.getSession({
        headers: fromNodeHeaders(socket.handshake.headers),
      });
      socket.data.userId = session?.user.id;
    } catch (error) {
      // PLAN 8 admits anonymous sockets, so a session store that is down must degrade to one
      // rather than refuse a public subscription.
      this.logger.warn(`handshake session lookup failed: ${String(error)}`);
    }
    next();
  };

  /**
   * Synchronous, so it completes before Nest binds this socket's message handlers: the
   * connection handler calls it and `subscribeMessages(...)` in one tick, so no message can
   * precede the join.
   */
  handleConnection(client: RealtimeSocket): void {
    const userId = client.data.userId;
    // Derived from the handshake session and never from a payload: the client protocol carries
    // marketIds only, so there is no user-room authorization surface to get wrong.
    if (userId !== undefined) void client.join(userChannel(userId));
  }

  private readonly onChannelMessage = (pattern: string, channel: string, message: string): void => {
    const namespace = this.namespace;
    if (!namespace) return;
    // marketChannel()/userChannel() produce the Redis channel AND the room name, so the room is
    // known before the parse. `adapter.rooms` is the local room map even under the Redis adapter.
    if (!namespace.adapter.rooms.has(channel)) return;

    let payload: unknown;
    try {
      payload = JSON.parse(message);
    } catch {
      this.logger.warn(`dropped a non-JSON message on ${channel}`);
      return;
    }

    // Parsing per family IS the authorization check: a `user:balance` published on a market
    // channel would otherwise be broadcast to every subscriber of that public room, and an
    // unvalidated `event.type` is an attacker-chosen emit name (socket.io throws on a reserved
    // one).
    const parsed =
      pattern === MARKET_CHANNEL_PATTERN
        ? marketRealtimeEventSchema.safeParse(payload)
        : userRealtimeEventSchema.safeParse(payload);
    if (!parsed.success) {
      this.logger.warn(`dropped a malformed ${pattern} event on ${channel}`);
      return;
    }

    const event = parsed.data;
    // `.local`: see the invariant at the top of this file. `market:tick` is additionally
    // volatile — it is a tradeCount-ordered snapshot that the next one supersedes, so a client
    // whose transport is backed up may lose one; every other event is a fact that must arrive.
    const to =
      event.type === 'market:tick'
        ? namespace.local.volatile.to(channel)
        : namespace.local.to(channel);
    to.emit(event.type, event);
  };

  /**
   * Joins the `market:<id>` rooms of the payload. No ack and no return value: the handler
   * answers only when it refuses, through RealtimeExceptionFilter's `exception` event.
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(@ConnectedSocket() client: RealtimeSocket, @MessageBody() body: unknown): void {
    // A dedicated Set, not socket.rooms: that one also holds the socket's own id room and the
    // user room, and a repeated marketId would double-count against the cap.
    const rooms = client.data.marketRooms;
    for (const marketId of marketIdsOf(body)) {
      const room = marketChannel(marketId);
      if (rooms.has(room)) continue;
      if (rooms.size >= REALTIME_ROOMS_MAX) {
        // VALIDATION_ERROR, not RATE_LIMITED: that code is reserved for PLAN 7.5 / M6.
        throw new AppError('VALIDATION_ERROR', {
          message: `At most ${String(REALTIME_ROOMS_MAX)} markets per socket`,
          details: [{ path: ['marketIds'], message: 'subscription limit reached' }],
        });
      }
      void client.join(room); // in-memory and synchronous under both adapters
      rooms.add(room);
    }
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(@ConnectedSocket() client: RealtimeSocket, @MessageBody() body: unknown): void {
    const rooms = client.data.marketRooms;
    for (const marketId of marketIdsOf(body)) {
      const room = marketChannel(marketId);
      if (!rooms.delete(room)) continue;
      void client.leave(room);
    }
  }
}

/**
 * The third uuid request boundary (A-M3-17): an upper-case id would join a room no publisher
 * ever writes to, and the socket would sit silent rather than fail. Parsed here rather than
 * with `@MessageBody({ schema })` so the failure is our AppError with the PLAN 7.4 code,
 * carrying the same `details` shape as a REST VALIDATION_ERROR.
 */
function marketIdsOf(body: unknown): readonly string[] {
  const parsed = subscribeBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', {
      message: 'Request validation failed',
      details: parsed.error.issues.map((issue) => toValidationIssue(issue)),
    });
  }
  return parsed.data.marketIds;
}
