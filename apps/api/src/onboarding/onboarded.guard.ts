import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { missingOnboardingStepsOf, type Db } from '@buddha/db';
import { type OnboardingRequiredDetails } from '@buddha/shared';
import { type AuthenticatedRequest } from '../auth/session.guard.js';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Refuses an account that has not done the onboarding's three steps — consent, 본인확인,
 * nickname — with ONBOARDING_REQUIRED naming the steps it misses (#58, ADR-0069 decision 1
 * #57-8: until then it only browses). The one check every action #57-8 keeps from such an account
 * makes, inside the transaction when the answer must hold until the write commits; `OnboardedGuard`
 * makes it for a whole route.
 */
export async function assertOnboarded(executor: Db | Tx, userId: string): Promise<void> {
  const steps = await missingOnboardingStepsOf(executor, userId);
  if (steps.length === 0) return;
  const details: OnboardingRequiredDetails = { steps };
  throw new AppError('ONBOARDING_REQUIRED', {
    message: 'The onboarding is not done',
    details,
  });
}

/**
 * The server's side of #57-8: a route that writes for the community or the market — a post, a
 * comment, a like, a report, a market proposal, an order (#46…#77) — is open to accounts that have
 * done the onboarding only, however the request is made. Apply it after SessionGuard
 * (`@UseGuards(SessionGuard, OnboardedGuard)`, or on the handler under a controller's
 * SessionGuard), and register the route in OWNER_ROUTES with `onboarded: true` — registry.test.ts
 * holds the two to each other. The 관심 등록 stays sign-in only (ADR-0061 #89 row).
 *
 * A guard runs before the body is read, so an account that has not finished hears
 * ONBOARDING_REQUIRED whatever it sent. Its consent counts only while no revision that changed
 * members' rights asked for it again (#57-5): an account in that state is refused until it agrees
 * again. Reads the database on every request; a route whose write must not commit beside a change
 * of the state calls `assertOnboarded` in its transaction as well.
 *
 * Needs the `DB` provider in the module of the controller that uses it (DbModule).
 */
@Injectable()
export class OnboardedGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Only meaningful after SessionGuard; without a session this is a route wired wrongly, and
    // the answer is the one SessionGuard would have given.
    if (!request.auth) throw new AppError('UNAUTHENTICATED', { message: 'Sign in required' });
    await assertOnboarded(this.db, request.auth.user.id);
    return true;
  }
}
