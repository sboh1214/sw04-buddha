import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createObjectStorage, type MediaStorageEnv, type ObjectStorage } from '@buddha/storage';
import { type Env } from '../config/env.js';

/** Injection token of the media store. Tests override it with @buddha/storage's MemoryObjectStorage. */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/**
 * A media setting as ConfigService gives it, or undefined when it is left empty. Typed as the
 * schema's value, but an empty one comes back as the raw string: the schema reads `MEDIA_STORAGE=`
 * (as .env.example has every media setting) as undefined, and @nestjs/config then falls back to
 * the raw environment's '' — as `memoryCeilingBytes` reads API_MEMORY_CEILING_MIB. Only an empty
 * (or blank) value comes back that way: any other value the schema took is its own, trimmed.
 */
function mediaSetting<T extends string>(value: T | undefined): T | undefined {
  const raw: unknown = value;
  return typeof raw === 'string' && raw.trim() !== '' ? value : undefined;
}

/**
 * The media store's variables as the schema reads them (ADR-0073 9-51, Codex review of #219, round
 * 5): each media setting through `mediaSetting`, so one left empty is unset here as it is for the
 * worker, which reads its parsed environment. Passed as ConfigService gave them, the empty
 * strings defeated `createObjectStorage`'s defaults: an empty MEDIA_STORAGE chose the bucket
 * rather than the local directory outside production, an empty MEDIA_LOCAL_DIR a directory of ''
 * rather than the repository's `.media`, and an empty bucket or region reached the S3 client
 * rather than leaving the store unconfigured or in the deployment's region.
 */
export function objectStorageEnv(
  config: ConfigService<Env, true>,
): MediaStorageEnv & { NODE_ENV: Env['NODE_ENV'] } {
  return {
    NODE_ENV: config.get('NODE_ENV', { infer: true }),
    MEDIA_STORAGE: mediaSetting(config.get('MEDIA_STORAGE', { infer: true })),
    MEDIA_LOCAL_DIR: mediaSetting(config.get('MEDIA_LOCAL_DIR', { infer: true })),
    MEDIA_S3_BUCKET: mediaSetting(config.get('MEDIA_S3_BUCKET', { infer: true })),
    MEDIA_S3_REGION: mediaSetting(config.get('MEDIA_S3_REGION', { infer: true })),
    MEDIA_S3_ACCESS_KEY_ID: mediaSetting(config.get('MEDIA_S3_ACCESS_KEY_ID', { infer: true })),
    MEDIA_S3_SECRET_ACCESS_KEY: mediaSetting(
      config.get('MEDIA_S3_SECRET_ACCESS_KEY', { infer: true }),
    ),
  };
}

/**
 * The configured media store (MEDIA_STORAGE, @buddha/storage): the private bucket, or a local
 * directory outside production. A deployment whose bucket is not set yet still boots — every
 * upload then fails, as 알리고 without keys fails every code (ADR-0070) — and says so once here,
 * so the log explains the 500s that follow.
 */
export const objectStorageProvider: Provider<ObjectStorage> = {
  provide: OBJECT_STORAGE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): ObjectStorage => {
    const storage = createObjectStorage(objectStorageEnv(config));
    if (storage.driver === 'unconfigured') {
      new Logger('MediaStorage').warn(
        'MEDIA_STORAGE is s3 but MEDIA_S3_BUCKET is not set: every image upload will fail',
      );
    }
    return storage;
  },
};
