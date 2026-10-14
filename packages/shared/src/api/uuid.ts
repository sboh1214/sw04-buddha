import * as z from 'zod';

/**
 * A uuid the request supplies — a body field or a path parameter — lower-cased on the way in.
 *
 * `z.uuid()` accepts either case and Postgres compares a `uuid` column the same way, so an
 * upper-case id reads the right row. Wherever the id is kept as a string, though, it would
 * no longer be the row's id: the terms a same-key replay compares against the stored row
 * (409 for the very same request), `hashtext()` under the market lock (another lock than every
 * other writer of that market), the Redis channel a write publishes to (one nobody listens
 * on). One canonical form at the boundary keeps every such comparison honest. A zod 4
 * overwrite keeps the type and the JSON Schema of `z.uuid()`, so the OpenAPI document and the
 * generated client are unchanged.
 */
export const uuidSchema = z.uuid('must be a uuid').toLowerCase();
