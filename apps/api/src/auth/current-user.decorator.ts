import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { AppError } from '../common/errors/app-error.js';
import { type SessionData, type SessionUser } from './auth.js';
import { type AuthenticatedRequest } from './session.guard.js';

function authOf(context: ExecutionContext): SessionData {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  // Only meaningful behind SessionGuard; without it the handler fails loudly instead of
  // receiving `undefined`.
  if (!request.auth) throw new AppError('UNAUTHENTICATED', { message: 'Sign in required' });
  return request.auth;
}

/** The better-auth user of the current request. Requires SessionGuard on the route. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionUser => authOf(context).user,
);

/** The full `{ session, user }` pair. Requires SessionGuard on the route. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionData => authOf(context),
);
