/**
 * PLAN M6 "보안: 헤더(helmet 상당)". A small app rather than `createTestApp`: the headers are a
 * property of the Fastify instance, so nothing here needs Postgres, Redis or the file lock.
 */
import { Controller, Get } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommonModule } from '../../common/common.module.js';
import { registerSecurityHeaders } from './security-headers.js';

@Controller('thing')
class ThingController {
  @Get()
  get() {
    return { fine: true };
  }
}

describe('security headers', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CommonModule],
      controllers: [ThingController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await registerSecurityHeaders(app);
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses to be framed, sniffed or referred', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/thing' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none'",
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // The legacy twin of `frame-ancestors 'none'`, and it has to agree with it: helmet's
    // default is SAMEORIGIN, which a browser reading only this header would honour.
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    // Sent over plain HTTP too; a browser ignores it unless the response came over TLS, which
    // is why there is no second configuration path for production.
    expect(res.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
  });

  it('asks search engines not to index any response (ADR-0075, owner decision 2026-10-21)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/thing' });
    expect(res.headers['x-robots-tag']).toBe('noindex');
  });

  it('allows a sibling host of the same site to read a response (ADR-0017)', async () => {
    // `same-origin` — helmet's default — would be a rule this architecture is built to break:
    // the browser dials the API origin directly for the socket, and the app dials it for
    // everything.
    const res = await app.inject({ method: 'GET', url: '/api/thing' });
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
  });

  it('leaves an error response as protected as a successful one', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    // The header that matters on a 404: an error body is exactly what an attacker would want
    // to frame and read, and it is the response most likely to escape a per-route rule.
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-robots-tag']).toBe('noindex');
  });
});
