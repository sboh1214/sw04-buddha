import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  JOB_NAMES,
  marketCloseJobId,
  marketMakerJobId,
  type MarketMakerJobData,
  marketOpenJobId,
  marketResolveJobId,
  type JobName,
  type MarketJobData,
  type QueueName,
} from '@buddha/shared';
import { Queue, type JobsOptions } from 'bullmq';
import { type Redis } from 'ioredis';
import { REDIS_COMMAND_TIMEOUT_MS, REDIS_QUEUE } from '../infra/redis/redis.provider.js';

/** The queue the worker consumes `market.open`, `.close`, `.resolve` and `.finalize` from. */
export const MARKETS_QUEUE: QueueName = 'markets';

/**
 * Per-job options (PLAN 9: idempotent, 3 attempts, exponential backoff). `removeOnComplete:
 * true` rather than a count: every job carries a custom id (`marketCloseJobId`), and BullMQ
 * refuses to add a job whose id still exists in any set — a completed one kept for inspection
 * would silently block the next registration of the same market and instant. Failed jobs are
 * kept, bounded, so an operator can read why the worker gave up; the per-minute scan is what
 * actually settles such a market.
 */
export const MARKET_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: true,
  removeOnFail: { count: 1_000 },
} as const satisfies JobsOptions;

/**
 * Upper bound on one registration or cancellation (ms). BullMQ's `add`/`remove` first await
 * the connection's `ready` — and on a Redis that is down ioredis keeps reconnecting without
 * ever reaching it, so that wait has no bound of its own — then run a Lua script under the
 * client's `commandTimeout`. Both phases are covered by racing the whole call against this,
 * which is the same figure the client uses per command (redis.provider.ts): after a COMMIT the
 * caller is the HTTP response of a transition that succeeded, and it must not park.
 */
export const MARKET_JOB_TIMEOUT_MS = REDIS_COMMAND_TIMEOUT_MS;

/** Node's happy-eyeballs ECONNREFUSED is an AggregateError with an empty message. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    return [code, error.message].filter(Boolean).join(' ') || error.name;
  }
  return String(error);
}

class JobTimeoutError extends Error {
  constructor(what: string) {
    super(`${what} timed out after ${String(MARKET_JOB_TIMEOUT_MS)} ms`);
    this.name = 'JobTimeoutError';
  }
}

/**
 * Resolves with `promise`, or rejects with JobTimeoutError after the bound. The underlying
 * call keeps running (BullMQ offers no cancellation) and its outcome is swallowed: a late
 * `add` that succeeds is exactly what was wanted, and a late failure was already reported.
 */
function bounded<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new JobTimeoutError(what)), MARKET_JOB_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * PLAN 9's producer side (M5, ADR-0046; #21, ADR-0100; #152, ADR-0103): the `market.open`,
 * `market.close` and `market.resolve` jobs the worker consumes, registered by MarketAdminService
 * (and MarketSupplementService, #80, MarketPauseService, #114, and MarketJudgementService, #152)
 * AFTER its transaction commits. An open job is delayed to `scheduledOpenAt` — registered by an
 * approval or a reschedule that leaves the market SCHEDULED, moved by a reschedule, cancelled by a
 * 되돌리기 from SCHEDULED. A close job is delayed to `closeAt` — registered at the approval (the
 * close is locked from then on but for a supplement, and the worker's close only acts on an open
 * or paused market — a pause keeps the job, #173 item 3) and cancelled the same way when that
 * instant stops being true (an approved supplement's later close, which registers the new one, an
 * approved early close, a 되돌리기 from SCHEDULED). A resolve job is delayed to the dispute deadline
 * the judgement's approval fixed (CLOSED → PROVISIONAL) or a correction's approval (#176), and
 * never cancelled: a correction gives a new deadline, so a new job, and the earlier deadline's
 * finds the later one and skips (`not_due`). `market.finalize` is not the API's since #152: the
 * worker registers it after its own confirmation (PROVISIONAL → RESOLVED).
 *
 * Best effort by design, like MarketPublisher: the transition has COMMITted when this runs,
 * so a failure here is logged and swallowed, never turned into an error response — and never
 * lost either, because the worker's per-minute scans (PLAN 5.5 "안전망") open, close, confirm
 * and finalize whatever is due whether or not its job exists. That scan is also why a cancel that
 * finds nothing (the job already ran, or was never added) needs no retry: the job it would have
 * removed re-verifies status and instant under the market lock and is a no-op.
 *
 * The delay is computed from the instant the transaction read on the database clock, not
 * from `Date.now()`: the two clocks may disagree, and `closeAt - now` on the clock that wrote
 * `close_at` is the wait the worker should actually observe (it re-checks on the same clock).
 */
@Injectable()
export class MarketJobs implements OnApplicationShutdown {
  private readonly logger = new Logger(MarketJobs.name);
  private readonly queue: Queue<MarketJobData, unknown, JobName>;
  private readonly makerQueue: Queue<MarketMakerJobData, unknown, JobName>;

  constructor(@Inject(REDIS_QUEUE) redis: Redis) {
    this.makerQueue = new Queue<MarketMakerJobData, unknown, JobName>('maker', {
      connection: redis,
      defaultJobOptions: MARKET_JOB_OPTIONS,
      skipVersionCheck: true,
    });
    this.makerQueue.on('error', (error: Error) => {
      this.logger.warn(`maker queue error: ${describeError(error)}`);
    });
    this.queue = new Queue<MarketJobData, unknown, JobName>(MARKETS_QUEUE, {
      connection: redis,
      defaultJobOptions: MARKET_JOB_OPTIONS,
      // BullMQ initialises a Queue ONCE: `RedisConnection.init()` waits for the client's
      // `ready` and then issues INFO to read the server version, and a rejected init is cached
      // for the life of the Queue — every later add/remove awaits the same rejected promise.
      // On the REDIS_QUEUE client that INFO runs under `commandTimeout` (2 s), so a Redis busy
      // for two seconds at API boot would have left this producer dead until a restart, with
      // every transition silently demoted to the per-minute scan. Skipping the check leaves
      // only the wait for `ready`, which ioredis retries forever rather than rejecting; the
      // version floor (Redis >= 5) is already what the compose files pin and the worker's own
      // Queue verifies at its boot.
      skipVersionCheck: true,
    });
    // BullMQ re-emits the connection's errors on the Queue; an EventEmitter 'error' with no
    // listener is thrown, which would take the process down on a Redis blip.
    this.queue.on('error', (error: Error) => {
      this.logger.warn(`markets queue error: ${describeError(error)}`);
    });
  }

  /**
   * `market.open` for one SCHEDULED market at `scheduledOpenAt` (#21, ADR-0100; job id fixed by
   * market and instant). The callers register it only for a scheduled open still ahead of `now`:
   * the approval and the reschedule open a market whose scheduled open has come in their own
   * transaction instead.
   */
  scheduleOpen(marketId: string, scheduledOpenAt: Date, now: Date): Promise<void> {
    return this.schedule(
      JOB_NAMES.marketOpen,
      marketOpenJobId(marketId, scheduledOpenAt),
      marketId,
      scheduledOpenAt,
      now,
    );
  }

  cancelOpen(marketId: string, scheduledOpenAt: Date): Promise<void> {
    return this.cancel(marketOpenJobId(marketId, scheduledOpenAt));
  }

  /** `market.close` for one market at `closeAt` (job id fixed by market and instant). */
  scheduleClose(marketId: string, closeAt: Date, now: Date): Promise<void> {
    return this.schedule(
      JOB_NAMES.marketClose,
      marketCloseJobId(marketId, closeAt),
      marketId,
      closeAt,
      now,
    );
  }

  cancelClose(marketId: string, closeAt: Date): Promise<void> {
    return this.cancel(marketCloseJobId(marketId, closeAt));
  }

  /**
   * `market.resolve` for one PROVISIONAL market at its `disputeDeadline` (#152, ADR-0103; job id
   * fixed by market and deadline): registered by the judgement's approval, which fixed the deadline
   * at its instant `now` plus the release setting `market.dispute_window` — a correction's (#176)
   * at its instant plus the corrected version's length, a new deadline and so a new id — so the
   * worker confirms the result (PROVISIONAL → RESOLVED) once the deadline has passed with nothing
   * held. Nothing cancels it: a run before the deadline (the market's own, which a correction may
   * have moved later), or on a market confirmed already, skips under the market lock, and the
   * worker's per-minute scan confirms a market whose job never reached Redis. A run that finds a
   * 판정 이의 or a waiting correction holding the market skips too (`held`, #175, #176) and is
   * removed on completion, so the dismissal — or the correction's 반려 or 철회 — that leaves nothing
   * holding past the deadline registers it again under the same id, due at once
   * (MarketDisputeService, MarketJudgementService; `now` past `disputeDeadline`: no delay).
   */
  scheduleResolve(marketId: string, disputeDeadline: Date, now: Date): Promise<void> {
    return this.schedule(
      JOB_NAMES.marketResolve,
      marketResolveJobId(marketId, disputeDeadline),
      marketId,
      disputeDeadline,
      now,
    );
  }

  /** The DB generation is already committed. Redis is a fast path, never the source of work. */
  async refreshMarketMaker(marketId: string, generation: bigint): Promise<void> {
    const jobId = marketMakerJobId(marketId, generation, randomUUID());
    try {
      await bounded(
        this.makerQueue.add(
          JOB_NAMES.marketMakerRefresh,
          { marketId, generation: generation.toString() },
          {
            jobId,
            // A member fill can commit after an active cycle captured no next generation.
            // Retain one follow-up, matching the worker producer's deduplication lifecycle.
            deduplication: { id: marketId, keepLastIfActive: true },
            removeOnComplete: true,
          },
        ),
        `add ${jobId}`,
      );
    } catch (error) {
      this.logger.warn(`could not schedule ${jobId}: ${describeError(error)}`);
    }
  }

  private async schedule(
    name: JobName,
    jobId: string,
    marketId: string,
    at: Date,
    now: Date,
  ): Promise<void> {
    // An instant already past (a close time that expired before this ran) is due now, not
    // "negative delay" — BullMQ would treat that as no delay anyway, but stating it keeps the
    // logged delay meaningful.
    const delay = Math.max(0, at.getTime() - now.getTime());
    try {
      // A second add under an id that still exists (the same market and instant registered
      // twice) is answered by BullMQ with the EXISTING job, not an error, so the double
      // registration is harmless and needs no check here.
      await bounded(this.queue.add(name, { marketId }, { jobId, delay }), `add ${jobId}`);
    } catch (error) {
      this.logger.warn(
        `could not schedule ${jobId} (delay ${String(delay)} ms): ${describeError(error)}`,
      );
    }
  }

  private async cancel(jobId: string): Promise<void> {
    try {
      // 0 when there is nothing to remove or the job is locked by a worker mid-run: in both
      // cases the handler's own re-verification under the market lock is the guard.
      await bounded(this.queue.remove(jobId), `remove ${jobId}`);
    } catch (error) {
      this.logger.warn(`could not cancel ${jobId}: ${describeError(error)}`);
    }
  }

  // The Queue only; the connection it was handed is shared (BullMQ never quits one it did not
  // open) and RedisModule closes it afterwards — this module imports that one, so Nest runs
  // this hook first.
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.queue.close(), this.makerQueue.close()]);
  }
}
