import createClient, { type Client, type ClientOptions } from 'openapi-fetch';
import type { paths } from './generated/schema.js';

// Generated OpenAPI types (paths, components, operations, ...).
export type * from './generated/schema.js';
// Domain types shared with the API (PLAN 4.1: api-client re-exports shared's types).
export type * from '@buddha/shared';

/** openapi-fetch client typed against the buddha API paths. */
export type ApiClient = Client<paths>;

export interface ApiClientOptions extends ClientOptions {
  /**
   * "/api" in the browser (Next.js rewrites it to NEXT_PUBLIC_API_URL),
   * an absolute URL on the server / in tests.
   */
  baseUrl: string;
}

/**
 * Creates a typed client. Auth is cookie based (better-auth), so callers in the browser
 * should pass `credentials: "include"` when the API is on another origin.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  return createClient<paths>(options);
}
