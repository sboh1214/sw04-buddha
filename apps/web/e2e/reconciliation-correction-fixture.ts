import { fork } from 'node:child_process';
import { correctionFixtureUrls } from './reconciliation-correction-worker.mjs';

export { correctionFixtureUrls };

type Reply = { id: number; data?: unknown; error?: string };
type HolderAccount = { id: number; available: string; ledger: string };

/** Keep the native DB ESM graph out of Playwright's transformed shared-module cache. */
export async function correctionBooks({ operationTimeoutMs = 190_000 } = {}) {
  const urls = correctionFixtureUrls();
  const child = fork(
    require.resolve('./reconciliation-correction-worker.mjs'),
    ['correction-fixture-worker'],
    {
      // Do not inherit Playwright's loader flags. Credentials remain in the child environment.
      execArgv: [],
      env: {
        ...process.env,
        TEST_DATABASE_URL: urls.appUrl,
        TEST_DATABASE_MIGRATE_URL: urls.migrateUrl,
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
      fail('Correction E2E native fixture timed out');
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
  child.on('error', () => fail('Correction E2E native fixture could not start'));
  child.on('exit', () => {
    fail('Correction E2E native fixture exited');
    process.off('exit', kill);
  });
  const call = <T>(operation: string, args: Record<string, string | number> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        fail('Correction E2E native fixture timed out');
        kill();
      }, operationTimeoutMs);
      calls.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      child.send({ id, operation, args }, (error) => {
        if (error) {
          fail('Correction E2E native fixture disconnected');
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
    account: (userId: string) => call<HolderAccount>('account', { userId }),
    damage: (accountId: number, delta: bigint) =>
      call<void>('damage', { accountId, delta: String(delta) }),
    ledger: (userId: string) => call<unknown[]>('ledger', { userId }),
    treasury: async () => BigInt(await call<string>('treasury')),
    fund: (amount: bigint) => call<void>('fund', { amount: String(amount) }),
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
