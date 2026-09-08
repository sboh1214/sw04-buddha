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
  type SubscribeBody,
} from '@buddha/shared';
import { fromNodeHeaders } from 'better-auth/node';
import { type Redis } from 'ioredis';
import { type DefaultEventsMap, type Namespace, type Socket } from 'socket.io';
import { AUTH, type Auth } from '../auth/auth.js';
import { AppError } from '../common/errors/app-error.js';
import { REDIS_SUBSCRIBER } from '../infra/redis/redis.provider.js';
import { RealtimeExceptionFilter } from './realtime-exception.filter.js';

/** Keep-alive on the subscriber connection; unref'd so it never holds the process open. */
const PING_INTERVAL_MS = 30_000;
/** Delay before a rejected `psubscribe` is retried; exported so a test can wait one out. */
export const ARM_RETRY_MS = 1_000;
/**
 * How many times a handshake asks for the session before it gives up and admits the socket as
 * anonymous. Exported so a test can count the attempts rather than guess at them.
 *
 * Two, not more: the cost is paid on the ERROR path only (see `authenticate`), and a handshake
 * that waits is a screen that stays blank — this runs before Nest binds the socket's handlers.
 */
export const SESSION_LOOKUP_ATTEMPTS = 2;

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
  /** An arm has been rejected since the last successful one, so events were missed. */
  private gap = false;
  /** Shutdown has run; no further psubscribe and no further retry. */
  private stopped = false;

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
    // First, because clearing the timer is not enough on its own: an arm in flight right now
    // rejects AFTER this runs (on `commandTimeout`, or on the flush when RedisModule quits the
    // client), and an unguarded catch would then schedule a retry against a client whose status
    // is `end` — which ioredis rejects synchronously, scheduling another: one psubscribe and one
    // warning per ARM_RETRY_MS for the life of the process.
    this.stopped = true;
    if (this.ping) clearInterval(this.ping);
    this.clearRetry();
    // RedisModule quits the connection itself; drop the listeners so a message arriving during
    // shutdown cannot emit into a namespace that is already closing.
    this.subscriber.off('pmessage', this.onChannelMessage);
    this.subscriber.off('ready', this.arm);
  }

  /** A pending retry must outlive neither the shutdown nor an arm that made it unnecessary. */
  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }

  /**
   * `ready` alone is not enough: `commandTimeout` can reject a PSUBSCRIBE on a live-but-silent
   * Redis with no later `ready`, and the gateway would stay deaf for the life of the process.
   * A bounded retry closes that. Whenever an arm lands on a gap — the subscription was down
   * while the publisher (another connection, and under multi-instance another process) kept
   * publishing — the clients are told to re-read their REST snapshots (A-M3-19); `.local`,
   * because this runs on every instance.
   */
  private readonly arm = (): void => {
    if (this.stopped) return;
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
        // The patterns are live again, so a retry queued by an earlier rejection has nothing
        // left to repair. Left pending it would psubscribe a second time and announce a gap
        // this arm has already closed — a duplicate resync storm from every client at once.
        this.clearRetry();
        // Two different gaps, and the flag pair is not redundant. `armed` catches the one a
        // reconnect makes: the first arm succeeded, the subscription was later lost, and this
        // is the re-arm. `gap` catches its mirror — a FAILED arm since the last successful one
        // (including a failed FIRST arm, where `armed` is still false). `app.init()` returns
        // whether or not the eager arm succeeded and `app.listen()` follows immediately, so
        // sockets connect and take their snapshots during the retry window; those are exactly
        // the clients that missed events, and `armed` alone would suppress their resync.
        if (this.armed || this.gap) this.namespace?.local.emit(RESYNC_EVENT);
        this.gap = false;
        this.armed = true;
      })
      .catch((error: unknown) => {
        this.arming = false;
        // A rejection after shutdown is our own doing (RedisModule quits the client) and needs
        // neither a warning nor a retry: see onApplicationShutdown.
        if (this.stopped) return;
        // Whatever is published between here and the next successful arm is lost; that arm is
        // the only place that can say so.
        this.gap = true;
        this.logger.warn(`psubscribe failed, retrying: ${String(error)}`);
        this.retry = setTimeout(this.arm, ARM_RETRY_MS);
        this.retry.unref();
      });
  };

  /**
   * The handshake's one and only reading of who this socket is. `handleConnection` joins
   * `user:<id>` from it and nothing re-reads it afterwards, so what this decides holds for the
   * life of the connection.
   *
   * A failed lookup is RETRIED before it degrades, and the reason is that the degradation is
   * silent and permanent. A signed-in socket admitted as anonymous never joins `user:<id>`,
   * `onChannelMessage` drops every balance and position event for it (`rooms.has(channel)` is
   * false), and nothing re-authenticates: the client opens one handshake per IDENTITY
   * (realtime-provider.tsx), and a session refetch that answers the same account rebuilds
   * nothing. The tab stays connected, stays subscribed, and quietly stops being told about its
   * own money until the transport itself drops.
   *
   * The retry is free for a visitor who is not signed in. better-auth reads the session cookie
   * FIRST and returns null without touching the adapter when there is none
   * (api/routes/session.mjs), so an anonymous handshake cannot reach this catch at all — every
   * socket that does presented a signed session cookie and is claiming an account.
   *
   * It still DEGRADES rather than refusing, and that is not timidity: `next(error)` on a
   * namespace middleware is a CONNECT_ERROR, and socket.io-client answers one with
   * `destroy()` — "clean subscriptions to avoid reconnections" (socket.js) — so the tab would
   * lose public ticks too, permanently, with no retry of its own. Refusing trades a silent
   * partial loss for a silent total one. PLAN 8 admits anonymous sockets; this keeps that true
   * while making it the answer of last resort.
   */
  private readonly authenticate = async (
    socket: RealtimeSocket,
    next: (error?: Error) => void,
  ): Promise<void> => {
    socket.data.marketRooms = new Set();
    for (let attempt = 1; attempt <= SESSION_LOOKUP_ATTEMPTS; attempt += 1) {
      try {
        // The exact call SessionGuard makes; fromNodeHeaders is a pure loop over
        // IncomingHttpHeaders and needs no request object.
        const session = await this.auth.api.getSession({
          headers: fromNodeHeaders(socket.handshake.headers),
        });
        socket.data.userId = session?.user.id;
        break;
      } catch (error) {
        // The last attempt is the one that degrades; the earlier ones say so and try again.
        if (attempt < SESSION_LOOKUP_ATTEMPTS) {
          this.logger.warn(`handshake session lookup failed, retrying: ${String(error)}`);
          continue;
        }
        this.logger.warn(`handshake session lookup failed, admitting anonymous: ${String(error)}`);
      }
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
   *
   * The schema rides on the parameter rather than being parsed inside the handler, because the
   * global `ApiValidationPipe` runs first either way: with no schema attached it passes the
   * value through and its NUL sweep is then the one place in the app that walks an unvalidated,
   * attacker-shaped structure — and that walk is quadratic in depth (it copies the path array at
   * every level), so 4 KB of nesting from an anonymous socket costs ~30 ms of blocked event loop
   * against ~0.02 ms for a legitimate 100-uuid body. Validating first bounds what the sweep can
   * ever see to those 100 ids; the pre-validation walk the pipe still does (`stripProtoKeys`) is
   * linear, and is what every REST body already pays. The refusal is unchanged: the pipe's
   * `exceptionFactory` (createValidationPipe) builds the same AppError with the PLAN 7.4 code
   * and the same `details` shape this handler used to build itself.
   *
   * `subscribeBodySchema` lower-cases the ids — A-M3-17's third boundary: an upper-case uuid
   * would join a room no publisher ever writes to, and the socket would sit silent rather than
   * fail.
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody({ schema: subscribeBodySchema }) body: SubscribeBody,
  ): void {
    // A dedicated Set, not socket.rooms: that one also holds the socket's own id room and the
    // user room, and a repeated marketId would double-count against the cap.
    const rooms = client.data.marketRooms;
    for (const marketId of body.marketIds) {
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

  /** Same payload and the same pipe-first reasoning as `handleSubscribe` above. */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody({ schema: subscribeBodySchema }) body: SubscribeBody,
  ): void {
    const rooms = client.data.marketRooms;
    for (const marketId of body.marketIds) {
      const room = marketChannel(marketId);
      if (!rooms.delete(room)) continue;
      void client.leave(room);
    }
  }
}
