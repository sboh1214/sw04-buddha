import { fork } from 'node:child_process';
import { correctionFixtureUrls } from './reconciliation-correction-worker.mjs';

type Reply = { id: number; data?: unknown; error?: string };

/** What one `notify` makes: `count` notifications of the tests' type, 10 ms apart. */
export interface NotifyInput {
  /** The member's account (`GET /me`'s id). */
  userId: string;
  /** The market every one of them leads to. */
  slug: string;
  count: number;
  /** Each one's label, numbered — stored as its param; the web shows the fallback title. */
  label: string;
}

/**
 * The notifications a spec needs (#53, ADR-0157), made in a native child process
 * (notification-fixture-worker.mjs) — the repository's way to reach a state neither the API nor a
 * browser can (reconciliation-correction-fixture.ts): #53 ships no notification type and no
 * producer (52-20), so the rows come from the real write path with the tests' own type, as the
 * API's role (buddha_app). The child is forked without Playwright's loader flags, so the database
 * graph stays out of Playwright's transformed module cache; it validates the database URLs
 * (`correctionFixtureUrls`) before it imports anything of the database or connects, connects with
 * the app URL alone, and sends back sanitised errors only.
 *
 * `notify` answers the ids it made, oldest first; a later call's are newer than an earlier one's.
 * `close` ends the child (call it in a `finally`).
 */
export async function notificationFixture({ operationTimeoutMs = 60_000 } = {}) {
  const urls = correctionFixtureUrls();
  const child = fork(
    require.resolve('./notification-fixture-worker.mjs'),
    ['notification-fixture-worker'],
    {
      // Do not inherit Playwright's loader flags. Credentials remain in the child environment.
      execArgv: [],
      env: {
        ...process.env,
        DATABASE_URL: urls.appUrl,
        DATABASE_MIGRATE_URL: urls.migrateUrl,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let nextId = 0;
  let closing = false;
  const calls = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const forced = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1_000);
    forced.unref();
  };
  process.once('exit', kill);
  const fail = (message: string) => {
    for (const call of calls.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(message));
    }
    calls.clear();
  };
  const boot = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      fail('Notification E2E fixture timed out');
      kill();
    }, operationTimeoutMs);
    calls.set(0, { resolve: () => resolve(), reject, timer });
  });
  child.on('message', (reply: Reply) => {
    const call = calls.get(reply.id);
    if (!call) return;
    calls.delete(reply.id);
    clearTimeout(call.timer);
    if (reply.error) call.reject(new Error(reply.error));
    else call.resolve(reply.data);
  });
  // The worker returns sanitized operation errors over IPC; stderr is never echoed with env data.
  child.stderr?.resume();
  child.on('error', () => fail('Notification E2E fixture could not start'));
  child.on('exit', () => {
    fail('Notification E2E fixture exited');
    process.off('exit', kill);
  });
  const call = <T>(operation: string, args: Record<string, string | number> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        fail('Notification E2E fixture timed out');
        kill();
      }, operationTimeoutMs);
      calls.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      child.send({ id, operation, args }, (error) => {
        if (error) {
          fail('Notification E2E fixture disconnected');
          kill();
        }
      });
    });
  try {
    await boot;
    await call('ready');
  } catch (error) {
    kill();
    process.off('exit', kill);
    throw error;
  }
  return {
    notify: (input: NotifyInput) => call<string[]>('notify', { ...input }),
    async close() {
      if (closing) return;
      closing = true;
      try {
        await call('close');
      } finally {
        kill();
        process.off('exit', kill);
      }
    },
  };
}
