import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from '@buddha/shared';
import { type FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error.js';

/**
 * The request's `Idempotency-Key` header (PLAN 5.4), validated, for a route that moves money.
 *
 * A custom decorator rather than `@Headers()`: Nest 12's Standard Schema support covers body,
 * query and path through their `{ schema }` option, but `@Headers` takes none, and the global
 * pipe skips custom decorators (`validateCustomDecorators: false`), so the check lives here.
 * Missing or malformed is a 400 VALIDATION_ERROR that names the header, the way a bad body
 * field is named.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    // Node lower-cases incoming header names.
    const raw = request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
    const parsed = idempotencyKeySchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', {
        message: `${IDEMPOTENCY_KEY_HEADER} header is required`,
        details: [
          {
            path: [IDEMPOTENCY_KEY_HEADER],
            message: parsed.error.issues[0]?.message ?? 'invalid',
          },
        ],
      });
    }
    return parsed.data;
  },
);
