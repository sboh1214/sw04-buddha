import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { ROLES, type Role } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { type Redis } from 'ioredis';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { REDIS } from '../infra/redis/redis.provider.js';
import { type AuthenticatedRequest } from './session.guard.js';

/** PLAN 10.5: role lookups are cached for 60 s. */
export const ROLE_CACHE_TTL_SECONDS = 60;
export const roleCacheKey = (userId: string): string => `role:${userId}`;

const KNOWN_ROLES: ReadonlySet<string> = new Set<Role>(ROLES);

/**
 * Allows only `profiles.role = 'admin'`. Must run after SessionGuard (use
 * `@UseGuards(SessionGuard, AdminGuard)`; Nest evaluates guards in order).
 * Redis is a cache only: on any Redis error the role is read from Postgres.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.auth?.user.id;
    if (!userId) throw new AppError('UNAUTHENTICATED', { message: 'Sign in required' });
    const role = await this.roleOf(userId);
    if (role !== 'admin') throw new AppError('FORBIDDEN', { message: 'Admin only' });
    return true;
  }

  /** Cached role lookup; `undefined` when the user has no profile row. */
  async roleOf(userId: string): Promise<Role | undefined> {
    const key = roleCacheKey(userId);
    let cacheDown = false;
    try {
      const cached = await this.redis.get(key);
      if (cached !== null && KNOWN_ROLES.has(cached)) return cached as Role;
    } catch (error) {
      cacheDown = true;
      this.logger.warn(`role cache read failed: ${String(error)}`);
    }

    const [row] = await this.db
      .select({ role: schema.profiles.role })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId))
      .limit(1);
    if (!row) return undefined;

    // A read that failed (a Redis that stopped answering: the client's command timeout) is
    // not followed by a write that would fail the same way — one bound per request, not two.
    // NX: a role change that committed while this read was in flight writes its role with
    // `cacheRole`, and this older answer must not replace it.
    if (!cacheDown) {
      try {
        await this.redis.set(key, row.role, 'EX', ROLE_CACHE_TTL_SECONDS, 'NX');
      } catch (error) {
        this.logger.warn(`role cache write failed: ${String(error)}`);
      }
    }
    return row.role;
  }

  /**
   * Writes the role a committed change set (#171: a grant or revoke), over whatever the cache
   * holds, so the change applies from the next request. A write rather than a delete: a request
   * that read the old role from Postgres before the change committed would otherwise put it
   * back for 60 s (`roleOf` only fills an empty key).
   */
  async cacheRole(userId: string, role: Role): Promise<void> {
    await this.redis.set(roleCacheKey(userId), role, 'EX', ROLE_CACHE_TTL_SECONDS);
  }

  /** Call after changing profiles.role directly (tests) so the change applies at once. */
  async invalidate(userId: string): Promise<void> {
    await this.redis.del(roleCacheKey(userId));
  }
}
