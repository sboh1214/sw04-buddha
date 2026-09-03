/**
 * better-auth throws `APIError` (from better-call) with `{ statusCode, body: { code } }`.
 * Its instances cross package boundaries, so the checks here are structural rather than
 * `instanceof`.
 */
export interface BetterAuthApiError {
  statusCode: number;
  body?: { code?: string; message?: string };
}

export function isApiError(error: unknown, code?: string): error is BetterAuthApiError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { statusCode?: unknown; body?: { code?: unknown } };
  if (typeof candidate.statusCode !== 'number') return false;
  if (code === undefined) return true;
  return candidate.body?.code === code;
}
