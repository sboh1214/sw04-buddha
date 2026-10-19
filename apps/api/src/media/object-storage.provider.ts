import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createObjectStorage, type ObjectStorage } from '@buddha/storage';
import { type Env } from '../config/env.js';

/** Injection token of the media store. Tests override it with @buddha/storage's MemoryObjectStorage. */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

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
    const storage = createObjectStorage({
      NODE_ENV: config.get('NODE_ENV', { infer: true }),
      MEDIA_STORAGE: config.get('MEDIA_STORAGE', { infer: true }),
      MEDIA_LOCAL_DIR: config.get('MEDIA_LOCAL_DIR', { infer: true }),
      MEDIA_S3_BUCKET: config.get('MEDIA_S3_BUCKET', { infer: true }),
      MEDIA_S3_REGION: config.get('MEDIA_S3_REGION', { infer: true }),
      MEDIA_S3_ACCESS_KEY_ID: config.get('MEDIA_S3_ACCESS_KEY_ID', { infer: true }),
      MEDIA_S3_SECRET_ACCESS_KEY: config.get('MEDIA_S3_SECRET_ACCESS_KEY', { infer: true }),
    });
    if (storage.driver === 'unconfigured') {
      new Logger('MediaStorage').warn(
        'MEDIA_STORAGE is s3 but MEDIA_S3_BUCKET is not set: every image upload will fail',
      );
    }
    return storage;
  },
};
