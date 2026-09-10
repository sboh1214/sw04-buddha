import { type BlockList } from 'node:net';
import { type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env, uncountedPeers } from '../config/env.js';

/**
 * Injection token for the peers the per-address limit does not count (a `node:net` BlockList
 * built from RATE_LIMIT_UNCOUNTED_PEERS — config/env.ts explains the list, and
 * rate-limit.tracker.ts explains the rule it belongs to).
 *
 * A provider so a test can list a peer for one app (`createTestApp({ uncountedPeers })`), the
 * way `RATE_LIMITS` lets one raise a limit. Registered ONCE, in `RateLimitsModule`, for the
 * same reason that module exists: the address limit is installed as a raw Fastify hook that
 * reads it with `app.get`, and a token declared in two modules would give `overrideProvider`
 * two targets.
 */
export const UNCOUNTED_PEERS = Symbol('UNCOUNTED_PEERS');

export const uncountedPeersProvider: Provider<BlockList> = {
  provide: UNCOUNTED_PEERS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    uncountedPeers({
      RATE_LIMIT_UNCOUNTED_PEERS: config.get('RATE_LIMIT_UNCOUNTED_PEERS', { infer: true }),
    }),
};
