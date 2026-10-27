import { assertObjectKey, type ObjectReadOptions, type ObjectStorage } from './object-storage.js';

/** One object a MemoryObjectStorage holds. */
export interface MemoryObject {
  readonly body: Uint8Array;
  readonly contentType: string;
}

/**
 * `run` once `key` is one the store takes, as a promise: a refused key rejects like a failed call
 * of a real driver, never throws at the caller.
 */
function withKey<T>(key: string, run: () => T): Promise<T> {
  return new Promise((resolve) => {
    assertObjectKey(key);
    resolve(run());
  });
}

/**
 * The store of the API's and the worker's test suites: objects in a map a test can read
 * (`objects`) to see what an upload wrote or a cleanup removed. Copies on the way in and out, so
 * a caller that changes its buffer afterwards changes nothing stored. Takes the same keys as the
 * real drivers.
 */
export class MemoryObjectStorage implements ObjectStorage {
  readonly driver = 'memory';
  readonly objects = new Map<string, MemoryObject>();

  put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    return withKey(key, () => {
      this.objects.set(key, { body: new Uint8Array(body), contentType });
    });
  }

  /** Answers at once, so there is nothing to give up — except a read already given up. */
  get(key: string, options: ObjectReadOptions = {}): Promise<Uint8Array | null> {
    return withKey(key, () => {
      options.signal?.throwIfAborted();
      const object = this.objects.get(key);
      return object ? new Uint8Array(object.body) : null;
    });
  }

  delete(key: string): Promise<void> {
    return withKey(key, () => {
      this.objects.delete(key);
    });
  }
}
