import { StandardSchemaValidationPipe } from '@nestjs/common';
import { type ValidationIssue } from '@buddha/shared';
import { type StandardSchemaV1 } from '@standard-schema/spec';
import { AppError } from '../errors/app-error.js';

/** Standard Schema paths may contain `{ key }` segments; flatten to strings/numbers. */
export function toValidationIssue(issue: StandardSchemaV1.Issue): ValidationIssue {
  const path = (issue.path ?? []).map((segment) => {
    const key = typeof segment === 'object' && segment !== null ? segment.key : segment;
    return typeof key === 'number' ? key : String(key);
  });
  return { path, message: issue.message };
}

/**
 * Nest 12's built-in Standard Schema pipe, configured for PLAN 7:
 * - schemas come from `@Body({ schema })` / `@Query({ schema })` / `@Param(name, { schema })`
 *   (zod objects from packages/shared), no class-validator anywhere;
 * - `transform: true` returns the parsed value (defaults, coercion, bigint transforms);
 * - failures become AppError VALIDATION_ERROR with `details: ValidationIssue[]`;
 * - custom param decorators (@CurrentUser) are not validated.
 */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    transform: true,
    validateCustomDecorators: false,
    exceptionFactory: (issues) =>
      new AppError('VALIDATION_ERROR', {
        message: 'Request validation failed',
        details: issues.map(toValidationIssue),
      }),
  });
}
