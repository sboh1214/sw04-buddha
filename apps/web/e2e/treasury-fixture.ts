import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { test as base } from './helpers';

/**
 * Treasury funds are global: a pending insufficient-funds correction must not overlap a mint.
 * Browser projects and Playwright workers share this local lock for the same test stack. A dead
 * worker's lock is recoverable; a live worker always releases it after its treasury cleanup finishes.
 */
export const test = base.extend<{ treasuryExclusive: void }>({
  treasuryExclusive: [
    async ({ baseURL }, provide) => {
      const stack = createHash('sha256')
        .update(baseURL ?? 'default')
        .digest('hex')
        .slice(0, 16);
      const file = path.join(tmpdir(), `buddha-e2e-treasury-${stack}.lock`);
      const token = `${process.pid}:${randomUUID()}`;
      const deadline = Date.now() + 540_000;
      for (;;) {
        try {
          const handle = await open(file, 'wx');
          try {
            await handle.writeFile(token);
          } finally {
            await handle.close();
          }
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const owner = await readFile(file, 'utf8').catch(() => '');
          const pid = Number(owner.split(':')[0]);
          if (Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (probe) {
              if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
                if ((await readFile(file, 'utf8').catch(() => '')) === owner)
                  await unlink(file).catch(() => undefined);
                continue;
              }
            }
          }
          if (Date.now() >= deadline)
            throw new Error('Timed out waiting for the treasury E2E lock', { cause: error });
          await pause(100);
        }
      }
      try {
        await provide();
      } finally {
        if ((await readFile(file, 'utf8').catch(() => '')) === token) await unlink(file);
      }
    },
    { auto: true, timeout: 600_000 },
  ],
});
