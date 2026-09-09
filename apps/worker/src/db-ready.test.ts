/**
 * The boot-time database wait, driven with an injected probe and clock — no database and no
 * docker `test` profile, like `health.test.ts` and `scan.test.ts`. What is pinned here is the
 * contract `main.ts` depends on: it never rejects, it never gives up, and a healthy boot pays
 * one round trip and says nothing.
 */
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { DB_READY_MAX_DELAY_MS, dbReadyDelayMs, waitForDb } from './db-ready.js';

/** Collects the warn lines, so "logs once per attempt" is checkable. */
function recording() {
  const lines: { msg?: string; attempt?: number; waitMs?: number }[] = [];
  const logger = pino(
    { level: 'warn' },
    { write: (line: string) => lines.push(JSON.parse(line) as { msg?: string }) },
  );
  return { logger, lines };
}

/** Records what the wait would have slept for, and returns immediately. */
function fakeSleep() {
  const slept: number[] = [];
  return {
    slept,
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

describe('waitForDb', () => {
  it('costs one round trip and one log line of nothing when the database is up', async () => {
    const { logger, lines } = recording();
    const { slept, sleep } = fakeSleep();

    await expect(waitForDb(() => Promise.resolve([{ ok: 1 }]), { logger, sleep })).resolves.toEqual(
      { attempts: 1 },
    );

    expect(lines).toEqual([]);
    expect(slept).toEqual([]);
  });

  it('keeps trying until the database answers, and never rejects', async () => {
    // The property that matters: a worker booted before Postgres must PARK at 503, not die.
    // A ceiling that threw would restore the crash this shape exists to avoid; a ceiling that
    // gave up and reported ready would restore the lie it exists to fix.
    const { logger, lines } = recording();
    const { slept, sleep } = fakeSleep();
    let calls = 0;
    const probe = () => {
      calls += 1;
      if (calls < 3) return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
      return Promise.resolve([{ ok: 1 }]);
    };

    await expect(waitForDb(probe, { logger, sleep })).resolves.toEqual({ attempts: 3 });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      msg: 'database not ready, retrying',
      attempt: 1,
      waitMs: 500,
    });
    expect(lines[1]).toMatchObject({ attempt: 2, waitMs: 1_000 });
    expect(slept).toEqual([500, 1_000]);
  });

  it('retries a rejection that is not an Error, rather than throwing it', async () => {
    // A driver or a library may reject with anything; `runScan` guards the same shape.
    const { logger, lines } = recording();
    const { sleep } = fakeSleep();
    let calls = 0;

    await expect(
      waitForDb(
        () => {
          calls += 1;
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return calls === 1 ? Promise.reject('nope') : Promise.resolve(null);
        },
        { logger, sleep },
      ),
    ).resolves.toEqual({ attempts: 2 });
    expect(lines).toHaveLength(1);
  });

  it('grows the wait and caps it at the pool’s own connect timeout', () => {
    // The cap is `createDb`'s `connectionTimeoutMillis`, so a sleep never outlasts the failure
    // it is waiting on.
    expect(dbReadyDelayMs(1)).toBe(500);
    expect(dbReadyDelayMs(4)).toBe(2_000);
    expect(dbReadyDelayMs(10)).toBe(DB_READY_MAX_DELAY_MS);
    expect(dbReadyDelayMs(100)).toBe(DB_READY_MAX_DELAY_MS);
  });
});
