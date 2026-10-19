/**
 * Object storage behind one interface (#46, ADR-0073): the bytes of the post images — and of the
 * profile images #141 adds to the same store (ADR-0069 decision 3 #37-6) — that the API received,
 * checked and converted. The database keeps what an object is (`media_objects`: its owner, its
 * type, its size, where it is attached); the store keeps only the bytes under a key the API made.
 *
 * Nothing outside the API and the worker reaches the store: the bucket is private, the browser
 * never writes to it, and every public read goes through the API, which serves an object only
 * while what it belongs to may be shown (a hidden or deleted post's images stop being served).
 *
 * Drivers: `s3` (the private bucket of a deployment), `local` (a directory, for development and
 * the e2e suite, where the API and the worker of one checkout share it), `memory` (the API's and
 * the worker's test suites) and `unconfigured` (a deployment whose bucket is not set yet: it
 * starts, and every upload fails rather than the API refusing to boot — the precedent of 알리고
 * without keys, ADR-0070).
 */
export interface ObjectStorage {
  /** Which driver this is, for the boot log and the health of a deployment. */
  readonly driver: 'local' | 's3' | 'memory' | 'unconfigured';
  /** Writes `body` under `key`, replacing whatever was there. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** The bytes under `key`, or null when there is no such object. */
  get(key: string): Promise<Uint8Array | null>;
  /** Removes the object under `key`; a key with no object is not an error. */
  delete(key: string): Promise<void>;
}

/**
 * The keys the API makes: a lower-case prefix naming what the object is, a slash, and a file name
 * of lower-case letters, digits, dots and hyphens (`post-images/<uuid>.webp`). Every driver
 * refuses any other key, so a key can never climb out of the local directory (`..`, an absolute
 * path, a backslash) nor name an object outside the API's own prefixes in the bucket.
 */
export const OBJECT_KEY_PATTERN =
  /^[a-z][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9-]{0,99}(\.[a-z0-9]{1,8})?$/;

/** Throws unless `key` is one the API makes (OBJECT_KEY_PATTERN). */
export function assertObjectKey(key: string): void {
  if (!OBJECT_KEY_PATTERN.test(key)) {
    throw new Error(`Not an object key this store takes: ${JSON.stringify(key)}`);
  }
}
