/**
 * The cut on an upload's body (`BodyCut`, image-body.ts) at the owner's own times, on fake timers:
 * 30 seconds without a byte (owner decision 2026-10-21 answer 4) and 2 minutes for the whole body
 * however it trickles (owner decision 2026-10-22 (2차) answer 1). No server; the answer the API
 * gives a cut body (408, its share back, its connection closed) is media.controller.test.ts's, on
 * real sockets with the times shortened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BodyCut,
  type BodyCutReason,
  IMAGE_UPLOAD_DEADLINE_SECONDS,
  IMAGE_UPLOAD_IDLE_SECONDS,
  imageUploadDeadline,
  imageUploadIdle,
} from './image-body.js';

const SECOND = 1000;

describe('BodyCut', () => {
  let cuts: { reason: BodyCutReason; at: number }[];
  let started: number;

  /** A body under the owner's limits, its bytes read away as the parser would read them. */
  function body(): BodyCut {
    started = Date.now();
    const made = new BodyCut(
      { idleMs: imageUploadIdle.ms, deadlineMs: imageUploadDeadline.ms },
      (cut, reason) => {
        cuts.push({ reason, at: Date.now() - started });
        cut.destroy(new Error(reason));
      },
    );
    made.on('error', () => undefined);
    made.resume();
    return made;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    cuts = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs on the owner’s 30 seconds without a byte and 2 minutes for the whole body', () => {
    expect(imageUploadIdle.ms).toBe(IMAGE_UPLOAD_IDLE_SECONDS * SECOND);
    expect(IMAGE_UPLOAD_IDLE_SECONDS).toBe(30);
    expect(imageUploadDeadline.ms).toBe(IMAGE_UPLOAD_DEADLINE_SECONDS * SECOND);
    expect(IMAGE_UPLOAD_DEADLINE_SECONDS).toBe(120);
  });

  it('cuts a body trickling a byte every 29 seconds — never idle for 30 — at 2 minutes', async () => {
    const trickle = body();
    // Bytes at 29, 58, 87 and 116 seconds: none of the gaps reaches the idle time.
    for (let at = 29; at < 120; at += 29) {
      await vi.advanceTimersByTimeAsync(29 * SECOND);
      expect(cuts).toEqual([]);
      trickle.write(Buffer.from('x'));
    }
    await vi.advanceTimersByTimeAsync(120 * SECOND - 116 * SECOND - 1);
    expect(cuts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cuts).toEqual([{ reason: 'deadline', at: 120 * SECOND }]);
    expect(trickle.destroyed).toBe(true);
    // Cut once: nothing more comes of it.
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    expect(cuts).toHaveLength(1);
  });

  it('does not cut a body all in before its deadline, however slowly it came', async () => {
    const slow = body();
    // A piece every 10 seconds from 0 to 110, and the end at 119.
    for (let at = 0; at <= 110; at += 10) {
      if (at > 0) await vi.advanceTimersByTimeAsync(10 * SECOND);
      slow.write(Buffer.alloc(64 * 1024));
    }
    await vi.advanceTimersByTimeAsync(9 * SECOND);
    expect(Date.now() - started).toBe(119 * SECOND);
    slow.end();
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    expect(cuts).toEqual([]);
    expect(slow.receivedEncodedLength).toBe(12 * 64 * 1024);
  });

  it('does not cut a body that comes at once', async () => {
    const quick = body();
    quick.end(Buffer.alloc(5 * 1024 * 1024));
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    expect(cuts).toEqual([]);
    expect(quick.receivedEncodedLength).toBe(5 * 1024 * 1024);
  });

  it('still cuts a body that stops for 30 seconds before its deadline, and one that never starts', async () => {
    const stalled = body();
    await vi.advanceTimersByTimeAsync(20 * SECOND);
    stalled.write(Buffer.from('x'));
    await vi.advanceTimersByTimeAsync(30 * SECOND - 1);
    expect(cuts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cuts).toEqual([{ reason: 'idle', at: 50 * SECOND }]);
    // Not cut again at its deadline.
    await vi.advanceTimersByTimeAsync(120 * SECOND);
    expect(cuts).toHaveLength(1);

    cuts = [];
    body();
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(cuts).toEqual([{ reason: 'idle', at: 30 * SECOND }]);
  });

  it('has no cut to come once it is stopped (the answer ended, or the client went)', async () => {
    const answered = body();
    answered.write(Buffer.from('x'));
    answered.stop();
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    expect(cuts).toEqual([]);
  });
});
