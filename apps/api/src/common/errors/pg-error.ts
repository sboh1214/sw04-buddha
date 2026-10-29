/** SQLSTATE codes the API reacts to. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
/** A trigger's refusal (RAISE … USING ERRCODE = 'integrity_constraint_violation'). */
export const PG_INTEGRITY_CONSTRAINT_VIOLATION = '23000';

interface PgErrorShape {
  code: string;
  constraint?: string;
}

function hasPgShape(value: unknown): value is PgErrorShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    (value as { code: string }).code.length === 5
  );
}

/**
 * Finds the node-postgres DatabaseError behind an error. drizzle-orm 0.45 throws
 * `DrizzleQueryError` and keeps the driver error in `cause`, so both levels are checked.
 */
export function findPgError(error: unknown): PgErrorShape | undefined {
  if (hasPgShape(error)) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return hasPgShape(cause) ? cause : undefined;
}

/** True when `error` is a Postgres error with `code` (and, if given, that constraint name). */
export function isPgError(error: unknown, code: string, constraint?: string): boolean {
  const pg = findPgError(error);
  if (!pg || pg.code !== code) return false;
  return constraint === undefined || pg.constraint === constraint;
}
