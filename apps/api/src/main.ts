import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { loadEnv, parseTrustProxy } from './config/env.js';
import { MAX_PARAM_LENGTH } from './infra/http/fastify-options.js';

async function bootstrap(): Promise<void> {
  // Fastify server options (trustProxy) and the listen address must be known before
  // the Nest app exists, so the environment is loaded and validated here.
  const env = loadEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // TRUST_PROXY names the proxy hops allowed to set X-Forwarded-* (PLAN 7.5 rate limits
    // need a truthful client IP). It is false by default: the Next.js rewrite does not add
    // X-Forwarded-For, so trusting it would let clients spoof their address.
    new FastifyAdapter({
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
      routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
    }),
    // Keep Nest from registering @fastify/formbody; better-auth (M1) installs
    // the parsers it needs. Fastify's built-in JSON parser is unaffected.
    { bodyParser: false },
  );

  // /api/health (VERSION_NEUTRAL) and /api/v1/<resource> for everything else.
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();

  await app.listen(env.API_PORT, env.API_HOST);
  Logger.log(`API listening on http://${env.API_HOST}:${String(env.API_PORT)}/api`, 'Bootstrap');
}

await bootstrap();
