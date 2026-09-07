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

// OpenAPI 3.0 forbids two parameters with one (name, in) on an operation. It happens when a
// handler declares `@ApiQuery` for a field that swagger already expanded from a
// `@Query({ schema })` object without a component id (see markets.controller.ts), and
// openapi-typescript hides it (it keys parameters by name), so fail here instead.
const duplicates: string[] = [];
for (const [route, operations] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(operations)) {
    const seen = new Set<string>();
    for (const parameter of (operation as { parameters?: { name: string; in: string }[] })
      .parameters ?? []) {
      const key = `${parameter.in}:${parameter.name}`;
      if (seen.has(key)) duplicates.push(`${method.toUpperCase()} ${route} ${key}`);
      seen.add(key);
    }
  }
}
if (duplicates.length > 0) {
  throw new Error(`[openapi:export] duplicate parameters:\n  ${duplicates.join('\n  ')}`);
}

const output = path.resolve(import.meta.dirname, '../openapi.json');
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `[openapi:export] wrote ${output} (${String(Object.keys(document.paths).length)} paths)`,
);
await app.close();
