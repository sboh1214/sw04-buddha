import { assertObjectKey, type ObjectStorage } from './object-storage.js';

/** The message every refusal of the unconfigured store carries. */
export const STORAGE_UNCONFIGURED_MESSAGE =
  'Media storage is not configured: set MEDIA_S3_BUCKET (and MEDIA_S3_REGION)';

/**
 * A deployment whose bucket is not set yet (the owner runs `terraform apply`, ADR-0069 결과 3):
 * the API and the worker start, every write throws — an upload fails as a 500 — and a read finds
 * nothing, as no object can have been written. The precedent is 알리고 without keys (ADR-0070): a
 * missing piece of a deployment fails the feature that needs it, not the whole service.
 */
export class UnconfiguredObjectStorage implements ObjectStorage {
  readonly driver = 'unconfigured';

  put(key: string, _body: Uint8Array, _contentType: string): Promise<void> {
    return new Promise((_, reject) => {
      assertObjectKey(key);
      reject(new Error(STORAGE_UNCONFIGURED_MESSAGE));
    });
  }

  get(key: string): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      assertObjectKey(key);
      resolve(null);
    });
  }

  delete(key: string): Promise<void> {
    return new Promise((_, reject) => {
      assertObjectKey(key);
      reject(new Error(STORAGE_UNCONFIGURED_MESSAGE));
    });
  }
}
