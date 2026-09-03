import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import { type FastifyRequest } from 'fastify';
import { AppError } from '../common/errors/app-error.js';
import { AUTH, type Auth, type SessionData } from './auth.js';

/** Fastify request after SessionGuard ran. */
export type AuthenticatedRequest = FastifyRequest & { auth?: SessionData };

/**
 * Resolves the better-auth session from the request cookies and attaches it as
 * `request.auth` for @CurrentUser()/@CurrentSession(). No session -> 401 with the PLAN 7
 * error envelope (AppError, rendered by ApiExceptionFilter). Apply with
 * `@UseGuards(SessionGuard)` on controllers that need a user; public routes (PLAN 7.1)
 * simply do not use it.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) throw new AppError('UNAUTHENTICATED', { message: 'Sign in required' });
    request.auth = session;
    return true;
  }
}
