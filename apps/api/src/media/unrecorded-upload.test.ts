/**
 * The clean-up of an upload whose row could not be written (ADR-0073 9-45), on its own: the one
 * every upload that stores its object before its row calls (a post's image now, #141's profile
 * image when it is restacked). A stubbed database, the memory store and the API's real loggers
 * (Nest's `Logger` on `NestPinoLogger`). The route that calls it, with the test database, is
 * media.controller.test.ts's.
 */
import { Logger, type LoggerService } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { MemoryObjectStorage } from '@buddha/storage';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NestPinoLogger } from '../logger.js';
import { LAST_ERROR_MAX_LENGTH, reasonOf, removeUnrecordedUpload } from './unrecorded-upload.js';

const storageKey = 'post-images/0b6f7c1e-2f43-4a51-9d0e-6a7f1c2b3d4e.jpg';

describe('reasonOf', () => {
  it('is an error’s message, led by its cause’s when it has one', () => {
    expect(reasonOf(new Error('store unavailable'))).toBe('store unavailable');
    expect(
      reasonOf(new Error('Failed query: insert …', { cause: new Error('connection terminated') })),
    ).toBe('connection terminated — Failed query: insert …');
    // A cause that is no Error says nothing more; a thrown non-Error is its text.
    expect(reasonOf(new Error('refused', { cause: 'busy' }))).toBe('refused');
    expect(reasonOf('busy')).toBe('busy');
  });
});

describe('removeUnrecordedUpload', () => {
  /** The rows queued (`media_deletions`) and how many transactions queued them. */
  let queued: Record<string, unknown>[];
  let transactions: number;
  /** The queueing's failure, when a spec wants one. */
  let queueFailure: Error | undefined;
  /** The lines the API's logger wrote, as pino writes them. */
  let lines: Record<string, unknown>[];
  let previous: unknown;
  let storage: MemoryObjectStorage;

  /**
   * Only a transaction of its own may queue: the stub has no `insert` of its own, so a key queued
   * on the database outside a transaction — or in a transaction the caller hands it — fails.
   */
  const db = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      transactions += 1;
      return work({
        insert: (table: unknown) => ({
          values: (row: Record<string, unknown>) => {
            if (queueFailure) return Promise.reject(queueFailure);
            expect(table).toBe(schema.mediaDeletions);
            queued.push(row);
            return Promise.resolve();
          },
        }),
      });
    },
  } as unknown as Db;

  const deps = () => ({ db, storage, logger: new Logger('MediaService') });

  beforeEach(async () => {
    queued = [];
    transactions = 0;
    queueFailure = undefined;
    lines = [];
    storage = new MemoryObjectStorage();
    await storage.put(storageKey, new Uint8Array([1, 2, 3]), 'image/jpeg');
    // As main.ts has it: Nest's Logger on top of the API's pino (NestPinoLogger, logger.ts).
    previous = Reflect.get(Logger, 'staticInstanceRef');
    Logger.overrideLogger(
      new NestPinoLogger(
        pino(
          { level: 'info' },
          {
            write: (line: string) => {
              lines.push(JSON.parse(line) as Record<string, unknown>);
            },
          },
        ),
      ),
    );
  });

  afterEach(() => {
    Logger.overrideLogger(previous as LoggerService);
    vi.restoreAllMocks();
  });

  /** What each line said: its level, context and message, and whether it carried a stack. */
  const said = () =>
    lines.map(({ level, context, msg, stack }) => ({ level, context, msg, stack }));

  it('removes the object, and queues and logs nothing, when the store lets it go', async () => {
    await removeUnrecordedUpload(deps(), storageKey);
    expect(storage.objects.size).toBe(0);
    expect(transactions).toBe(0);
    expect(queued).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('queues the key in a transaction of its own, the refusal counted as the first, and warns with the key and the refusal when the store refuses', async () => {
    vi.spyOn(storage, 'delete').mockRejectedValueOnce(
      new Error('Service Unavailable', { cause: new Error('SlowDown') }),
    );
    await expect(removeUnrecordedUpload(deps(), storageKey)).resolves.toBeUndefined();
    expect(storage.objects.size).toBe(1);
    expect(transactions).toBe(1);
    // Due at once (the column's default `now()`): no `nextAttemptAt` of its own.
    expect(queued).toEqual([
      { storageKey, attempts: 1, lastError: 'SlowDown — Service Unavailable' },
    ]);
    // One message, words then the fields — not `{}` for the refusal, no `stack`.
    expect(said()).toEqual([
      {
        level: 40,
        context: 'MediaService',
        msg: `could not remove an unrecorded upload; queued its key ${JSON.stringify({
          storageKey,
          refusal: 'SlowDown — Service Unavailable',
        })}`,
        stack: undefined,
      },
    ]);
  });

  it('keeps 1,000 characters of a long refusal in the queue and the whole of it in the log', async () => {
    const refusal = 'x'.repeat(LAST_ERROR_MAX_LENGTH + 500);
    vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error(refusal));
    await removeUnrecordedUpload(deps(), storageKey);
    expect(LAST_ERROR_MAX_LENGTH).toBe(1_000);
    expect(queued).toEqual([{ storageKey, attempts: 1, lastError: 'x'.repeat(1_000) }]);
    expect(String(lines[0]?.msg)).toContain(refusal);
  });

  it('logs the key with both failures as an error, and still does not throw, when the key cannot be queued either', async () => {
    vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('store unavailable'));
    queueFailure = new Error('Failed query: insert into "media_deletions" …', {
      cause: new Error('connection terminated unexpectedly'),
    });
    await expect(removeUnrecordedUpload(deps(), storageKey)).resolves.toBeUndefined();
    expect(storage.objects.size).toBe(1);
    expect(transactions).toBe(1);
    expect(queued).toEqual([]);
    expect(said()).toEqual([
      {
        level: 50,
        context: 'MediaService',
        msg: `could not remove an unrecorded upload, nor queue its key ${JSON.stringify({
          storageKey,
          refusal: 'store unavailable',
          queueing:
            'connection terminated unexpectedly — Failed query: insert into "media_deletions" …',
        })}`,
        stack: undefined,
      },
    ]);
  });
});
