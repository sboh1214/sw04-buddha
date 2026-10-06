/**
 * Unit test of the scan loop shared by market.close and market.finalize. No database: what
 * matters here is the contract the scans lean on — a rejection is recorded, not thrown, and
 * the loop reaches every candidate after it. (A close cannot be poisoned on the test
 * database — nothing a `closeMarket` transaction reads can be broken from the app role — so
 * the close scan's catch is covered here; the finalize scan has its own integration case.)
 * `messageOf`, the message a failure carries (and the step's `last_error`), is checked here too.
 */
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { messageOf, runScan } from './scan.js';

describe('runScan', () => {
  it('records a rejection and keeps going, in candidate order', async () => {
    const seen: string[] = [];
    const boom = new Error('Balance not found for account x');
    const outcome = await runScan(['a', 'b', 'c'], (id) => {
      seen.push(id);
      return id === 'a' ? Promise.reject(boom) : Promise.resolve({ id, outcome: 'closed' });
    });

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(outcome).toEqual({
      results: [
        { id: 'b', outcome: 'closed' },
        { id: 'c', outcome: 'closed' },
      ],
      failed: 1,
      failures: [{ marketId: 'a', message: 'Balance not found for account x', err: boom }],
    });
  });

  it('runs the candidates one at a time', async () => {
    let active = 0;
    let peak = 0;
    await runScan(['a', 'b', 'c'], async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(peak).toBe(1);
  });

  it('stringifies a non-Error rejection for the result and keeps the value for the log', async () => {
    const outcome = await runScan(['a'], () => Promise.reject(new Error('plain')));
    expect(outcome.failures[0]).toMatchObject({ marketId: 'a', message: 'plain' });
    // A driver or a library may reject with something that is not an Error; the message must
    // still be a string and the value must still reach the log.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error is the case under test
    const odd = await runScan(['a'], () => Promise.reject(42));
    expect(odd.failures).toEqual([{ marketId: 'a', message: '42', err: 42 }]);
  });

  it('is empty-safe: nothing due is nothing failed', async () => {
    await expect(runScan([], () => Promise.resolve(1))).resolves.toEqual({
      results: [],
      failed: 0,
      failures: [],
    });
  });
});

describe('messageOf', () => {
  it('leads with the SQLSTATE and driver message of a failed query; a plain Error is unchanged', () => {
    // node-postgres's DatabaseError as drizzle-orm 0.45 keeps it, in DrizzleQueryError's `cause`.
    const driver = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const failed = new DrizzleQueryError('update "positions" set "qty" = $1', [0], driver);
    expect(messageOf(failed)).toBe(
      '40P01 deadlock detected — Failed query: update "positions" set "qty" = $1\nparams: 0',
    );
    // Thrown as itself, the driver error's message is not repeated.
    expect(messageOf(driver)).toBe('40P01 deadlock detected');
    expect(messageOf(new Error('Balance not found for account x'))).toBe(
      'Balance not found for account x',
    );
    // A cause without a SQLSTATE adds nothing, and a cyclic chain still ends.
    expect(messageOf(new Error('outer', { cause: new Error('inner') }))).toBe('outer');
    const loop = new Error('loop');
    loop.cause = loop;
    expect(messageOf(loop)).toBe('loop');
    expect(messageOf(42)).toBe('42');
  });
});
