import { createServer, type Server } from 'node:http';
import { type Logger } from 'pino';

export interface HealthServerOptions {
  /** 0 disables the server (env.ts WORKER_HEALTH_PORT). */
  port: number;
  host: string;
  /** Read per request: the answer flips to 200 the moment the worker logs 'worker ready'. */
  isReady: () => boolean;
  logger: Logger;
}

export interface HealthServer {
  /** Stops listening and drops open keep-alive connections, so shutdown never waits on one. */
  close(): Promise<void>;
}

/**
 * `GET /health` for whoever has to wait for the worker: Playwright's `webServer` and the CI
 * job poll it before the settlement e2e starts (PLAN M5 AC 7 — a test that proposes a result
 * and waits for the payout needs a worker that is actually consuming the queue, not one still
 * connecting). 503 `{ status: 'starting' }` until `isReady()`, then 200 `{ status: 'ok' }`;
 * anything else is 404. node:http, not a framework: one route, no dependency, no middleware
 * that could keep the event loop alive after shutdown.
 *
 * Returns null without listening when `port` is 0 — a deployment that probes the process some
 * other way should not get a socket it never asked for (and `listen(0)` would pick a random
 * port rather than disable anything). Resolves once the socket is bound, so an EADDRINUSE fails
 * startup loudly instead of surfacing as an 'error' event nobody listens to.
 */
export async function startHealthServer(
  options: HealthServerOptions,
): Promise<HealthServer | null> {
  const { port, host, isReady, logger } = options;
  if (port === 0) {
    logger.info('health server disabled (WORKER_HEALTH_PORT=0)');
    return null;
  }

  const server: Server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_found' }));
      return;
    }
    const ready = isReady();
    res.writeHead(ready ? 200 : 503, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({ status: ready ? 'ok' : 'starting' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // The bound address, not the requested one: `host` may resolve to several (localhost → ::1
  // or 127.0.0.1), and the log is what a reader pastes into curl.
  const address = server.address();
  const bound =
    address && typeof address === 'object' ? `${address.address}:${String(address.port)}` : host;
  logger.info({ address: bound }, 'health server listening');

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        // `close()` alone waits for idle keep-alive connections to end on their own — a poller
        // that holds one open would hold shutdown until SHUTDOWN_TIMEOUT_MS forces the exit.
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
