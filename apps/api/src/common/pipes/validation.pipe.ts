import { StandardSchemaValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { type ValidationIssue } from '@buddha/shared';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { AppError } from '../errors/app-error.js';

/** Standard Schema paths may contain `{ key }` segments; flatten to strings/numbers. */
export function toValidationIssue(issue: StandardSchemaV1.Issue): ValidationIssue {
  const path = (issue.path ?? []).map((segment) => {
    const key = typeof segment === 'object' && segment !== null ? segment.key : segment;
    return typeof key === 'number' ? key : String(key);
  });
  return { path, message: issue.message };
}

/** The message every NUL issue carries (one shape, whatever the field). */
export const NUL_MESSAGE = 'must not contain NUL';

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Paths of every string containing U+0000 inside `value` (strings, arrays and plain objects
 * are walked; bigint, Date, Buffer and other class instances are left alone). Postgres
 * rejects NUL in `text` (SQLSTATE 22021) and in `jsonb` (22P05), so a request that carries
 * one must fail as bad input at the door, not as a 500 from the driver.
 */
export function findNulPaths(
  value: unknown,
  path: readonly (string | number)[] = [],
): (string | number)[][] {
  if (typeof value === 'string') return value.includes('\u0000') ? [[...path]] : [];
  if (typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findNulPaths(item, [...path, index]));
  }
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => findNulPaths(item, [...path, key]));
}

/**
 * Nest 12's built-in Standard Schema pipe plus a NUL sweep: once the schema has accepted a
 * body/query/param, any string still carrying U+0000 is refused through the same
 * `exceptionFactory`, with one issue per offending path. Custom decorators (@CurrentUser,
 * @IdempotencyKey) are not swept, like they are not validated.
 */
export class ApiValidationPipe extends StandardSchemaValidationPipe {
  override async transform<T = unknown>(value: T, metadata: ArgumentMetadata): Promise<T> {
    const parsed = await super.transform(value, metadata);
    if (!this.toValidate(metadata)) return parsed;
    const offending = findNulPaths(parsed);
    if (offending.length > 0) {
      throw this.exceptionFactory(offending.map((path) => ({ path, message: NUL_MESSAGE })));
    }
    return parsed;
  }
}

/**
 * The global pipe, configured for PLAN 7:
 * - schemas come from `@Body({ schema })` / `@Query({ schema })` / `@Param(name, { schema })`
 *   (zod objects from packages/shared), no class-validator anywhere;
 * - `transform: true` returns the parsed value (defaults, coercion, bigint transforms);
 * - failures become AppError VALIDATION_ERROR with `details: ValidationIssue[]`;
 * - custom param decorators (@CurrentUser) are not validated;
 * - no accepted string may contain NUL (see ApiValidationPipe).
 */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new ApiValidationPipe({
    transform: true,
    validateCustomDecorators: false,
    exceptionFactory: (issues) =>
      new AppError('VALIDATION_ERROR', {
        message: 'Request validation failed',
        details: issues.map(toValidationIssue),
      }),
  });
}
