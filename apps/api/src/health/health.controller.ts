import {
  Controller,
  Get,
  Inject,
  Logger,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { type Db } from '@buddha/db';
import { sql } from 'drizzle-orm';
import { type Redis } from 'ioredis';
import { RawResponse } from '../common/decorators/raw-response.decorator.js';
import { DB } from '../infra/db/db.provider.js';
import { REDIS } from '../infra/redis/redis.provider.js';

export type ProbeResult = 'ok' | 'error';

/** One dependency's outcome, with how long it took to say so. */
export interface CheckDetail {
  status: ProbeResult;
  /**
   * Milliseconds the probe took, rounded — measured either way, so a timeout reports the time
   * actually spent (≈ PROBE_TIMEOUT_MS) rather than the constant.
   */
  latencyMs: number;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  /**
   * Kept flat and kept first, because they are the contract M0 shipped (ADR-0015) and what any
   * existing probe reads. `checks` below adds the detail PLAN M6 asks for without moving them.
   */
  db: ProbeResult;
  redis: ProbeResult;
  /** Whole seconds since this process started; the cheapest way to spot a restart loop. */
  uptimeSeconds: number;
  checks: { db: CheckDetail; redis: CheckDetail };
}

/** Liveness: no dependency is consulted, so the answer is about this process alone. */
export interface LivenessResponse {
  status: 'ok';
  uptimeSeconds: number;
}

/** Upper bound for a single dependency probe so /health never hangs. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * GET /api/health: unversioned (no /v1) READINESS — the dependencies this API cannot serve a
 * request without. 200 when every one answers, 503 with the same body shape otherwise.
 *
 * GET /api/health/live: LIVENESS — is this process running. Nothing is probed, so it cannot be
 * anything but 200, and that is the point: an orchestrator wired to the readiness endpoint
 * restarts a container because REDIS blipped, which fixes nothing and drops every socket the
 * instance was holding. Readiness is for a load balancer's routing decision; liveness is for
 * the "is it wedged" decision, and they are not the same question.
 *
 * Neither is wrapped in the PLAN 7 envelope (ADR-0015 body shape, read by infrastructure) or
 * counted against the rate limit — a probe that is refused 429 while an instance defends itself
 * reads to an orchestrator as an instance to restart. That exemption is not a decorator here:
 * the address bucket is counted by a Fastify hook ahead of parsing, which sees the Fastify
 * route and not this controller's metadata, so the two routes are named in address-limit.ts
 * (`UNCOUNTED_ROUTES`) —
 * a route added to this controller is counted until it is added there. Excluded from the
 * OpenAPI document: not part of the client contract (docs/API.md documents them by hand).
 */
@ApiExcludeController()
@RawResponse()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const [db, redis] = await Promise.all([
      this.probe('db', () => this.db.execute(sql`select 1`)),
      this.probe('redis', () => this.redis.ping()),
    ]);
    const body: HealthResponse = {
      status: db.status === 'ok' && redis.status === 'ok' ? 'ok' : 'degraded',
      db: db.status,
      redis: redis.status,
      uptimeSeconds: Math.floor(process.uptime()),
      checks: { db, redis },
    };
    if (body.status !== 'ok') {
      // Passing an object makes it the response body verbatim (HTTP 503).
      throw new ServiceUnavailableException(body);
    }
    return body;
  }

  @Get('live')
  live(): LivenessResponse {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /**
   * Runs one dependency probe under a hard bound and reports how long it took.
   *
   * The reason a probe failed is LOGGED and never returned. Logged because it used to be
   * swallowed outright — a `degraded` answer produced no output anywhere, so the one artefact
   * that said the API was unhealthy could not say why. Never returned because this endpoint is
   * unauthenticated: a driver's error text names hosts, ports, roles and database names, and
   * that is a description of the deployment handed to anyone who can reach it.
   */
  private async probe(name: string, run: () => Promise<unknown>): Promise<CheckDetail> {
    const started = process.hrtime.bigint();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS);
    });
    try {
      await Promise.race([run(), timeout]);
      return { status: 'ok', latencyMs: elapsedMs(started) };
    } catch (error) {
      this.logger.warn(
        `${name} probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: 'error', latencyMs: elapsedMs(started) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function elapsedMs(started: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - started) / 1e6);
}
