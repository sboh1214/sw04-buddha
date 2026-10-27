/**
 * The memory admission (owner decision 2026-10-22 answer 3, ADR-0073 9-46) with a stubbed reader
 * of the resident memory: what it lets in at once, what waits and for how long, and the ceiling
 * the API runs with. No database; the routes that ask it are media.controller.test.ts's.
 */
import { Logger, type LoggerService } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type Env, envSchema } from '../config/env.js';
import { NestPinoLogger } from '../logger.js';
import { IMAGE_READ_BUDGET_BYTES, imageReads } from './image-reads.js';
import {
  MEMORY_CEILING_MARGIN_BYTES,
  MEMORY_POLL_MS,
  MemoryAdmission,
  type MemoryRefusal,
  REFUSAL_LOG_INTERVAL_MS,
  RefusalLog,
  memoryAdmission,
  memoryCeilingBytes,
  memoryWaits,
  nestAdmissionLogger,
  processMemoryLimit,
  startMemoryAdmission,
} from './memory-admission.js';

const MiB = 1024 * 1024;

describe('MemoryAdmission', () => {
  let resident: number;
  let readRoom: number;
  let admission: MemoryAdmission;
  let refusals: MemoryRefusal[];

  beforeEach(() => {
    vi.useFakeTimers();
    resident = 200 * MiB;
    // The reads' budget all taken: no room kept for reads unless a spec says so.
    readRoom = 0;
    refusals = [];
    admission = new MemoryAdmission(() => readRoom);
    admission.configure({
      ceilingBytes: 416 * MiB,
      resident: () => resident,
      onRefused: (refusal) => refusals.push(refusal),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets in what fits under the ceiling with the RSS and every share out, and nothing past it', () => {
    // 200 resident + 144 + 72 = 416: to the byte.
    const conversion = admission.tryTake(144 * MiB, 'conversion');
    expect(conversion).not.toBeNull();
    expect(admission.heldBytes).toBe(144 * MiB);
    const body = admission.tryTake(72 * MiB, 'body');
    expect(body).not.toBeNull();
    expect(admission.tryTake(1, 'body')).toBeNull();
    // An upload body or a conversion counts the shares out in full, whatever of them the RSS
    // already shows.
    conversion?.();
    expect(admission.heldBytes).toBe(72 * MiB);
    expect(admission.tryTake(144 * MiB, 'conversion')).not.toBeNull();
    // A share given back twice comes back once.
    body?.();
    body?.();
    expect(admission.heldBytes).toBe(144 * MiB);
  });

  it('holds nothing and still refuses what the RSS alone leaves no room for', () => {
    resident = 300 * MiB;
    expect(admission.tryTake(144 * MiB, 'conversion')).toBeNull();
    expect(admission.tryTake(116 * MiB, 'body')).not.toBeNull();
  });

  it('lets everything in without a ceiling', async () => {
    admission.configure({ ceilingBytes: null, resident: () => 10_000 * MiB });
    expect(admission.tryTake(1_000 * MiB, 'conversion')).not.toBeNull();
    expect(await admission.admit(1_000 * MiB, { kind: 'body', waitMs: 0 })).not.toBeNull();
    expect(admission.ceilingBytes).toBeNull();
  });

  it('lets an image read in beside a running conversion, whose share it does not count; an upload body still waits for it', () => {
    // At idle, with the reads' budget all free: the conversion keeps the reads' 32MiB beside its
    // own 144 (150 + 144 + 32 = 326).
    resident = 150 * MiB;
    readRoom = 32 * MiB;
    const conversion = admission.tryTake(144 * MiB, 'conversion');
    expect(conversion).not.toBeNull();
    // The conversion near its peak: the RSS between the ceiling less the conversion's share (272)
    // and the ceiling less the reads' room (384). Counting the conversion's share again would
    // refuse every read now (350 + 144 + 4 > 416); beside the RSS it fits.
    resident = 350 * MiB;
    const read = admission.tryTake(4 * MiB, 'read');
    expect(read).not.toBeNull();
    // Up to the ceiling with the reads' shares out: 350 + 4 + 62 = 416.
    expect(admission.tryTake(62 * MiB, 'read')).not.toBeNull();
    expect(admission.tryTake(1, 'read')).toBeNull();
    // An upload body counts the conversion's share, and keeps the reads' room: it waits.
    readRoom = 0;
    expect(admission.tryTake(4 * MiB, 'body')).toBeNull();
    conversion?.();
    resident = 150 * MiB;
    expect(admission.tryTake(4 * MiB, 'body')).not.toBeNull();
    read?.();
  });

  it('keeps room for the image reads in an upload body’s or a conversion’s count: what of the reads’ budget is free and the reads waiting', async () => {
    // 240 + 144 + 32 = 416: to the byte.
    resident = 240 * MiB;
    readRoom = 32 * MiB;
    const conversion = admission.tryTake(144 * MiB, 'conversion');
    expect(conversion).not.toBeNull();
    conversion?.();
    readRoom = 32 * MiB + 1;
    expect(admission.tryTake(144 * MiB, 'conversion')).toBeNull();
    expect(admission.tryTake(144 * MiB, 'body')).toBeNull();
    readRoom = 32 * MiB;
    expect(admission.tryTake(144 * MiB, 'body')).not.toBeNull();
    // A read waiting has its bytes out of the budget's room (it took them there) and not yet in a
    // share: an upload body or a conversion keeps room for it as well.
    resident = 416 * MiB;
    readRoom = 0;
    const admission2 = new MemoryAdmission(() => readRoom);
    admission2.configure({ ceilingBytes: 416 * MiB, resident: () => resident });
    void admission2.admit(32 * MiB, { kind: 'read', waitMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(admission2.waitingCount).toBe(1);
    // Before the next look lets the read in: 380 + 4 + the read's 32 = 416.
    resident = 380 * MiB;
    expect(admission2.tryTake(5 * MiB, 'body')).toBeNull();
    const body = admission2.tryTake(4 * MiB, 'body');
    expect(body).not.toBeNull();
    body?.();
    await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS);
    expect(admission2.waitingCount).toBe(0);
    expect(admission2.heldBytes).toBe(32 * MiB);
  });

  it('waits for the RSS to fall, looking again every MEMORY_POLL_MS', async () => {
    resident = 400 * MiB;
    let admitted: (() => void) | null | undefined;
    void admission.admit(144 * MiB, { kind: 'conversion', waitMs: 10_000 }).then((release) => {
      admitted = release;
    });
    await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS * 3);
    expect(admitted).toBeUndefined();
    expect(admission.waitingCount).toBe(1);
    resident = 200 * MiB;
    await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS);
    expect(admitted).toBeTypeOf('function');
    expect(admission.waitingCount).toBe(0);
    expect(admission.heldBytes).toBe(144 * MiB);
    expect(refusals).toEqual([]);
  });

  it('reads the RSS once a look, however many requests wait', async () => {
    let reads = 0;
    admission.configure({
      ceilingBytes: 416 * MiB,
      resident: () => {
        reads += 1;
        return resident;
      },
    });
    const conversion = admission.tryTake(144 * MiB, 'conversion');
    // No room for one more upload body, with the conversion's share or without it.
    resident = 414 * MiB;
    for (let i = 0; i < 20; i += 1) {
      void admission.admit(4 * MiB, { kind: 'body', waitMs: 10_000 });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(admission.waitingCount).toBe(20);
    reads = 0;
    await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS);
    expect(reads).toBe(1);
    // A release looks once too.
    reads = 0;
    conversion?.();
    expect(reads).toBe(1);
    expect(admission.waitingCount).toBe(20);
    // Room for all of them: let in in one look, each counted as it comes in.
    resident = 200 * MiB;
    reads = 0;
    await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS);
    expect(reads).toBe(1);
    expect(admission.waitingCount).toBe(0);
    expect(admission.heldBytes).toBe(80 * MiB);
  });

  it('lets a waiting request in as soon as a share comes back', async () => {
    const conversion = admission.tryTake(200 * MiB, 'conversion');
    const waiting = admission.admit(100 * MiB, { kind: 'body', waitMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(admission.waitingCount).toBe(1);
    // At the release itself, not at the next look.
    conversion?.();
    expect(await waiting).toBeTypeOf('function');
    expect(admission.heldBytes).toBe(100 * MiB);
  });

  it('gives up after its wait: null, nothing held, and the refusal told', async () => {
    resident = 416 * MiB;
    const waiting = admission.admit(4 * MiB, { kind: 'read', waitMs: 2_000 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(admission.waitingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toBeNull();
    expect(admission.waitingCount).toBe(0);
    expect(admission.heldBytes).toBe(0);
    expect(refusals).toEqual([
      {
        kind: 'read',
        residentBytes: 416 * MiB,
        heldBytes: 0,
        neededBytes: 4 * MiB,
        ceilingBytes: 416 * MiB,
      },
    ]);
  });

  it('lets a request go when its client goes while it waits, and takes none already gone', async () => {
    resident = 416 * MiB;
    const gone = new AbortController();
    const waiting = admission.admit(4 * MiB, {
      kind: 'body',
      waitMs: 10_000,
      signal: gone.signal,
    });
    await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS);
    gone.abort();
    expect(await waiting).toBeNull();
    expect(admission.waitingCount).toBe(0);
    // A client gone before it asked: nothing, even with room.
    resident = 0;
    expect(
      await admission.admit(4 * MiB, { kind: 'body', waitMs: 10_000, signal: gone.signal }),
    ).toBeNull();
    expect(admission.heldBytes).toBe(0);
    // Not a refusal for memory: nothing told.
    expect(refusals).toEqual([]);
  });

  it('does not hold a small request behind a large one that does not fit yet', async () => {
    resident = 300 * MiB;
    let conversion: (() => void) | null | undefined;
    void admission.admit(144 * MiB, { kind: 'conversion', waitMs: 10_000 }).then((release) => {
      conversion = release;
    });
    // A read of an image fits beside what is resident: in at once, though the conversion waits.
    const read = await admission.admit(2 * MiB, { kind: 'read', waitMs: 10_000 });
    expect(read).toBeTypeOf('function');
    expect(conversion).toBeUndefined();
    // Once the RSS has room for both, the conversion comes in too, at the next look.
    resident = 200 * MiB;
    await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS);
    expect(conversion).toBeTypeOf('function');
  });

  it('takes the requests waiting in the order they came when room comes for all', async () => {
    resident = 416 * MiB;
    const order: string[] = [];
    const first = admission
      .admit(100 * MiB, { kind: 'body', waitMs: 10_000 })
      .then(() => order.push('first'));
    const second = admission
      .admit(100 * MiB, { kind: 'body', waitMs: 10_000 })
      .then(() => order.push('second'));
    await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS);
    resident = 100 * MiB;
    await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS);
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    expect(admission.heldBytes).toBe(200 * MiB);
  });
});

describe('the API’s admission', () => {
  it('keeps for the image reads what of their budget is not taken', () => {
    // As the process runs it: a ceiling right at the RSS, a conversion's share and the reads'
    // budget, all free (32MiB), above it.
    const rss = process.memoryUsage.rss();
    memoryAdmission.configure({ ceilingBytes: rss + 176 * MiB, resident: () => rss });
    try {
      expect(imageReads.size).toBe(0);
      const conversion = memoryAdmission.tryTake(144 * MiB, 'conversion');
      expect(conversion).not.toBeNull();
      conversion?.();
      expect(memoryAdmission.tryTake(144 * MiB + 1, 'conversion')).toBeNull();
      // A read holding 1 byte of the budget gives a conversion that byte more: its bytes are a
      // share, or in the RSS, already.
      const reading = imageReads.take(1);
      expect(memoryAdmission.tryTake(144 * MiB + 1, 'conversion')).not.toBeNull();
      reading?.();
    } finally {
      memoryAdmission.configure({ ceilingBytes: null });
    }
    expect(IMAGE_READ_BUDGET_BYTES).toBe(32 * MiB);
  });
});

describe('the admission’s log', () => {
  const refusal = (resident: number): MemoryRefusal => ({
    kind: 'conversion',
    residentBytes: resident * MiB,
    heldBytes: 4 * MiB,
    neededBytes: 144 * MiB,
    ceilingBytes: 416 * MiB,
  });
  const line = (refused: number, resident: number) => [
    {
      refused,
      kind: 'conversion',
      residentMiB: resident,
      heldMiB: 4,
      neededMiB: 144,
      ceilingMiB: 416,
    },
    'image work refused: no room under the memory ceiling in time',
  ];

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the first refusal at once, then the count since the line before at the end of the minute — without waiting for a later refusal', async () => {
    const warn = vi.fn();
    const log = new RefusalLog({ warn });
    log.refused(refusal(300));
    expect(warn.mock.calls).toEqual([line(1, 300)]);
    // A burst within the minute — at 1, 10 and 30 seconds — then nothing.
    await vi.advanceTimersByTimeAsync(1_000);
    log.refused(refusal(301));
    await vi.advanceTimersByTimeAsync(9_000);
    log.refused(refusal(302));
    await vi.advanceTimersByTimeAsync(20_000);
    log.refused(refusal(303));
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFUSAL_LOG_INTERVAL_MS - 30_000 - 1);
    expect(warn).toHaveBeenCalledTimes(1);
    // At the end of the minute: the three, with the latest's figures.
    await vi.advanceTimersByTimeAsync(1);
    expect(warn.mock.calls).toEqual([line(1, 300), line(3, 303)]);
    // Nothing more while nothing is refused.
    await vi.advanceTimersByTimeAsync(10 * REFUSAL_LOG_INTERVAL_MS);
    expect(warn).toHaveBeenCalledTimes(2);
    // A refusal a minute or more after the line before: at once.
    log.refused(refusal(304));
    expect(warn.mock.calls.at(-1)).toEqual(line(1, 304));
  });

  it('writes what is pending when it closes, and nothing after', async () => {
    const warn = vi.fn();
    const log = new RefusalLog({ warn });
    log.refused(refusal(300));
    await vi.advanceTimersByTimeAsync(5_000);
    log.refused(refusal(310));
    log.close();
    expect(warn.mock.calls).toEqual([line(1, 300), line(1, 310)]);
    await vi.advanceTimersByTimeAsync(2 * REFUSAL_LOG_INTERVAL_MS);
    expect(warn).toHaveBeenCalledTimes(2);
    // Nothing pending: nothing written.
    log.close();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('the admission as the API starts it (MediaModule)', () => {
  const logger = () => ({ log: vi.fn(), warn: vi.fn() });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the process’s memory limit less 32MiB — 416MiB in the api container — or API_MEMORY_CEILING_MIB, and says so', () => {
    const admission = new MemoryAdmission();
    const container = logger();
    startMemoryAdmission(admission, { configured: '', limitBytes: 448 * MiB, logger: container });
    expect(admission.ceilingBytes).toBe(416 * MiB);
    expect(container.log).toHaveBeenCalledWith(
      expect.objectContaining({ ceilingMiB: 416, limitMiB: 448 }),
      'image work memory: ceiling set',
    );
    startMemoryAdmission(admission, { configured: 380, limitBytes: 448 * MiB, logger: logger() });
    expect(admission.ceilingBytes).toBe(380 * MiB);
    const none = logger();
    startMemoryAdmission(admission, { configured: undefined, limitBytes: 0, logger: none });
    expect(admission.ceilingBytes).toBeNull();
    expect(none.log).toHaveBeenCalledWith(
      expect.objectContaining({ ceilingMiB: null, limitMiB: null }),
      'image work memory: no ceiling (no memory limit known)',
    );
  });

  it('writes each line on the API’s logger as one message, its words then its figures, in its own context', () => {
    // As main.ts has it: Nest's Logger on top of the API's pino (NestPinoLogger, logger.ts).
    const lines: Record<string, unknown>[] = [];
    const destination = {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    };
    const previous: unknown = Reflect.get(Logger, 'staticInstanceRef');
    Logger.overrideLogger(new NestPinoLogger(pino({ level: 'info' }, destination)));
    try {
      const refusals = startMemoryAdmission(new MemoryAdmission(), {
        configured: undefined,
        limitBytes: 448 * MiB,
        logger: nestAdmissionLogger(new Logger('MemoryAdmission')),
      });
      refusals.refused({
        kind: 'read',
        residentBytes: 400 * MiB,
        heldBytes: 0,
        neededBytes: MiB,
        ceilingBytes: 416 * MiB,
      });
    } finally {
      Logger.overrideLogger(previous as LoggerService);
    }
    // Not the figures as the message and the words as a `stack` (pino's figures-first call on
    // Nest's Logger).
    expect(lines.map(({ level, context, msg, stack }) => ({ level, context, msg, stack }))).toEqual(
      [
        {
          level: 30,
          context: 'MemoryAdmission',
          msg: expect.stringMatching(
            /^image work memory: ceiling set \{"ceilingMiB":416,"limitMiB":448,"residentMiB":\d+\}$/,
          ) as unknown,
          stack: undefined,
        },
        {
          level: 40,
          context: 'MemoryAdmission',
          msg:
            'image work refused: no room under the memory ceiling in time ' +
            '{"refused":1,"kind":"read","residentMiB":400,"heldMiB":0,"neededMiB":1,"ceilingMiB":416}',
          stack: undefined,
        },
      ],
    );
  });

  it('tells its log of a request refused after its wait: a warning, at most one a minute', async () => {
    vi.useFakeTimers();
    const admission = new MemoryAdmission();
    const container = logger();
    const refusals = startMemoryAdmission(admission, {
      configured: undefined,
      limitBytes: 448 * MiB,
      logger: container,
    });
    // More than the ceiling holds: never fits.
    const first = admission.admit(1024 * MiB, { kind: 'conversion', waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toBeNull();
    expect(container.warn).toHaveBeenCalledTimes(1);
    expect(container.warn).toHaveBeenCalledWith(
      expect.objectContaining({ refused: 1, kind: 'conversion', neededMiB: 1024, ceilingMiB: 416 }),
      'image work refused: no room under the memory ceiling in time',
    );
    const second = admission.admit(1024 * MiB, { kind: 'read', waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await second).toBeNull();
    expect(container.warn).toHaveBeenCalledTimes(1);
    refusals.close();
    expect(container.warn).toHaveBeenCalledTimes(2);
    expect(container.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ refused: 1, kind: 'read' }),
      'image work refused: no room under the memory ceiling in time',
    );
  });
});

describe('the ceiling the API runs with', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is API_MEMORY_CEILING_MIB when set, whatever the limit', () => {
    expect(memoryCeilingBytes(380, 448 * MiB)).toBe(380 * MiB);
    expect(memoryCeilingBytes(380, 0)).toBe(380 * MiB);
  });

  it('is the process’s memory limit less 32MiB otherwise — 416MiB in the api container — and none without a limit', () => {
    expect(MEMORY_CEILING_MARGIN_BYTES).toBe(32 * MiB);
    expect(memoryCeilingBytes(undefined, 448 * MiB)).toBe(416 * MiB);
    expect(memoryCeilingBytes(undefined, 0)).toBeNull();
  });

  it('reads API_MEMORY_CEILING_MIB left empty, as ConfigService gives it, as no setting — not a ceiling of 0', async () => {
    const before = process.env.API_MEMORY_CEILING_MIB;
    // As a .env copied from .env.example has it.
    process.env.API_MEMORY_CEILING_MIB = '';
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            validationSchema: z.object({
              API_MEMORY_CEILING_MIB: envSchema.shape.API_MEMORY_CEILING_MIB,
            }),
          }),
        ],
      }).compile();
      const configured: unknown = moduleRef
        .get<ConfigService<Env, true>>(ConfigService)
        .get('API_MEMORY_CEILING_MIB', { infer: true });
      await moduleRef.close();
      // The schema reads it as undefined, and @nestjs/config falls back to the raw value.
      expect(configured).toBe('');
      expect(memoryCeilingBytes(configured, 448 * MiB)).toBe(416 * MiB);
      expect(memoryCeilingBytes(configured, 0)).toBeNull();
      expect(memoryCeilingBytes(' ', 448 * MiB)).toBe(416 * MiB);
    } finally {
      if (before === undefined) delete process.env.API_MEMORY_CEILING_MIB;
      else process.env.API_MEMORY_CEILING_MIB = before;
    }
  });

  it('reads the limit from the cgroup through libuv: none when unlimited or unknown', () => {
    const spy = vi.spyOn(process, 'constrainedMemory');
    spy.mockReturnValue(448 * MiB);
    expect(processMemoryLimit()).toBe(448 * MiB);
    // Linux without a limit reads 2^64; an unknown limit reads 0.
    spy.mockReturnValue(2 ** 64);
    expect(processMemoryLimit()).toBe(0);
    spy.mockReturnValue(0);
    expect(processMemoryLimit()).toBe(0);
  });

  it('waits 10 seconds for an upload or a conversion and 2 for an image read', () => {
    expect(memoryWaits).toEqual({ uploadMs: 10_000, conversionMs: 10_000, readMs: 2_000 });
  });
});
