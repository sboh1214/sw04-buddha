import { uuidSchema } from './uuid.js';

/**
 * A uuid path parameter, for `@Param('id', { schema: uuidParamSchema })`.
 *
 * Validation here is not decoration. Every id column that is not a better-auth user id is a
 * Postgres `uuid`, so an unvalidated string reaches `where id = $1` and the server raises
 * SQLSTATE 22P02 — a driver error, which the exception filter can only render as 500
 * INTERNAL. The request is malformed, so PLAN 7.4 wants 400 VALIDATION_ERROR. Lower-cased
 * like every request-supplied uuid (see uuid.ts).
 */
export const uuidParamSchema = uuidSchema;
