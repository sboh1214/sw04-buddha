import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as z from 'zod';
import {
  DEFAULT_MEDIA_LOCAL_DIR,
  DEFAULT_MEDIA_S3_REGION,
  type MediaStorageEnv,
  mediaStorageDriver,
  mediaStorageEnvIssues,
  mediaStorageEnvShape,
} from './env.js';
import { createS3Client, type S3Sender } from './s3.js';

/** S3 lists, and deletes in one request, at most this many keys. */
const S3_PAGE = 1_000;

/**
 * Deletes every object in `bucket` and answers how many there were. A page of keys at a time:
 * listed, then deleted in one request. Throws when S3 refused any key of a page (the objects
 * deleted before it stay deleted; running it again finishes the job).
 *
 * The bucket holds nothing but the app's media (terraform/media.tf), so everything in it goes —
 * not only the prefixes the API writes today. Versioning is off, so a deleted object is gone.
 */
export async function emptyS3Bucket(client: S3Sender, bucket: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, MaxKeys: S3_PAGE, ContinuationToken: token }),
    );
    const keys = (page.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => key !== undefined);
    if (keys.length > 0) {
      const answer = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const refused = answer.Errors ?? [];
      if (refused.length > 0) {
        const first = refused[0];
        throw new Error(
          `S3 did not delete ${String(refused.length)} of ${String(keys.length)} objects ` +
            `(first: ${first?.Key ?? '?'} ${first?.Code ?? ''} ${first?.Message ?? ''})`.trim(),
        );
      }
      deleted += keys.length;
    }
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return deleted;
}

/** What `emptyMediaStore` did. */
export type EmptyMediaStoreResult =
  /** Every object in the bucket deleted. */
  | { readonly kind: 'emptied'; readonly bucket: string; readonly deleted: number }
  /** The `s3` store with no bucket named (MEDIA_S3_BUCKET unset): nothing to empty. */
  | { readonly kind: 'no_bucket' }
  /** The `local` store: a directory, which this does not touch. */
  | { readonly kind: 'local'; readonly directory: string };

/**
 * Empties the media store the variables describe — the bucket of a deployment — for the database
 * reset (deploy/reset-db.sh, docs/RESET.md; owner decision 2026-10-19, ADR-0073): the reset deletes
 * every row that pointed at an object, so every object goes with them. Skips, without an error, a
 * store with no bucket named, and the local directory (development removes `.media` by hand).
 * `client` replaces the deployment's S3 client in a test.
 */
export async function emptyMediaStore(
  env: MediaStorageEnv & { NODE_ENV: 'development' | 'test' | 'production' },
  client?: S3Sender,
): Promise<EmptyMediaStoreResult> {
  if (mediaStorageDriver(env) === 'local') {
    return { kind: 'local', directory: env.MEDIA_LOCAL_DIR ?? DEFAULT_MEDIA_LOCAL_DIR };
  }
  const bucket = env.MEDIA_S3_BUCKET;
  if (bucket === undefined) return { kind: 'no_bucket' };
  const sender =
    client ??
    createS3Client({
      bucket,
      region: env.MEDIA_S3_REGION ?? DEFAULT_MEDIA_S3_REGION,
      accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID,
      secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY,
    });
  return { kind: 'emptied', bucket, deleted: await emptyS3Bucket(sender, bucket) };
}

/** What the CLI prints and the code it exits with. */
export interface EmptyCliOutcome {
  readonly code: 0 | 1;
  /** Lines for stdout. */
  readonly out: readonly string[];
  /** Lines for stderr. */
  readonly err: readonly string[];
}

/**
 * The CLI (`empty-cli.ts`, which deploy/reset-db.sh runs in a one-off api container): nothing
 * without `--yes`; the variables read as the api reads them — compose passes the unset ones as
 * empty strings, which mean unset — and refused when invalid; then `emptyMediaStore`, whose two
 * skips (no bucket named before `terraform apply`, the local directory) succeed. `client` replaces
 * the deployment's S3 client in a test. A failure of S3 itself is thrown.
 */
export async function runEmptyCli(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  client?: S3Sender,
): Promise<EmptyCliOutcome> {
  if (!argv.includes('--yes')) {
    return {
      code: 1,
      out: [],
      err: ['[media:empty] this deletes every object in the media bucket; pass --yes to run it'],
    };
  }
  const parsed = z
    .object({
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      ...mediaStorageEnvShape,
    })
    .safeParse(environment);
  if (!parsed.success) {
    return {
      code: 1,
      out: [],
      err: [`[media:empty] the media store's variables are invalid: ${parsed.error.message}`],
    };
  }
  const issues = mediaStorageEnvIssues(parsed.data);
  if (issues.length > 0) {
    return {
      code: 1,
      out: [],
      err: issues.map((issue) => `[media:empty] ${issue.path}: ${issue.message}`),
    };
  }
  const result = await emptyMediaStore(parsed.data, client);
  switch (result.kind) {
    case 'emptied':
      return {
        code: 0,
        out: [`[media:empty] deleted ${String(result.deleted)} objects from ${result.bucket}`],
        err: [],
      };
    case 'no_bucket':
      return {
        code: 0,
        out: ['[media:empty] MEDIA_S3_BUCKET is not set: no bucket to empty, skipped'],
        err: [],
      };
    case 'local':
      return {
        code: 0,
        out: [
          `[media:empty] MEDIA_STORAGE is local: no bucket to empty, skipped (the directory ${result.directory} is left as it is)`,
        ],
        err: [],
      };
  }
}
