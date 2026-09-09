import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  JOB_NAMES,
  marketCloseJobId,
  marketFinalizeJobId,
  type JobName,
  type MarketJobData,
  type QueueName,
} from '@buddha/shared';
import { Queue, type JobsOptions } from 'bullmq';
import { type Redis } from 'ioredis';
import { REDIS_COMMAND_TIMEOUT_MS, REDIS_QUEUE } from '../infra/redis/redis.provider.js';

/** The queue the worker consumes `market.close` / `market.finalize` from (PLAN 9). */
export const MARKETS_QUEUE: QueueName = 'markets';

/**
 * Per-job options (PLAN 9: idempotent, 3 attempts, exponential backoff). `removeOnComplete:
 * true` rather than a count: every job carries a custom id (`marketCloseJobId`), and BullMQ
 * refuses to add a job whose id still exists in any set — a completed one kept for inspection
 * would silently block the next registration of the same market and instant (a void followed
 * by a re-open at the same `closeAt`). Failed jobs are kept, bounded, so an operator can read
 * why the worker gave up; the per-minute scan is what actually settles such a market.
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
 * PLAN 9's producer side (M5): the delayed `market.close` and `market.finalize` jobs the
 * worker consumes, registered by MarketAdminService AFTER its transaction commits and
 * cancelled the same way when the instant they were registered for stops being true (a
 * PATCHed `closeAt`, a changed result, a manual close, a void).
 *
 * Best effort by design, like MarketPublisher: the transition has COMMITted when this runs,
 * so a failure here is logged and swallowed, never turned into an error response — and never
 * lost either, because the worker's per-minute scan (PLAN 5.5 "안전망") closes and finalizes
 * whatever is due whether or not its delayed job exists. That scan is also why a cancel that
 * finds nothing (the job already ran, or was never added) needs no retry: the job it would
 * have removed re-verifies status and instant under the market lock and is a no-op.
 *
 * The delay is computed from the instant the transaction read on the database clock, not
 * from `Date.now()`: the two clocks may disagree, and `closeAt - now` on the clock that wrote
 * `close_at` is the wait the worker should actually observe (it re-checks on the same clock).
 */
@Injectable()
export class MarketJobs implements OnApplicationShutdown {
  private readonly logger = new Logger(MarketJobs.name);
  private readonly queue: Queue<MarketJobData, unknown, JobName>;

  constructor(@Inject(REDIS_QUEUE) redis: Redis) {
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

  /** `market.finalize` for one market at `disputeUntil`. */
  scheduleFinalize(marketId: string, disputeUntil: Date, now: Date): Promise<void> {
    return this.schedule(
      JOB_NAMES.marketFinalize,
      marketFinalizeJobId(marketId, disputeUntil),
      marketId,
      disputeUntil,
      now,
    );
  }

  cancelFinalize(marketId: string, disputeUntil: Date): Promise<void> {
    return this.cancel(marketFinalizeJobId(marketId, disputeUntil));
  }

  private async schedule(
    name: JobName,
    jobId: string,
    marketId: string,
    at: Date,
    now: Date,
  ): Promise<void> {
    // An instant already past (a seed market, a close time the admin let expire) is due
    // now, not "negative delay" — BullMQ would treat that as no delay anyway, but stating it
    // keeps the logged delay meaningful.
    const delay = Math.max(0, at.getTime() - now.getTime());
    try {
      // A second add under an id that still exists (the same market and instant registered
      // twice — an open, a void, a re-open) is answered by BullMQ with the EXISTING job, not
      // an error, so the double registration is harmless and needs no check here.
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
    await this.queue.close();
  }
}
