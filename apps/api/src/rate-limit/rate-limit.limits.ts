import { Module, type Provider } from '@nestjs/common';
import { DEFAULT_RATE_LIMITS, type RateLimits } from '@buddha/shared';
import { UNCOUNTED_PEERS, uncountedPeersProvider } from './uncounted-peers.js';

/**
 * Injection token for the resolved limit of every bucket (PLAN 7.5).
 *
 * A provider rather than a constant so it can be overridden in ONE place:
 * `createTestApp({ rateLimits })` raises the charge ceiling for the suite that proves PLAN M2
 * AC 2 (twenty concurrent charges by one account, above PLAN 7.5's own 10/min for that route),
 * and `rate-limit.controller.test.ts` pins the shipped defaults so the acceptance figure cannot
 * drift unnoticed.
 *
 * Nothing feeds it from the environment today, and that is deliberate rather than unfinished:
 * PLAN 7.5 states the numbers and the M6 acceptance criterion counts one of them, so a
 * deployment must not be able to move them silently. The seam is here for the test override
 * and for the day an owner decides otherwise — it is not an ops knob yet.
 */
export const RATE_LIMITS = Symbol('RATE_LIMITS');

export const rateLimitsProvider: Provider<RateLimits> = {
  provide: RATE_LIMITS,
  useValue: DEFAULT_RATE_LIMITS,
};

/**
 * Its own module because two modules need the same instance: `RateLimitModule` for the HTTP
 * guard, and `AuthInstanceModule` for the limit better-auth's own routes are checked against
 * (`authRateLimiter`). Declaring the provider twice would give a test's `overrideProvider` two
 * targets and one of them would keep the shipped numbers. `UNCOUNTED_PEERS` rides along for
 * the same reason (uncounted-peers.ts).
 */
@Module({
  providers: [rateLimitsProvider, uncountedPeersProvider],
  exports: [RATE_LIMITS, UNCOUNTED_PEERS],
})
export class RateLimitsModule {}
