import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestPacer } from './request-pacer';

/**
 * MY's sellable queue (#67, ADR-0142 결정 2-15): never more than `maxInFlight` on their way, never
 * more than `perWindow` started in any window, in the order asked, and an aborted wait unsent.
 */

/** A request that answers when told to. */
function pending() {
  let answer: (value: string) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const promise = new Promise<string>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  return { promise, answer, fail };
}

describe('RequestPacer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps at most maxInFlight on their way, starting the next as one answers', async () => {
    const pacer = new RequestPacer({ maxInFlight: 2, perWindow: 100, windowMs: 60_000 });
    const requests = [pending(), pending(), pending()];
    const started: number[] = [];
    const results = requests.map((request, i) =>
      pacer.run(() => {
        started.push(i);
        return request.promise;
      }),
    );
    expect(started).toEqual([0, 1]);
    expect(pacer.running).toBe(2);
    expect(pacer.waiting).toBe(1);
    requests[0]?.answer('a');
    await expect(results[0]).resolves.toBe('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1, 2]);
    // A failure frees its place too, and reaches its caller.
    requests[1]?.fail(new Error('down'));
    await expect(results[1]).rejects.toThrow('down');
    requests[2]?.answer('c');
    await expect(results[2]).resolves.toBe('c');
    await vi.advanceTimersByTimeAsync(0);
    expect(pacer.running).toBe(0);
  });

  it('starts at most perWindow in any window, the rest when the oldest leaves it', async () => {
    const pacer = new RequestPacer({ maxInFlight: 10, perWindow: 20, windowMs: 60_000 });
    const started: number[] = [];
    // 50 held markets on a cold /my/positions, each answering at once.
    const results = Array.from({ length: 50 }, (_, i) =>
      pacer.run(() => {
        started.push(Date.now());
        return Promise.resolve(i);
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(20);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(started).toHaveLength(20);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toHaveLength(40);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toHaveLength(50);
    await expect(Promise.all(results)).resolves.toHaveLength(50);
    // No 60-second window holds more than 20 starts, and they went in the order asked.
    for (const at of started) {
      expect(started.filter((t) => t >= at && t < at + 60_000).length).toBeLessThanOrEqual(20);
    }
  });

  it('drops a waiting request whose signal aborts, unsent, and keeps the order of the rest', async () => {
    const pacer = new RequestPacer({ maxInFlight: 1, perWindow: 100, windowMs: 60_000 });
    const first = pending();
    const started: string[] = [];
    const run = (name: string, signal?: AbortSignal) =>
      pacer.run(() => {
        started.push(name);
        return name === 'a' ? first.promise : Promise.resolve(name);
      }, signal);
    const a = run('a');
    const cancel = new AbortController();
    const b = run('b', cancel.signal);
    const c = run('c');
    cancel.abort(new Error('cancelled'));
    await expect(b).rejects.toThrow('cancelled');
    expect(pacer.waiting).toBe(1);
    first.answer('a');
    await expect(a).resolves.toBe('a');
    await expect(c).resolves.toBe('c');
    expect(started).toEqual(['a', 'c']);
    // Aborted before it was asked: never queued.
    const gone = new AbortController();
    gone.abort(new Error('gone'));
    await expect(run('d', gone.signal)).rejects.toThrow('gone');
    expect(started).toEqual(['a', 'c']);
  });

  it('an abort after the start changes nothing: the request is already sent', async () => {
    const pacer = new RequestPacer({ maxInFlight: 1, perWindow: 100, windowMs: 60_000 });
    const request = pending();
    const cancel = new AbortController();
    const result = pacer.run(() => request.promise, cancel.signal);
    cancel.abort(new Error('late'));
    expect(pacer.running).toBe(1);
    request.answer('kept');
    await expect(result).resolves.toBe('kept');
  });
});
