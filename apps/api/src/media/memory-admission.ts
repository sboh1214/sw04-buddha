import { totalmem } from 'node:os';
import { type LoggerService } from '@nestjs/common';
import { IMAGE_READ_BUDGET_BYTES, imageReads } from './image-reads.js';

/**
 * What a share of the API's memory is for. The admission counts them apart (ADR-0073 9-46): an
 * upload body (`body` — its declared length, until it is in), a conversion (`conversion` —
 * IMAGE_CONVERSION_PEAK_BYTES, while it runs) and an image read (`read` — the image's bytes, while
 * the store is read).
 */
export type ShareKind = 'body' | 'conversion' | 'read';

/**
 * The API's memory, watched before it takes on what images cost (owner decision 2026-10-22 answer
 * 3, ADR-0073 9-46): an upload body before it is read, a conversion before it starts and an image
 * read before the store is read each ask for their bytes here first, and get them only while the
 * process's resident memory (RSS), the shares already given out and these bytes stay within a
 * ceiling under the container's limit. Otherwise they wait, for a bounded time, and are refused
 * (RATE_LIMITED with `Retry-After` — what the callers answer) if room does not come.
 *
 * The shares given out count in full on top of the RSS — a body half received, a conversion near
 * its peak, are counted twice, since what of a share is already resident cannot be told apart
 * from the rest of the process. That errs towards waiting, with one exception: a read does not
 * count the conversions' shares, so a running conversion does not hold every image read of the
 * site back. In their place, an upload body and a conversion keep room for the reads that may
 * still come — what of the reads' budget (IMAGE_READ_BUDGET_BYTES, image-reads.ts) is not taken,
 * and the reads waiting here — so the reads a conversion does not hold back still fit beside it.
 * A read's share is given back once its image is read (its bytes are then in the RSS, and the
 * reads' budget still bounds them). Holding nothing, it still compares the RSS: a process that
 * holds too much on its own takes nothing more.
 *
 * Without a ceiling (`configure` with null — development and the tests, where no container limits
 * the process, unless API_MEMORY_CEILING_MIB sets one) it gives every share at once and counts
 * nothing against a limit.
 */
export class MemoryAdmission {
  private ceiling: number | null = null;
  private resident: () => number = () => process.memoryUsage.rss();
  private held = 0;
  private conversionsHeld = 0;
  private readsWaiting = 0;
  private readonly waiting: Waiter[] = [];
  private timer: NodeJS.Timeout | undefined;
  private refused: ((refusal: MemoryRefusal) => void) | undefined;

  /**
   * `readRoom`: the bytes the image reads may still take of their budget (none by default — the
   * API's admission, below, asks the reads' budget).
   */
  constructor(private readonly readRoom: () => number = () => 0) {}

  /**
   * Sets the ceiling (bytes, or null for none) and, for the tests, the reader of the resident
   * memory (default: `process.memoryUsage.rss()`), and who hears of a refusal (a log line).
   */
  configure(options: {
    ceilingBytes: number | null;
    resident?: () => number;
    onRefused?: (refusal: MemoryRefusal) => void;
  }): void {
    this.ceiling = options.ceilingBytes;
    this.resident = options.resident ?? (() => process.memoryUsage.rss());
    this.refused = options.onRefused;
    this.check();
  }

  /** The ceiling, in bytes, or null for none. */
  get ceilingBytes(): number | null {
    return this.ceiling;
  }

  /** The bytes of the shares given out and not yet given back. */
  get heldBytes(): number {
    return this.held;
  }

  /** The requests waiting for room. */
  get waitingCount(): number {
    return this.waiting.length;
  }

  /**
   * `bytes` of `kind` when the RSS and the shares out leave room for them now, as a release
   * (idempotent); null otherwise. Never waits.
   */
  tryTake(bytes: number, kind: ShareKind): Release | null {
    if (this.ceiling !== null && !this.fits(this.resident(), this.readRoom(), bytes, kind)) {
      return null;
    }
    return this.give(bytes, kind);
  }

  /**
   * `bytes` of `kind` as soon as they fit — now, or as the RSS falls and shares come back (looked
   * at every MEMORY_POLL_MS and at every release; the requests waiting are looked at in the order
   * they came, and each is let in once its own bytes fit, so a small read is not held behind a
   * conversion that does not fit yet) — for at most `waitMs`. Resolves the release (idempotent),
   * or null when no room came in time or `signal` was aborted (the client went) first.
   */
  async admit(
    bytes: number,
    options: { kind: ShareKind; waitMs: number; signal?: AbortSignal },
  ): Promise<Release | null> {
    if (options.signal?.aborted === true) return null;
    const now = this.tryTake(bytes, options.kind);
    if (now !== null) return now;
    return new Promise<Release | null>((resolve) => {
      const waiter: Waiter = {
        bytes,
        kind: options.kind,
        resolve: (release) => {
          clearTimeout(waiter.deadline);
          options.signal?.removeEventListener('abort', waiter.abort);
          resolve(release);
        },
        deadline: setTimeout(() => {
          this.drop(waiter);
          this.refused?.(this.refusal(bytes, options.kind));
          waiter.resolve(null);
        }, options.waitMs),
        abort: () => {
          this.drop(waiter);
          waiter.resolve(null);
        },
      };
      options.signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter);
      if (waiter.kind === 'read') this.readsWaiting += bytes;
      this.watch();
    });
  }

  /**
   * Whether `bytes` of `kind` fit beside `rss` (the RSS as last read) and the shares out, under a
   * ceiling: a read beside every share but the conversions'; an upload body or a conversion beside
   * every share and the room the reads may still take — `readRoom` of their budget, and the reads
   * waiting here.
   */
  private fits(rss: number, readRoom: number, bytes: number, kind: ShareKind): boolean {
    if (this.ceiling === null) return true;
    if (kind === 'read') return rss + this.held - this.conversionsHeld + bytes <= this.ceiling;
    const readsToCome = Math.max(0, readRoom) + this.readsWaiting;
    return rss + this.held + bytes + readsToCome <= this.ceiling;
  }

  private give(bytes: number, kind: ShareKind): Release {
    this.held += bytes;
    if (kind === 'conversion') this.conversionsHeld += bytes;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.held -= bytes;
      if (kind === 'conversion') this.conversionsHeld -= bytes;
      this.check();
    };
  }

  /**
   * Lets in the requests waiting that fit now, in the order they came. The RSS (on Linux a read of
   * /proc) and the reads' room are read once for the pass, not once for each request waiting: what
   * the pass lets in has not been allocated yet, and the shares it gives are counted as it goes.
   */
  private check(): void {
    if (this.waiting.length > 0) {
      const rss = this.ceiling === null ? 0 : this.resident();
      const readRoom = this.ceiling === null ? 0 : this.readRoom();
      for (const waiter of [...this.waiting]) {
        if (!this.fits(rss, readRoom, waiter.bytes, waiter.kind)) continue;
        this.drop(waiter);
        waiter.resolve(this.give(waiter.bytes, waiter.kind));
      }
    }
    if (this.waiting.length === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Looks again every MEMORY_POLL_MS while anything waits: the RSS falls without a release. */
  private watch(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.check();
    }, MEMORY_POLL_MS);
    this.timer.unref();
  }

  private drop(waiter: Waiter): void {
    const index = this.waiting.indexOf(waiter);
    if (index === -1) return;
    this.waiting.splice(index, 1);
    if (waiter.kind === 'read') this.readsWaiting -= waiter.bytes;
    if (this.waiting.length === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private refusal(bytes: number, kind: ShareKind): MemoryRefusal {
    return {
      kind,
      residentBytes: this.resident(),
      heldBytes: this.held,
      neededBytes: bytes,
      ceilingBytes: this.ceiling ?? Number.POSITIVE_INFINITY,
    };
  }
}

/** Gives a share back. Idempotent. */
export type Release = () => void;

/** A request that waited its whole time for room: what the log says of it. */
export interface MemoryRefusal {
  readonly kind: ShareKind;
  readonly residentBytes: number;
  readonly heldBytes: number;
  readonly neededBytes: number;
  readonly ceilingBytes: number;
}

interface Waiter {
  readonly bytes: number;
  readonly kind: ShareKind;
  readonly resolve: (release: Release | null) => void;
  readonly deadline: NodeJS.Timeout;
  readonly abort: () => void;
}

/** How often the requests waiting for room look at the RSS again, in milliseconds. */
export const MEMORY_POLL_MS = 50;

/**
 * What the default ceiling leaves under the container's limit: 32MiB (implementation-chosen,
 * ADR-0073 9-46) for what the RSS does not show or shows late — the kernel's own memory charged
 * to the container (sockets, page tables), a conversion's swing from run to run (~10MiB, 9-8),
 * and what the heap grows by between one look and the next.
 */
export const MEMORY_CEILING_MARGIN_BYTES = 32 * 1024 * 1024;

/**
 * The ceiling the API runs with, in bytes, or null for none: API_MEMORY_CEILING_MIB when it is
 * set; otherwise the memory limit the process runs under (`process.constrainedMemory()` — the
 * container's: 448MiB in deploy/compose.yaml) less MEMORY_CEILING_MARGIN_BYTES, 416MiB there; and
 * none when no limit is known (development, the tests and CI run the API as a plain process —
 * whose RSS a ceiling made for the container would not fit).
 *
 * `ceilingMiB` is the setting as ConfigService gives it, and only a number is a setting: left
 * empty (`API_MEMORY_CEILING_MIB=`, as .env.example has it) the schema's value is undefined, and
 * @nestjs/config then falls back to the raw environment and gives '' — which, read as a number,
 * would be a ceiling of 0 that refuses every image.
 */
export function memoryCeilingBytes(
  ceilingMiB: unknown,
  limitBytes: number = processMemoryLimit(),
): number | null {
  if (typeof ceilingMiB === 'number') return ceilingMiB * 1024 * 1024;
  if (limitBytes <= 0) return null;
  return limitBytes - MEMORY_CEILING_MARGIN_BYTES;
}

/**
 * The memory limit the process runs under, in bytes, or 0 when there is none: the cgroup's
 * (Docker's `memory` limit) as libuv reads it. No limit reads as 0 or as more than the machine
 * has (2^64 on Linux).
 */
export function processMemoryLimit(): number {
  const limit = process.constrainedMemory();
  return limit > 0 && limit < totalmem() ? limit : 0;
}

/**
 * How long an upload waits for room before its body is read, and a conversion before it starts,
 * then RATE_LIMITED: 10 seconds (implementation-chosen, ADR-0073 9-46) — a few conversions'
 * time. A conversion's 10 seconds count from when it joined the conversion queue, not from its
 * turn (image.ts): one that finds no room once its time has gone by is refused at once, so the
 * uploads queued behind one that waited in vain are not each made to wait 10 seconds more. How
 * long an image read waits before the store is read: 2 seconds; the web reads a refused image
 * again after its `Retry-After` (9-39). A setting rather than constants only so the integration
 * tests can watch a refusal without waiting.
 */
export const memoryWaits = {
  uploadMs: 10_000,
  conversionMs: 10_000,
  readMs: 2_000,
};

/**
 * The API's admission: one for the process (the image budgets are per process too). The reads'
 * room is what of their budget (`imageReads`) is not taken.
 */
export const memoryAdmission = new MemoryAdmission(() => IMAGE_READ_BUDGET_BYTES - imageReads.size);

/** At most one log line a minute for the admission's refusals, with their count. */
export const REFUSAL_LOG_INTERVAL_MS = 60_000;

const MiB = 1024 * 1024;

/**
 * The two lines the admission writes, each its words and its figures: on Nest's `Logger` as
 * MediaModule has it, through `nestAdmissionLogger`.
 */
export interface MemoryAdmissionLogger {
  log(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * The admission's lines on Nest's `Logger` (MediaModule): its words, then its figures as JSON, in
 * one message. Nest's `Logger` takes a message and a context, not pino's figures first — given
 * both, the API's logger (`NestPinoLogger`, logger.ts) wrote the figures as the message and the
 * words as a `stack`.
 */
export function nestAdmissionLogger(
  logger: Pick<LoggerService, 'log' | 'warn'>,
): MemoryAdmissionLogger {
  const line = (fields: Record<string, unknown>, message: string) =>
    `${message} ${JSON.stringify(fields)}`;
  return {
    log: (fields, message) => {
      logger.log(line(fields, message));
    },
    warn: (fields, message) => {
      logger.warn(line(fields, message));
    },
  };
}

/**
 * The admission's refusals in the log (ADR-0073 9-46, docs/OPERATIONS.md): the first at once, then
 * at most one line every REFUSAL_LOG_INTERVAL_MS, each with the number refused since the line
 * before (`refused`) and the figures of the latest of them. Refusals within a minute of a line
 * are written at the end of that minute — a burst that stops is still counted then, not held back
 * until some later refusal — and what is pending at shutdown is written then (`close`).
 */
export class RefusalLog {
  private count = 0;
  private latest: MemoryRefusal | undefined;
  private lastLine = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly logger: Pick<MemoryAdmissionLogger, 'warn'>) {}

  refused(refusal: MemoryRefusal): void {
    this.count += 1;
    this.latest = refusal;
    const now = Date.now();
    if (now - this.lastLine >= REFUSAL_LOG_INTERVAL_MS) {
      this.flush();
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(
      () => {
        this.flush();
      },
      this.lastLine + REFUSAL_LOG_INTERVAL_MS - now,
    );
    this.timer.unref();
  }

  /** Writes what is pending, if anything, and stops the timer. */
  close(): void {
    this.flush();
  }

  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const latest = this.latest;
    if (this.count === 0 || latest === undefined) return;
    this.lastLine = Date.now();
    this.logger.warn(
      {
        refused: this.count,
        kind: latest.kind,
        residentMiB: Math.round(latest.residentBytes / MiB),
        heldMiB: Math.round(latest.heldBytes / MiB),
        neededMiB: Math.round(latest.neededBytes / MiB),
        ceilingMiB: Math.round(latest.ceilingBytes / MiB),
      },
      'image work refused: no room under the memory ceiling in time',
    );
    this.count = 0;
  }
}

/**
 * Turns the admission on as the API runs it (owner decision 2026-10-22 answer 3, ADR-0073 9-46) —
 * what MediaModule does at start: the ceiling from `configured` (API_MEMORY_CEILING_MIB as
 * ConfigService gives it) and `limitBytes` (the process's memory limit, `processMemoryLimit()`),
 * its refusals to `logger` (`RefusalLog`), and one line saying what the ceiling is and what the
 * process holds then — the owner's check of the container's idle memory reads these. Returns the
 * refusals' log, to close at shutdown.
 */
export function startMemoryAdmission(
  admission: MemoryAdmission,
  options: { configured: unknown; limitBytes: number; logger: MemoryAdmissionLogger },
): RefusalLog {
  const ceilingBytes = memoryCeilingBytes(options.configured, options.limitBytes);
  const refusals = new RefusalLog(options.logger);
  admission.configure({
    ceilingBytes,
    onRefused: (refusal) => {
      refusals.refused(refusal);
    },
  });
  options.logger.log(
    {
      ceilingMiB: ceilingBytes === null ? null : Math.round(ceilingBytes / MiB),
      limitMiB: options.limitBytes === 0 ? null : Math.round(options.limitBytes / MiB),
      residentMiB: Math.round(process.memoryUsage.rss() / MiB),
    },
    ceilingBytes === null
      ? 'image work memory: no ceiling (no memory limit known)'
      : 'image work memory: ceiling set',
  );
  return refusals;
}
