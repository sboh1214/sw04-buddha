import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertObjectKey, type ObjectStorage } from './object-storage.js';

/** Whether `error` is the file system's "no such file". */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * A directory as the store: development and the e2e suite, where the API writes an upload and
 * the worker of the same checkout removes an orphan (both resolve the same directory,
 * `MEDIA_LOCAL_DIR` or its default). An object is the file `<root>/<key>`; the key's shape
 * (OBJECT_KEY_PATTERN) keeps it inside the root. Never production: the environment schema of a
 * production process refuses this driver.
 *
 * A write goes to a temporary name first and is renamed into place, so a reader never sees half
 * a file and a crash leaves at worst a stray `.tmp-*` file beside the objects.
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly driver = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private pathOf(key: string): string {
    assertObjectKey(key);
    return path.join(this.root, key);
  }

  // The type is the database's (`media_objects.content_type`); a file needs none.
  async put(key: string, body: Uint8Array, _contentType: string): Promise<void> {
    const target = this.pathOf(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${randomUUID()}`;
    await writeFile(temporary, body);
    await rename(temporary, target);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathOf(key)));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}
