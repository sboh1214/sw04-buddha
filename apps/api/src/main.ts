import { Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { type Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // trustProxy: the API always sits behind the Next.js rewrite / a load
    // balancer, so X-Forwarded-* headers are trusted for client IPs.
    new FastifyAdapter({ trustProxy: true }),
    // Keep Nest from registering @fastify/formbody; better-auth (M1) installs
    // the parsers it needs. Fastify's built-in JSON parser is unaffected.
    { bodyParser: false },
  );

  // /api/health (VERSION_NEUTRAL) and /api/v1/<resource> for everything else.
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('API_PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
  Logger.log(`API listening on http://0.0.0.0:${String(port)}/api`, 'Bootstrap');
}

await bootstrap();
