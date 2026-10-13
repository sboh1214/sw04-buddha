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
 *
 * The cache only ever refuses (#171): a cached `user` is answered from Redis, a cached `admin`
 * never is — every admin answer is a Postgres read made by that request, after SessionGuard
 * found its session. So no cache entry, however stale, can let a revoked account in: not the
 * `admin` a revoke leaves in the cache (it writes nothing there), not on a session signed in
 * after the revoke. The cost is one primary-key read per admin request, beside SessionGuard's
 * own session read.
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

  /**
   * The role, from the cache only when it refuses; `undefined` when the user has no profile row.
   */
  async roleOf(userId: string): Promise<Role | undefined> {
    const key = roleCacheKey(userId);
    let cacheDown = false;
    let cached: string | null = null;
    try {
      cached = await this.redis.get(key);
      if (cached !== null && cached !== 'admin' && KNOWN_ROLES.has(cached)) return cached as Role;
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
    // Only an empty key is filled, and with NX: a role change that committed while this read was
    // in flight writes its role with `cacheRole`, and this older answer must not replace it.
    if (!cacheDown && cached === null) {
      try {
        await this.redis.set(key, row.role, 'EX', ROLE_CACHE_TTL_SECONDS, 'NX');
      } catch (error) {
        this.logger.warn(`role cache write failed: ${String(error)}`);
      }
    }
    return row.role;
  }

  /**
   * Writes the role a committed grant set (#171), over whatever the cache holds. A write rather
   * than a delete: a request that read `user` from Postgres before the grant committed would
   * otherwise put it back for 60 s (`roleOf` only fills an empty key), and the new admin would be
   * refused that long. A revoke calls nothing here: a cached `admin` is never answered, and a
   * revoke's write landing after a later grant's would refuse that admin (a `user`) or let such
   * a stale `user` back in (a delete).
   */
  async cacheRole(userId: string, role: Role): Promise<void> {
    await this.redis.set(roleCacheKey(userId), role, 'EX', ROLE_CACHE_TTL_SECONDS);
  }

  /** Call after changing profiles.role directly (tests) so the change applies at once. */
  async invalidate(userId: string): Promise<void> {
    await this.redis.del(roleCacheKey(userId));
  }
}
