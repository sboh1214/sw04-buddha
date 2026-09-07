import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { REALTIME_MAX_MESSAGE_BYTES } from '@buddha/shared';
import { createAdapter } from '@socket.io/redis-adapter';
import { type Redis } from 'ioredis';
import { type Server, type ServerOptions } from 'socket.io';
import { type Env, webOrigins } from '../config/env.js';
import { REDIS, REDIS_ADAPTER_SUBSCRIBER } from '../infra/redis/redis.provider.js';

/**
 * The Socket.IO server options that need the environment and the DI container: handshake
 * CORS, the Origin gate, the Redis adapter and the message bound. Subclassing IoAdapter is
 * the only hook for them — `@WebSocketGateway()` options are static decorator metadata and
 * cannot read ConfigService, and a `loadEnv()` at module scope would also run inside
 * `pnpm api:openapi` (which boots AppModule with `preview: true` and placeholder env).
 *
 * Install it with `app.useWebSocketAdapter(new RealtimeIoAdapter(app))` in BOTH main.ts and
 * test/app.ts, before init: forgetting test/app.ts makes every socket test exercise Nest's
 * default IoAdapter — no Origin gate, no Redis adapter, no bound — and pass while production
 * behaves differently.
 */
export class RealtimeIoAdapter extends IoAdapter {
  constructor(private readonly app: INestApplication) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    // Safe here: NestFactory.create()/createNestApplication() has already instantiated the
    // container, and SocketModule.register runs later, inside app.init().
    const config = this.app.get<ConfigService<Env, true>>(ConfigService);
    const origins = webOrigins({
      WEB_ORIGIN: config.get('WEB_ORIGIN', { infer: true }),
      BETTER_AUTH_URL: config.get('BETTER_AUTH_URL', { infer: true }),
    });
    const trusted = new Set(origins);

    const serverOptions: Partial<ServerOptions> = {
      ...options,
      // ADR-0017: CORS is opened for the handshake only. REST stays same-origin behind the
      // Next rewrite (auth.module.ts disableTrustedOriginsCors), so never app.enableCors() —
      // engine.io answers its own preflight on the socket path.
      cors: { origin: origins, credentials: true, methods: ['GET', 'POST'] },
      // The `cors` option guards polling alone. engine.io does run the cors middleware on the
      // upgrade, but the `cors` package calls next() for any non-OPTIONS request — it omits
      // the header, it does not abort — and a browser does not enforce
      // Access-Control-Allow-Origin on a WebSocket upgrade, so `cors` cannot stop a
      // cross-origin cookie-authenticated socket. This is SessionGuard.refuseForeignOrigin for
      // the socket, and engine.io answers FORBIDDEN with it before a socket or a session lookup
      // exists. An absent Origin passes, exactly as in SessionGuard: it came from no browser.
      allowRequest: (request, callback) => {
        const origin = request.headers.origin;
        callback(null, origin === undefined || trusted.has(origin));
      },
      serveClient: false, // default is true; do not serve the client bundle from the API
      maxHttpBufferSize: REALTIME_MAX_MESSAGE_BYTES,
      // Read by the Server constructor before it creates the `/` namespace, so both namespaces
      // get it. Dormant while every domain fan-out is `.local` (see MarketGateway), and the pub
      // client is the shared REDIS — only the subscriber has to be its own connection.
      adapter: createAdapter(
        this.app.get<Redis>(REDIS),
        this.app.get<Redis>(REDIS_ADAPTER_SUBSCRIBER),
      ),
      // connectionStateRecovery stays off: it swaps in a session-aware adapter, and this
      // protocol re-snapshots over REST on reconnect instead (A-M3-19).
    };
    // Default transports (polling + websocket) are kept: websocket-only breaks clients behind
    // upgrade-blocking proxies. The web client merely orders its preference.
    return super.createIOServer(port, serverOptions as ServerOptions);
  }
}
