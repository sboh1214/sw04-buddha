import path from 'node:path';
import * as z from 'zod';
import { LocalObjectStorage } from './local.js';
import { type ObjectStorage } from './object-storage.js';
import { S3ObjectStorage, createS3Client } from './s3.js';
import { UnconfiguredObjectStorage } from './unconfigured.js';

/** Which store holds the media (MEDIA_STORAGE). */
export const MEDIA_STORAGE_DRIVERS = ['local', 's3'] as const;
export type MediaStorageDriver = (typeof MEDIA_STORAGE_DRIVERS)[number];

/** The region of every resource of the deployment (terraform/variables.tf `region`). */
export const DEFAULT_MEDIA_S3_REGION = 'ap-northeast-2';

/**
 * The directory of the local driver when MEDIA_LOCAL_DIR is unset: `.media` at the repository
 * root (git-ignored), resolved from this module — the same directory from `src/` and `dist/`,
 * so the API and the worker of one checkout (development, the e2e suite) share it.
 */
export const DEFAULT_MEDIA_LOCAL_DIR = path.resolve(import.meta.dirname, '../../../.media');

/** An unset key and an empty value both become `undefined` (an empty line in .env.example). */
const optionalString = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

/**
 * The media store's environment, the same keys for apps/api and apps/worker (PLAN 15: one `.env`).
 * Each app spreads this into its own schema and adds `mediaStorageEnvIssues` to its refinements.
 */
export const mediaStorageEnvShape = {
  /**
   * `s3` (the private bucket) or `local` (a directory). Unset: `s3` under NODE_ENV=production and
   * `local` everywhere else. Production refuses `local`: a deployment's containers are replaced
   * on every deploy, and the API and the worker do not share a directory there.
   */
  MEDIA_STORAGE: optionalString.pipe(z.enum(MEDIA_STORAGE_DRIVERS).optional()),
  /** The local driver's directory; unset, DEFAULT_MEDIA_LOCAL_DIR. */
  MEDIA_LOCAL_DIR: optionalString,
  /**
   * The private bucket (terraform/media.tf). Unset with the `s3` driver, the store is
   * unconfigured: the API starts and every upload fails (UnconfiguredObjectStorage).
   */
  MEDIA_S3_BUCKET: optionalString,
  /** The bucket's region; unset, DEFAULT_MEDIA_S3_REGION. */
  MEDIA_S3_REGION: optionalString,
  /**
   * The access key of the app's own IAM user, both or neither (S3StorageConfig). Neither leaves the
   * SDK's default credential chain to find one.
   */
  MEDIA_S3_ACCESS_KEY_ID: optionalString,
  MEDIA_S3_SECRET_ACCESS_KEY: optionalString,
};

export type MediaStorageEnv = z.infer<z.ZodObject<typeof mediaStorageEnvShape>>;

type NodeEnv = 'development' | 'test' | 'production';

/** One problem with the media store's variables, for the app's `superRefine`. */
export interface MediaStorageEnvIssue {
  readonly path: keyof MediaStorageEnv;
  readonly message: string;
}

/**
 * What is wrong with the media store's variables beyond each one's own shape: production with the
 * local driver, half an access key, a bucket name S3 would refuse. Each app turns these into
 * issues of its own schema, so a bad value stops the process at boot under its own name.
 */
export function mediaStorageEnvIssues(
  env: MediaStorageEnv & { NODE_ENV: NodeEnv },
): MediaStorageEnvIssue[] {
  const issues: MediaStorageEnvIssue[] = [];
  if (env.NODE_ENV === 'production' && env.MEDIA_STORAGE === 'local') {
    issues.push({
      path: 'MEDIA_STORAGE',
      message: 'local keeps media in one container; production stores them in the S3 bucket',
    });
  }
  if (Boolean(env.MEDIA_S3_ACCESS_KEY_ID) !== Boolean(env.MEDIA_S3_SECRET_ACCESS_KEY)) {
    issues.push({
      path: 'MEDIA_S3_ACCESS_KEY_ID',
      message: 'MEDIA_S3_ACCESS_KEY_ID and MEDIA_S3_SECRET_ACCESS_KEY must be set together',
    });
  }
  if (
    env.MEDIA_S3_BUCKET !== undefined &&
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.MEDIA_S3_BUCKET)
  ) {
    issues.push({
      path: 'MEDIA_S3_BUCKET',
      message:
        'MEDIA_S3_BUCKET must be a bucket name (3 to 63 lower-case letters, digits, . and -)',
    });
  }
  return issues;
}

/** MEDIA_STORAGE as configured, or its default for NODE_ENV. */
export function mediaStorageDriver(
  env: Pick<MediaStorageEnv, 'MEDIA_STORAGE'> & { NODE_ENV: NodeEnv },
): MediaStorageDriver {
  return env.MEDIA_STORAGE ?? (env.NODE_ENV === 'production' ? 's3' : 'local');
}

/**
 * The store the variables describe: the bucket (or the unconfigured store while it has no name),
 * or the local directory. Called once per process, by the API's provider and the worker's main.
 */
export function createObjectStorage(env: MediaStorageEnv & { NODE_ENV: NodeEnv }): ObjectStorage {
  if (mediaStorageDriver(env) === 'local') {
    return new LocalObjectStorage(env.MEDIA_LOCAL_DIR ?? DEFAULT_MEDIA_LOCAL_DIR);
  }
  if (env.MEDIA_S3_BUCKET === undefined) return new UnconfiguredObjectStorage();
  const client = createS3Client({
    bucket: env.MEDIA_S3_BUCKET,
    region: env.MEDIA_S3_REGION ?? DEFAULT_MEDIA_S3_REGION,
    accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID,
    secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY,
  });
  return new S3ObjectStorage(client, env.MEDIA_S3_BUCKET);
}
