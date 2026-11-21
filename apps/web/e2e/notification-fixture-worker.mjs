/**
 * The notification fixture's child process (#53, ADR-0157; notification-fixture.ts forks it). #53
 * ships no notification type and no producer (52-20), so nothing the API or a browser can do makes
 * a notification: this delivers the tests' own type through the real write path
 * (`createTestNotification`, @buddha/db/test — `createNotifications` with the test definitions,
 * which no production source may pass), as the API role the producers run as (buddha_app).
 *
 * The URLs are validated before the database graph is imported or a connection opened — the same
 * boundary as the correction fixture's (`correctionFixtureUrls`: a local test profile or the
 * repository's disposable CI service only; importing that module starts nothing) — and only the
 * app URL is connected. No advisory lock: the rows belong to a member the spec has just signed up.
 */
import { correctionFixtureUrls } from './reconciliation-correction-worker.mjs';

/** Replaces any database URL in a message, so nothing of the environment reaches a log. */
function sanitized(error) {
  return String(error instanceof Error ? error.message : 'Notification E2E fixture failed').replace(
    /postgres(?:ql)?:\/\/\S+/g,
    '[database URL]',
  );
}

/**
 * Between two notifications of one call, so each has its own 발생 시각 (stored to the ms) and the
 * order is known. Small, so a call's oldest still comes after the previous call's newest: a call
 * of 100 spans one second, and a spec's calls are seconds apart.
 */
const SPACING_MS = 10;

async function startWorker() {
  // Validate before importing the DB graph or opening a connection, even for direct invocation.
  const urls = correctionFixtureUrls();
  if (!process.send) throw new Error('Notification E2E fixture requires a parent IPC channel');
  const [{ createDb, closeDb }, { createTestNotification }] = await Promise.all([
    import('@buddha/db'),
    import('@buddha/db/test'),
  ]);
  const db = createDb(urls.appUrl, {
    max: 2,
    applicationName: 'e2e-notifications',
    onPoolError: () => {},
  });
  let closing;
  const close = () => (closing ??= closeDb(db));
  const stop = () => {
    void close().finally(() => process.exit(0));
  };
  process.once('disconnect', stop);
  process.once('SIGTERM', stop);
  const ready = (async () => {
    const { rows } = await db.$client.query('SELECT current_database() AS name');
    if (rows[0]?.name !== urls.database) throw new Error('Notification E2E database mismatch');
  })();
  void ready.catch(() => undefined);

  async function operation(name, args) {
    await ready;
    if (name === 'ready') return null;
    if (name === 'close') {
      await close();
      return null;
    }
    if (name === 'notify') {
      const count = Number(args.count);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
        throw new Error('Notification E2E fixture takes 1 to 100 notifications a call');
      }
      // Oldest first, each SPACING_MS apart and all before now: a later call's are newer.
      const start = Date.now() - count * SPACING_MS;
      const ids = [];
      for (let n = 0; n < count; n += 1) {
        const outcome = await createTestNotification(db, {
          userId: String(args.userId),
          slug: String(args.slug),
          label: `${String(args.label)} ${String(n + 1)}`,
          occurredAt: new Date(start + n * SPACING_MS),
        });
        if (outcome.kind !== 'created') {
          throw new Error(`Notification E2E fixture was answered ${outcome.kind}`);
        }
        ids.push(outcome.id);
      }
      return ids;
    }
    throw new Error('Unknown notification E2E fixture operation');
  }

  let sequence = Promise.resolve();
  process.on('message', (message) => {
    sequence = sequence.then(async () => {
      const { id, operation: name, args } = message;
      try {
        const data = await operation(name, args);
        process.send({ id, data }, () => {
          if (name === 'close') process.disconnect();
        });
      } catch (error) {
        process.send({ id, error: sanitized(error) });
      }
    });
  });
  process.send({ id: 0, data: 'boot' });
}

if (process.argv[2] === 'notification-fixture-worker') {
  startWorker().catch((error) => {
    // Validation and loader failures contain no environment values; never print an error stack.
    process.stderr.write(`${sanitized(error)}\n`);
    process.exit(1);
  });
}
