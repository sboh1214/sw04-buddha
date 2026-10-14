import { randomUUID } from 'node:crypto';
import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { loadEnv, parseTrustProxy } from './config/env.js';
import { MAX_PARAM_LENGTH } from './infra/http/fastify-options.js';
import { registerSecurityHeaders } from './infra/http/security-headers.js';
import { installAddressLimit } from './rate-limit/address-limit.js';
import { ApiLogController, NestPinoLogger, createLogger } from './logger.js';
import { RealtimeIoAdapter } from './realtime/realtime-io.adapter.js';

async function bootstrap(): Promise<void> {
  // Fastify server options (trustProxy) and the listen address must be known before
  // the Nest app exists, so the environment is loaded and validated here.
  const env = loadEnv();
  // One pino instance for the whole process (PLAN M6 "요청 로깅"): Fastify writes its per-request
  // lines to it and the `logger` option below sends everything Nest's own `Logger` produces to
  // the same stream, so the API speaks one format.
  const logger = createLogger(env);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // TRUST_PROXY names the proxy hops allowed to set X-Forwarded-* (PLAN 7.5 rate limits
    // need a truthful client IP). It is false by default: the Next.js rewrite does not add
    // a trustworthy X-Forwarded-For, so trusting it would let clients spoof their address.
    new FastifyAdapter({
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
      routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
      loggerInstance: logger,
      // An INSTANCE, not the class: Fastify's own type alias reads as one and `createLogController`
      // rejects a constructor outright (FST_ERR_LOG_INVALID_LOG_CONTROLLER).
      logController: new ApiLogController(),
      // A request id per request, bound to that request's child logger, so the arrival line,
      // the completion line and anything a handler logs in between can be read as one story.
      // Generated, never taken from a header: an id a caller supplies is a value a caller
      // controls, and this one is only ever read back out of our own logs.
      genReqId: () => randomUUID(),
    }),
    // Keep Nest from registering @fastify/formbody; better-auth (M1) installs
    // the parsers it needs. Fastify's built-in JSON parser is unaffected.
    //
    // The logger is passed HERE rather than through a later `app.useLogger`: everything Nest
    // says while it builds the container — the route map, a provider that failed to resolve —
    // is emitted during `create`, so installing it afterwards would print the first two dozen
    // lines of every boot in a second format.
    { bodyParser: false, logger: new NestPinoLogger(logger) },
  );

  // Before init, like the WebSocket adapter below, and mirrored in test/app.ts (PLAN M6
  // "보안: 헤더"). A Fastify plugin cannot be registered on a started instance, and the address
  // limit's hook has to be registered ahead of the middie middleware Nest flushes during init —
  // and after the headers, so a 429 it sends carries them.
  await registerSecurityHeaders(app);
  installAddressLimit(app);

  // /api/health (VERSION_NEUTRAL) and /api/v1/<resource> for everything else.
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();

  // Before init (app.listen() runs it): the /ws handshake CORS, the Origin gate, the Redis
  // adapter and the message bound cannot be expressed as @WebSocketGateway() metadata. The same
  // line exists in test/app.ts — the two must not drift.
  app.useWebSocketAdapter(new RealtimeIoAdapter(app));

  await app.listen(env.API_PORT, env.API_HOST);
  Logger.log(`API listening on http://${env.API_HOST}:${String(env.API_PORT)}/api`, 'Bootstrap');
}

await bootstrap();
