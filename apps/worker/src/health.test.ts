import { createServer } from 'node:net';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { startHealthServer, type HealthServer } from './health.js';

const logger = pino({ level: 'silent' });

/**
 * An ephemeral port the OS hands out and releases. The health server itself treats 0 as
 * "disabled" (env.ts), so the test cannot ask it for a random port; the tiny window between
 * releasing this listener and binding the next is the accepted price.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** The whole body; `uptimeSeconds` is the one field no assertion can pin to a literal. */
function body(status: 'ok' | 'starting') {
  return {
    status,
    uptimeSeconds: expect.any(Number) as number,
    queues: ['markets', 'audit'],
  };
}

describe('health server', () => {
  let server: HealthServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('answers 503 "starting" until the worker is ready, then 200 "ok"', async () => {
    const port = await freePort();
    let ready = false;
    server = await startHealthServer({
      port,
      host: '127.0.0.1',
      isReady: () => ready,
      queues: ['markets', 'audit'],
      logger,
    });
    expect(server).not.toBeNull();
    const url = `http://127.0.0.1:${String(port)}/health`;

    const starting = await fetch(url);
    expect(starting.status).toBe(503);
    expect(starting.headers.get('content-type')).toBe('application/json');
    // The detail travels on BOTH answers, so a poller waiting on 503 can already see which
    // process it is talking to and how long it has been trying (PLAN M6 "헬스체크 상세").
    expect(await starting.json()).toEqual(body('starting'));

    // Read per request, not captured at start: the flag flips after the queues are ready.
    ready = true;
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(body('ok'));
  });

  it('answers 404 for anything but GET /health', async () => {
    const port = await freePort();
    server = await startHealthServer({ port, host: '127.0.0.1', isReady: () => true, logger });
    const base = `http://127.0.0.1:${String(port)}`;
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404);
  });

  it('does not listen when the port is 0 (WORKER_HEALTH_PORT=0 disables it)', async () => {
    server = await startHealthServer({ port: 0, host: '127.0.0.1', isReady: () => true, logger });
    expect(server).toBeNull();
  });

  it('fails startup loudly when the port is taken instead of emitting an unhandled error', async () => {
    const port = await freePort();
    server = await startHealthServer({ port, host: '127.0.0.1', isReady: () => true, logger });
    await expect(
      startHealthServer({ port, host: '127.0.0.1', isReady: () => true, logger }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('close() releases the port even with a keep-alive connection open', async () => {
    const port = await freePort();
    const started = await startHealthServer({
      port,
      host: '127.0.0.1',
      isReady: () => true,
      logger,
    });
    server = started;
    // fetch keeps the connection alive by default; a plain server.close() would wait for it.
    expect((await fetch(`http://127.0.0.1:${String(port)}/health`)).status).toBe(200);
    await started!.close();
    server = null;
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).rejects.toThrow();
  });
});
