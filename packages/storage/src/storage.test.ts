import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MEDIA_LOCAL_DIR,
  createObjectStorage,
  mediaStorageDriver,
  mediaStorageEnvIssues,
  mediaStorageEnvShape,
  type MediaStorageEnv,
} from './env.js';
import { LocalObjectStorage } from './local.js';
import { MemoryObjectStorage } from './memory.js';
import { OBJECT_KEY_PATTERN, assertObjectKey, type ObjectStorage } from './object-storage.js';
import { S3ObjectStorage, type S3Sender } from './s3.js';
import { STORAGE_UNCONFIGURED_MESSAGE, UnconfiguredObjectStorage } from './unconfigured.js';
import * as z from 'zod';

const KEY = 'post-images/0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60.webp';
const bytes = (...values: number[]) => new Uint8Array(values);

describe('object keys', () => {
  it('takes the keys the API makes', () => {
    for (const key of [KEY, 'profile-images/abc.png', 'post-images/x', 'a/b.gif']) {
      expect(OBJECT_KEY_PATTERN.test(key), key).toBe(true);
    }
  });

  it('refuses a key that could leave the directory or the prefixes', () => {
    for (const key of [
      '../etc/passwd',
      'post-images/../../x',
      '/abs/path',
      'post-images/..',
      'post-images\\x',
      'Post-Images/x',
      'post-images/a/b',
      'post-images/',
      '',
      'post-images/.hidden',
      'post-images/a.b.c',
    ]) {
      expect(() => assertObjectKey(key), key).toThrow(/Not an object key/);
    }
  });
});

/** The same behaviour from every driver that keeps bytes. */
async function roundTrip(storage: ObjectStorage): Promise<void> {
  expect(await storage.get(KEY)).toBeNull();
  await storage.put(KEY, bytes(1, 2, 3), 'image/webp');
  expect(await storage.get(KEY)).toEqual(bytes(1, 2, 3));
  await storage.put(KEY, bytes(9), 'image/webp');
  expect(await storage.get(KEY)).toEqual(bytes(9));
  await storage.delete(KEY);
  expect(await storage.get(KEY)).toBeNull();
  // A key with no object is not an error.
  await storage.delete(KEY);
  await expect(storage.put('../x', bytes(1), 'image/png')).rejects.toThrow(/Not an object key/);
  await expect(storage.get('../x')).rejects.toThrow(/Not an object key/);
  await expect(storage.delete('../x')).rejects.toThrow(/Not an object key/);
}

describe('LocalObjectStorage', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'media-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps an object as a file under its key, written whole', async () => {
    const storage = new LocalObjectStorage(root);
    expect(storage.driver).toBe('local');
    await roundTrip(storage);
    await storage.put(KEY, bytes(7, 7), 'image/webp');
    // No temporary file is left beside the object.
    expect(readdirSync(path.join(root, 'post-images'))).toEqual([path.basename(KEY)]);
  });

  it('gives a read up when its signal is aborted', async () => {
    const storage = new LocalObjectStorage(root);
    await storage.put(KEY, bytes(1), 'image/webp');
    await expect(storage.get(KEY, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(await storage.get(KEY, { signal: new AbortController().signal })).toEqual(bytes(1));
  });

  it('copies nothing it was not asked to: a caller changing its buffer later changes nothing', async () => {
    const storage = new LocalObjectStorage(root);
    const body = bytes(1, 2);
    await storage.put(KEY, body, 'image/webp');
    body[0] = 5;
    expect(await storage.get(KEY)).toEqual(bytes(1, 2));
  });
});

describe('MemoryObjectStorage', () => {
  it('keeps objects in a map a test can read, copied in and out', async () => {
    const storage = new MemoryObjectStorage();
    expect(storage.driver).toBe('memory');
    await roundTrip(storage);
    const body = bytes(4, 5);
    await storage.put(KEY, body, 'image/png');
    body[0] = 0;
    expect(storage.objects.get(KEY)).toEqual({ body: bytes(4, 5), contentType: 'image/png' });
    const read = await storage.get(KEY);
    read![0] = 0;
    expect(await storage.get(KEY)).toEqual(bytes(4, 5));
    await expect(storage.get(KEY, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('S3ObjectStorage', () => {
  /** A client that answers from a map, as S3 would, and records every command. */
  function fakeS3() {
    const objects = new Map<string, Uint8Array>();
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = {
      send: (command: { input: Record<string, unknown> }) => {
        sent.push({ name: command.constructor.name, input: command.input });
        const key = command.input.Key as string;
        if (command instanceof PutObjectCommand) {
          objects.set(key, command.input.Body as Uint8Array);
          return Promise.resolve({});
        }
        if (command instanceof GetObjectCommand) {
          const body = objects.get(key);
          if (!body) {
            return Promise.reject(new NoSuchKey({ message: 'nope', $metadata: {} }));
          }
          return Promise.resolve({ Body: { transformToByteArray: () => Promise.resolve(body) } });
        }
        if (command instanceof DeleteObjectCommand) {
          objects.delete(key);
          return Promise.resolve({});
        }
        return Promise.reject(new Error('unexpected command'));
      },
    } as unknown as S3Sender;
    return { client, sent };
  }

  it('puts, gets and deletes in its bucket, and reads a missing key as no object', async () => {
    const { client, sent } = fakeS3();
    const storage = new S3ObjectStorage(client, 'buddha-media');
    expect(storage.driver).toBe('s3');
    await roundTrip(storage);
    expect(sent[1]).toEqual({
      name: 'PutObjectCommand',
      input: { Bucket: 'buddha-media', Key: KEY, Body: bytes(1, 2, 3), ContentType: 'image/webp' },
    });
    expect(new Set(sent.map((entry) => entry.input.Bucket))).toEqual(new Set(['buddha-media']));
  });

  /** A client whose every command fails with `error`. */
  const failing = (error: Error) => ({ send: () => Promise.reject(error) }) as unknown as S3Sender;
  /** An S3 service error as the SDK makes it: a name and the HTTP status. */
  const s3Error = (name: string, status: number) =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  it('reads only S3’s NoSuchKey as no object, and passes every other failure on — another 404 too', async () => {
    // NoSuchKey by its name too: an error another copy of the SDK made is not this one's class.
    expect(
      await new S3ObjectStorage(failing(s3Error('NoSuchKey', 404)), 'b-1').get(KEY),
    ).toBeNull();
    const empty = { send: () => Promise.resolve({}) } as unknown as S3Sender;
    expect(await new S3ObjectStorage(empty, 'b-1').get(KEY)).toBeNull();
    // A wrong or removed bucket is the store failing, not every image missing.
    await expect(
      new S3ObjectStorage(failing(s3Error('NoSuchBucket', 404)), 'b-1').get(KEY),
    ).rejects.toThrow('NoSuchBucket');
    await expect(
      new S3ObjectStorage(failing(s3Error('NotFound', 404)), 'b-1').get(KEY),
    ).rejects.toThrow('NotFound');
    await expect(
      new S3ObjectStorage(failing(s3Error('AccessDenied', 403)), 'b-1').get(KEY),
    ).rejects.toThrow('AccessDenied');
  });

  it('gives a read up when its signal is aborted: the request, and a body still streaming in', async () => {
    const body = new PassThrough();
    const options: unknown[] = [];
    const client = {
      send: (_command: unknown, sendOptions: unknown) => {
        options.push(sendOptions);
        return Promise.resolve({
          Body: Object.assign(body, {
            transformToByteArray: () =>
              new Promise<Uint8Array>((resolve, reject) => {
                const chunks: Buffer[] = [];
                body.on('data', (chunk: Buffer) => chunks.push(chunk));
                body.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
                body.on('error', reject);
              }),
          }),
        });
      },
    } as unknown as S3Sender;
    const storage = new S3ObjectStorage(client, 'b-1');
    const gone = new AbortController();
    const reading = storage.get(KEY, { signal: gone.signal });
    await vi.waitFor(() => {
      expect(options).toHaveLength(1);
    });
    // The SDK gets the signal for the request itself.
    expect(options[0]).toEqual({ abortSignal: gone.signal });
    body.write(Buffer.from([1, 2]));
    gone.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(body.destroyed).toBe(true);
    // A read given up before it starts sends nothing.
    await expect(storage.get(KEY, { signal: gone.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    // Without a signal, the body is read whole as before.
    const plain = {
      send: () =>
        Promise.resolve({
          Body: { transformToByteArray: () => Promise.resolve(bytes(3, 4)) },
        }),
    } as unknown as S3Sender;
    expect(await new S3ObjectStorage(plain, 'b-1').get(KEY)).toEqual(bytes(3, 4));
  });
});

describe('UnconfiguredObjectStorage', () => {
  it('refuses every write and finds nothing', async () => {
    const storage = new UnconfiguredObjectStorage();
    expect(storage.driver).toBe('unconfigured');
    await expect(storage.put(KEY, bytes(1), 'image/png')).rejects.toThrow(
      STORAGE_UNCONFIGURED_MESSAGE,
    );
    await expect(storage.delete(KEY)).rejects.toThrow(STORAGE_UNCONFIGURED_MESSAGE);
    expect(await storage.get(KEY)).toBeNull();
    await expect(storage.get('../x')).rejects.toThrow(/Not an object key/);
  });
});

describe('the media store’s environment', () => {
  const schema = z.object(mediaStorageEnvShape);
  const parse = (values: Record<string, string>) => schema.parse(values);
  type NodeEnv = 'development' | 'test' | 'production';
  const withEnv = (env: MediaStorageEnv, NODE_ENV: NodeEnv) => ({ ...env, NODE_ENV });

  it('reads empty values as unset and refuses an unknown driver', () => {
    expect(parse({ MEDIA_STORAGE: '', MEDIA_S3_BUCKET: ' ' })).toEqual({
      MEDIA_STORAGE: undefined,
      MEDIA_LOCAL_DIR: undefined,
      MEDIA_S3_BUCKET: undefined,
      MEDIA_S3_REGION: undefined,
      MEDIA_S3_ACCESS_KEY_ID: undefined,
      MEDIA_S3_SECRET_ACCESS_KEY: undefined,
    });
    expect(schema.safeParse({ MEDIA_STORAGE: 'ftp' }).success).toBe(false);
  });

  it('defaults to the bucket in production and the directory elsewhere', () => {
    expect(mediaStorageDriver({ NODE_ENV: 'production' })).toBe('s3');
    expect(mediaStorageDriver({ NODE_ENV: 'development' })).toBe('local');
    expect(mediaStorageDriver({ NODE_ENV: 'test' })).toBe('local');
    expect(mediaStorageDriver({ NODE_ENV: 'test', MEDIA_STORAGE: 's3' })).toBe('s3');
  });

  it('refuses the directory in production, half an access key and a bad bucket name', () => {
    expect(mediaStorageEnvIssues(withEnv(parse({ MEDIA_STORAGE: 'local' }), 'production'))).toEqual(
      [expect.objectContaining({ path: 'MEDIA_STORAGE' })],
    );
    expect(
      mediaStorageEnvIssues(withEnv(parse({ MEDIA_STORAGE: 'local' }), 'development')),
    ).toEqual([]);
    expect(
      mediaStorageEnvIssues(withEnv(parse({ MEDIA_S3_ACCESS_KEY_ID: 'AKIA' }), 'production')),
    ).toEqual([expect.objectContaining({ path: 'MEDIA_S3_ACCESS_KEY_ID' })]);
    expect(
      mediaStorageEnvIssues(withEnv(parse({ MEDIA_S3_BUCKET: 'Bad_Bucket' }), 'production')),
    ).toEqual([expect.objectContaining({ path: 'MEDIA_S3_BUCKET' })]);
    expect(
      mediaStorageEnvIssues(
        withEnv(
          parse({
            MEDIA_S3_BUCKET: 'tf-buddha-prod-media',
            MEDIA_S3_ACCESS_KEY_ID: 'AKIA',
            MEDIA_S3_SECRET_ACCESS_KEY: 'secret',
          }),
          'production',
        ),
      ),
    ).toEqual([]);
  });

  it('builds the store the variables describe', () => {
    const local = createObjectStorage(withEnv(parse({}), 'development'));
    expect(local).toBeInstanceOf(LocalObjectStorage);
    expect(DEFAULT_MEDIA_LOCAL_DIR.endsWith(`${path.sep}.media`)).toBe(true);
    expect(createObjectStorage(withEnv(parse({}), 'production'))).toBeInstanceOf(
      UnconfiguredObjectStorage,
    );
    expect(
      createObjectStorage(
        withEnv(parse({ MEDIA_S3_BUCKET: 'tf-buddha-prod-media' }), 'production'),
      ),
    ).toBeInstanceOf(S3ObjectStorage);
    expect(
      createObjectStorage(
        withEnv(
          parse({
            MEDIA_S3_BUCKET: 'tf-buddha-prod-media',
            MEDIA_S3_ACCESS_KEY_ID: 'AKIA',
            MEDIA_S3_SECRET_ACCESS_KEY: 'secret',
          }),
          'production',
        ),
      ).driver,
    ).toBe('s3');
  });
});
