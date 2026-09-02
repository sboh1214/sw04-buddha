import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { type Db } from '@buddha/db';
import { sql } from 'drizzle-orm';
import { type Redis } from 'ioredis';
import { DB } from '../infra/db/db.provider.js';
import { REDIS } from '../infra/redis/redis.provider.js';

export type ProbeResult = 'ok' | 'error';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: ProbeResult;
  redis: ProbeResult;
}

/** Upper bound for a single dependency probe so /health never hangs. */
const PROBE_TIMEOUT_MS = 2_000;

async function probe(run: () => Promise<unknown>): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS);
  });
  try {
    await Promise.race([run(), timeout]);
    return 'ok';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/health: unversioned (no /v1) liveness + dependency readiness.
 * 200 when every dependency answers, 503 with the same body shape otherwise.
 */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const [db, redis] = await Promise.all([
      probe(() => this.db.execute(sql`select 1`)),
      probe(() => this.redis.ping()),
    ]);
    const body: HealthResponse = {
      status: db === 'ok' && redis === 'ok' ? 'ok' : 'degraded',
      db,
      redis,
    };
    if (body.status !== 'ok') {
      // Passing an object makes it the response body verbatim (HTTP 503).
      throw new ServiceUnavailableException(body);
    }
    return body;
  }
}
