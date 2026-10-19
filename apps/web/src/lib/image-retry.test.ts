import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE_RETRY_ATTEMPTS,
  IMAGE_RETRY_DEFAULT_WAIT_MS,
  IMAGE_RETRY_MAX_WAIT_MS,
  type ImageRecoveryDeps,
  recoverImage,
  retryAfterMs,
  sleep,
} from './image-retry';

/**
 * An image drawn again after a 429 (#46, ADR-0073 decision 9-39): the answers it reads, the waits it
 * takes from `Retry-After`, and the bound on how often it asks.
 */

const SRC = '/api/v1/media/3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const busy = (retryAfter?: string) =>
  new Response('{"error":{"code":"RATE_LIMITED"}}', {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  });
const image = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });

/** `fetch` answering in turn, and the waits asked for. */
function deps(...answers: Response[]): ImageRecoveryDeps & { waits: number[]; asked: number } {
  const waits: number[] = [];
  const state = {
    waits,
    asked: 0,
    signal: new AbortController().signal,
    fetch: (url: string) => {
      expect(url).toBe(SRC);
      state.asked += 1;
      const answer = answers.shift();
      return answer ? Promise.resolve(answer) : Promise.reject(new Error('asked once too often'));
    },
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
  return state;
}

describe('retryAfterMs', () => {
  it('reads seconds or a date, bounded, and falls back to the read’s own second', () => {
    expect(retryAfterMs('1')).toBe(1_000);
    expect(retryAfterMs(' 7 ')).toBe(7_000);
    expect(retryAfterMs('0')).toBe(0);
    expect(retryAfterMs('3600')).toBe(IMAGE_RETRY_MAX_WAIT_MS);
    const now = Date.parse('2026-10-20T00:00:00Z');
    expect(retryAfterMs('Tue, 20 Oct 2026 00:00:05 GMT', now)).toBe(5_000);
    expect(retryAfterMs('Mon, 19 Oct 2026 00:00:05 GMT', now)).toBe(0);
    expect(retryAfterMs(null)).toBe(IMAGE_RETRY_DEFAULT_WAIT_MS);
    expect(retryAfterMs('')).toBe(IMAGE_RETRY_DEFAULT_WAIT_MS);
    expect(retryAfterMs('soon')).toBe(IMAGE_RETRY_DEFAULT_WAIT_MS);
    expect(retryAfterMs('-3')).toBe(IMAGE_RETRY_DEFAULT_WAIT_MS);
  });
});

describe('recoverImage', () => {
  it('waits out each 429 as its Retry-After says, and is done once the image comes', async () => {
    const d = deps(busy('1'), busy('2'), image());
    const budget = { left: IMAGE_RETRY_ATTEMPTS };
    await expect(recoverImage(SRC, budget, d)).resolves.toBe(true);
    expect(d.waits).toEqual([1_000, 2_000]);
    expect(d.asked).toBe(3);
    expect(budget.left).toBe(0);
  });

  it('asks at most as often as the budget allows, across its recoveries, and waits for no answer it will not ask for', async () => {
    const d = deps(busy('1'), busy('1'), busy('1'));
    const budget = { left: IMAGE_RETRY_ATTEMPTS };
    await expect(recoverImage(SRC, budget, d)).resolves.toBe(false);
    expect(d.asked).toBe(IMAGE_RETRY_ATTEMPTS);
    expect(d.waits).toEqual([1_000, 1_000]);
    // Spent: a later failure of the same image asks nothing.
    await expect(recoverImage(SRC, budget, d)).resolves.toBe(false);
    expect(d.asked).toBe(IMAGE_RETRY_ATTEMPTS);
  });

  it('leaves an image that is not there (or any other failure) broken, at once', async () => {
    const gone = deps(new Response(null, { status: 404 }));
    await expect(recoverImage(SRC, { left: 3 }, gone)).resolves.toBe(false);
    expect(gone.waits).toEqual([]);
    const down = deps(new Response(null, { status: 500 }));
    await expect(recoverImage(SRC, { left: 3 }, down)).resolves.toBe(false);
    expect(down.asked).toBe(1);
  });

  it('reads the image whole, so the element drawing it again finds it in the cache', async () => {
    const answer = image();
    const read = vi.spyOn(answer, 'arrayBuffer');
    await expect(recoverImage(SRC, { left: 1 }, deps(answer))).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('is given up with its signal, waiting or asking', async () => {
    const gone = new AbortController();
    const waiting = sleep(60_000, gone.signal);
    gone.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(sleep(1, gone.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(sleep(1, new AbortController().signal)).resolves.toBeUndefined();
  });
});
