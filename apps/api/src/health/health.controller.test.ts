import { ServiceUnavailableException, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { type Db } from '@buddha/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB } from '../infra/db/db.provider.js';
import { REDIS } from '../infra/redis/redis.provider.js';
import { HealthController, type HealthResponse } from './health.controller.js';

interface MockOpts {
  dbOk: boolean;
  redisOk: boolean;
}

function makeMocks(opts: MockOpts) {
  const execute = vi.fn(() =>
    opts.dbOk
      ? Promise.resolve({ rows: [{ '?column?': 1 }] })
      : Promise.reject(new Error('db down')),
  );
  const db = { execute } as unknown as Db;
  const redis = {
    ping: vi.fn(() =>
      opts.redisOk ? Promise.resolve('PONG') : Promise.reject(new Error('redis down')),
    ),
  };
  return { db, execute, redis };
}

async function makeModule(opts: MockOpts) {
  const { db, execute, redis } = makeMocks(opts);
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: DB, useValue: db },
      { provide: REDIS, useValue: redis },
    ],
  }).compile();
  return { moduleRef, execute, redis };
}

describe('HealthController (unit)', () => {
  it('returns ok when db and redis both answer', async () => {
    const { moduleRef, execute, redis } = await makeModule({ dbOk: true, redisOk: true });
    const controller = moduleRef.get(HealthController);
    await expect(controller.check()).resolves.toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  it('throws 503 with a degraded body when redis fails', async () => {
    const { moduleRef } = await makeModule({ dbOk: true, redisOk: false });
    const controller = moduleRef.get(HealthController);
    const err: unknown = await controller.check().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    const ex = err as ServiceUnavailableException;
    expect(ex.getStatus()).toBe(503);
    expect(ex.getResponse()).toEqual<HealthResponse>({
      status: 'degraded',
      db: 'ok',
      redis: 'error',
    });
  });

  it('reports both dependencies down', async () => {
    const { moduleRef } = await makeModule({ dbOk: false, redisOk: false });
    const controller = moduleRef.get(HealthController);
    const err = (await controller.check().catch((e: unknown) => e)) as ServiceUnavailableException;
    expect(err.getResponse()).toEqual<HealthResponse>({
      status: 'degraded',
      db: 'error',
      redis: 'error',
    });
  });
});

describe('HealthController (HTTP through the Fastify adapter)', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function makeApp(opts: MockOpts): Promise<NestFastifyApplication> {
    const { moduleRef } = await makeModule(opts);
    const a = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      bodyParser: false,
    });
    a.setGlobalPrefix('api');
    a.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await a.init();
    await a.getHttpAdapter().getInstance().ready();
    app = a;
    return a;
  }

  it('GET /api/health -> 200 ok, and is not mounted under /v1', async () => {
    const a = await makeApp({ dbOk: true, redisOk: true });
    const res = await a.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok', redis: 'ok' });
    const versioned = await a.inject({ method: 'GET', url: '/api/v1/health' });
    expect(versioned.statusCode).toBe(404);
  });

  it('GET /api/health -> 503 with the degraded body when db fails', async () => {
    const a = await makeApp({ dbOk: false, redisOk: true });
    const res = await a.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', db: 'error', redis: 'ok' });
  });
});
