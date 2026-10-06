import { createServer, type Server } from 'node:http';
import { type Logger } from 'pino';

export interface HealthServerOptions {
  /** 0 disables the server (env.ts WORKER_HEALTH_PORT). */
  port: number;
  host: string;
  /** Read per request: the answer flips to 200 the moment the worker logs 'worker ready'. */
  isReady: () => boolean;
  /**
   * Queues this process consumes, reported for the operator who has to answer "is the worker
   * doing what it was started to do" without reading the boot log. Descriptive only: a name
   * here never moves the 200/503 (see the body doc below).
   */
  queues?: readonly string[];
  logger: Logger;
}

/** The body `GET /health` answers with. `status` alone decides the HTTP code. */
export interface WorkerHealthBody {
  status: 'ok' | 'starting';
  /** Whole seconds since this process started; the cheapest way to spot a restart loop. */
  uptimeSeconds: number;
  queues: readonly string[];
}

export interface HealthServer {
  /** Stops listening and drops open keep-alive connections, so shutdown never waits on one. */
  close(): Promise<void>;
}

/**
 * `GET /health` for whoever has to wait for the worker: Playwright's `webServer` and the CI
 * job poll it before the settlement e2e starts (PLAN M5 AC 7 — a test that judges a market
 * (판정, final at once, ADR-0046) and waits for the payout needs a worker that is actually
 * consuming the queue, not one still connecting). What `isReady()` MEANS is main.ts's to own —
 * the queues attached and Postgres answered once (`waitForDb`, db-ready.ts) — so this module
 * stays the one thing its own docblock claims. 503 `{ status: 'starting' }` until `isReady()`,
 * then 200 `{ status: 'ok' }`; anything else is 404. node:http, not a framework: one route, no
 * dependency, no middleware that could keep the event loop alive after shutdown.
 *
 * Returns null without listening when `port` is 0 — a deployment that probes the process some
 * other way should not get a socket it never asked for (and `listen(0)` would pick a random
 * port rather than disable anything). Resolves once the socket is bound, so an EADDRINUSE fails
 * startup loudly instead of surfacing as an 'error' event nobody listens to.
 */
export async function startHealthServer(
  options: HealthServerOptions,
): Promise<HealthServer | null> {
  const { port, host, isReady, queues, logger } = options;
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
    // PLAN M6 "헬스체크 상세" — detail ADDED, semantics untouched. Making this a live probe of
    // Postgres and Redis the way the API's is (Q-M5-11) would change what a 200 means for a
    // queue consumer whose normal state between scans is zero open connections, and that is an
    // owner decision this milestone records rather than takes. `uptimeSeconds` and `queues`
    // answer the two questions the old one-word body could not — is it restarting, and is it
    // the worker I think it is — without touching the flag Playwright and CI wait on.
    const body: WorkerHealthBody = {
      status: ready ? 'ok' : 'starting',
      uptimeSeconds: Math.floor(process.uptime()),
      queues: queues ?? [],
    };
    res.writeHead(ready ? 200 : 503, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
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
