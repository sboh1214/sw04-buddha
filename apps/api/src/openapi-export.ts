// CLI entry: `pnpm --filter api openapi:export` (node dist/openapi-export.js) writes
// apps/api/openapi.json for packages/api-client (root `pnpm api:openapi`).
//
// Must run from the tsc build (dist): @nestjs/swagger reads `design:paramtypes`, which
// tsx/esbuild never emit, so a document generated under tsx would have no parameters.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

// The document needs route metadata only. `preview: true` skips provider instantiation
// (no Postgres pool, no Redis client, no better-auth instance), but ConfigModule still
// validates the environment at import time, so required values get placeholders when the
// caller has no .env (CI).
process.env.DATABASE_URL ??= 'postgres://export@localhost:5432/export';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.BETTER_AUTH_SECRET ??= 'openapi-export-placeholder-secret-not-used-anywhere';

const { AppModule } = await import('./app.module.js');
const { createOpenApiDocument } = await import('./openapi/document.js');

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
  logger: false,
  preview: true,
});
app.setGlobalPrefix('api');
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

const document = createOpenApiDocument(app);
const output = path.resolve(import.meta.dirname, '../openapi.json');
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `[openapi:export] wrote ${output} (${String(Object.keys(document.paths).length)} paths)`,
);
await app.close();
