import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { emptyMediaStore, emptyS3Bucket, runEmptyCli } from './empty.js';
import { DEFAULT_MEDIA_LOCAL_DIR, mediaStorageEnvShape } from './env.js';
import { type S3Sender } from './s3.js';
import * as z from 'zod';

/**
 * Emptying the media bucket for the database reset (deploy/reset-db.sh, docs/RESET.md; owner
 * decision 2026-10-19, ADR-0073), against a bucket kept in a sorted list of keys that answers the
 * two calls as S3 does: a listing of at most `MaxKeys` keys from a continuation token, and a
 * deletion of up to a thousand keys that names the ones it could not delete.
 */
function fakeBucket(keys: string[], refuse: ReadonlySet<string> = new Set()) {
  const objects = new Set(keys);
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: (command: { input: Record<string, unknown> }) => {
      calls.push({ name: command.constructor.name, input: command.input });
      expect(command.input.Bucket).toBe('buddha-media');
      if (command instanceof ListObjectsV2Command) {
        const sorted = [...objects].sort();
        const after = command.input.ContinuationToken;
        const from = after === undefined ? sorted : sorted.filter((key) => key > after);
        const max = command.input.MaxKeys as number;
        const page = from.slice(0, max);
        const truncated = from.length > max;
        return Promise.resolve({
          Contents: page.map((Key) => ({ Key })),
          IsTruncated: truncated,
          NextContinuationToken: truncated ? page.at(-1) : undefined,
        });
      }
      if (command instanceof DeleteObjectsCommand) {
        const named = (command.input.Delete as { Objects: { Key: string }[] }).Objects;
        expect(named.length).toBeLessThanOrEqual(1_000);
        const errors = [];
        for (const { Key } of named) {
          if (refuse.has(Key)) errors.push({ Key, Code: 'AccessDenied', Message: 'Access Denied' });
          else objects.delete(Key);
        }
        return Promise.resolve(errors.length > 0 ? { Errors: errors } : {});
      }
      return Promise.reject(new Error('unexpected command'));
    },
  } as unknown as S3Sender;
  return { client, objects, calls };
}

const keys = (count: number) =>
  Array.from({ length: count }, (_, i) => `post-images/${String(i).padStart(5, '0')}.webp`);

describe('emptyS3Bucket', () => {
  it('deletes every object, a page of a thousand at a time', async () => {
    const bucket = fakeBucket([...keys(2_345), 'profile-images/a.png', 'stray.txt']);
    expect(await emptyS3Bucket(bucket.client, 'buddha-media')).toBe(2_347);
    expect(bucket.objects.size).toBe(0);
    expect(bucket.calls.map((call) => call.name)).toEqual([
      'ListObjectsV2Command',
      'DeleteObjectsCommand',
      'ListObjectsV2Command',
      'DeleteObjectsCommand',
      'ListObjectsV2Command',
      'DeleteObjectsCommand',
    ]);
  });

  it('answers 0 for an empty bucket, deleting nothing', async () => {
    const bucket = fakeBucket([]);
    expect(await emptyS3Bucket(bucket.client, 'buddha-media')).toBe(0);
    expect(bucket.calls.map((call) => call.name)).toEqual(['ListObjectsV2Command']);
  });

  it('fails when S3 refuses a key, naming it', async () => {
    const bucket = fakeBucket(keys(3), new Set(['post-images/00001.webp']));
    await expect(emptyS3Bucket(bucket.client, 'buddha-media')).rejects.toThrow(
      /did not delete 1 of 3 objects \(first: post-images\/00001\.webp AccessDenied/,
    );
  });
});

/** The variables as the CLI reads them from the environment. */
function envOf(
  values: Record<string, string>,
  NODE_ENV: 'development' | 'test' | 'production' = 'production',
) {
  return { NODE_ENV, ...z.object(mediaStorageEnvShape).parse(values) };
}

describe('emptyMediaStore', () => {
  it('empties the bucket the variables name', async () => {
    const bucket = fakeBucket(keys(2));
    expect(
      await emptyMediaStore(
        envOf({ MEDIA_STORAGE: 's3', MEDIA_S3_BUCKET: 'buddha-media' }),
        bucket.client,
      ),
    ).toEqual({ kind: 'emptied', bucket: 'buddha-media', deleted: 2 });
    expect(bucket.objects.size).toBe(0);
  });

  it('skips a store with no bucket named, without touching S3', async () => {
    const bucket = fakeBucket(keys(2));
    expect(await emptyMediaStore(envOf({ MEDIA_STORAGE: 's3' }), bucket.client)).toEqual({
      kind: 'no_bucket',
    });
    // Unset, or empty as compose passes `${MEDIA_S3_BUCKET:-}`: the same. Production's driver is s3.
    expect(await emptyMediaStore(envOf({ MEDIA_S3_BUCKET: '' }), bucket.client)).toEqual({
      kind: 'no_bucket',
    });
    expect(bucket.calls).toEqual([]);
  });

  it('leaves the local directory alone', async () => {
    const bucket = fakeBucket(keys(2));
    expect(await emptyMediaStore(envOf({}, 'development'), bucket.client)).toEqual({
      kind: 'local',
      directory: DEFAULT_MEDIA_LOCAL_DIR,
    });
    expect(
      await emptyMediaStore(
        envOf({ MEDIA_STORAGE: 'local', MEDIA_LOCAL_DIR: '/tmp/media' }, 'test'),
        bucket.client,
      ),
    ).toEqual({ kind: 'local', directory: '/tmp/media' });
    expect(bucket.calls).toEqual([]);
  });
});

describe('runEmptyCli (empty-cli.ts, which deploy/reset-db.sh runs)', () => {
  /** The api container's variables as deploy/compose.yaml passes them before `terraform apply`. */
  const COMPOSE_BEFORE_APPLY = {
    NODE_ENV: 'production',
    MEDIA_STORAGE: 's3',
    MEDIA_S3_BUCKET: '',
    MEDIA_S3_REGION: '',
    MEDIA_S3_ACCESS_KEY_ID: '',
    MEDIA_S3_SECRET_ACCESS_KEY: '',
  };

  it('does nothing without --yes', async () => {
    const bucket = fakeBucket(keys(2));
    const outcome = await runEmptyCli(
      [],
      { ...COMPOSE_BEFORE_APPLY, MEDIA_S3_BUCKET: 'buddha-media' },
      bucket.client,
    );
    expect(outcome.code).toBe(1);
    expect(outcome.err).toEqual([
      '[media:empty] this deletes every object in the media bucket; pass --yes to run it',
    ]);
    expect(outcome.out).toEqual([]);
    expect(bucket.calls).toEqual([]);
    expect(bucket.objects.size).toBe(2);
  });

  it('skips, and succeeds, where compose passes no bucket (answer 7: the reset goes on)', async () => {
    const bucket = fakeBucket(keys(2));
    const outcome = await runEmptyCli(['--yes'], COMPOSE_BEFORE_APPLY, bucket.client);
    expect(outcome).toEqual({
      code: 0,
      out: ['[media:empty] MEDIA_S3_BUCKET is not set: no bucket to empty, skipped'],
      err: [],
    });
    expect(bucket.calls).toEqual([]);
  });

  it('empties the bucket the api’s variables name, and says how many objects went', async () => {
    const bucket = fakeBucket(keys(3));
    const outcome = await runEmptyCli(
      ['--yes'],
      {
        ...COMPOSE_BEFORE_APPLY,
        MEDIA_S3_BUCKET: 'buddha-media',
        MEDIA_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        MEDIA_S3_SECRET_ACCESS_KEY: 'secret',
      },
      bucket.client,
    );
    expect(outcome).toEqual({
      code: 0,
      out: ['[media:empty] deleted 3 objects from buddha-media'],
      err: [],
    });
    expect(bucket.objects.size).toBe(0);
  });

  it('leaves the local directory alone, and refuses variables the api would refuse', async () => {
    const bucket = fakeBucket(keys(1));
    const local = await runEmptyCli(
      ['--yes'],
      { NODE_ENV: 'development', MEDIA_LOCAL_DIR: '/tmp/media' },
      bucket.client,
    );
    expect(local.code).toBe(0);
    expect(local.out).toEqual([
      '[media:empty] MEDIA_STORAGE is local: no bucket to empty, skipped (the directory /tmp/media is left as it is)',
    ]);
    const halfKey = await runEmptyCli(
      ['--yes'],
      { ...COMPOSE_BEFORE_APPLY, MEDIA_S3_BUCKET: 'buddha-media', MEDIA_S3_ACCESS_KEY_ID: 'AKIA' },
      bucket.client,
    );
    expect(halfKey.code).toBe(1);
    expect(halfKey.err).toEqual([
      '[media:empty] MEDIA_S3_ACCESS_KEY_ID: MEDIA_S3_ACCESS_KEY_ID and MEDIA_S3_SECRET_ACCESS_KEY must be set together',
    ]);
    const unknown = await runEmptyCli(['--yes'], { MEDIA_STORAGE: 'ftp' }, bucket.client);
    expect(unknown.code).toBe(1);
    expect(unknown.err[0]).toMatch(/^\[media:empty\] the media store's variables are invalid/);
    expect(bucket.calls).toEqual([]);
    expect(bucket.objects.size).toBe(1);
  });
});
