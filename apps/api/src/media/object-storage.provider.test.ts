import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  DEFAULT_MEDIA_LOCAL_DIR,
  DEFAULT_MEDIA_S3_REGION,
  LocalObjectStorage,
  type ObjectStorage,
  UnconfiguredObjectStorage,
} from '@buddha/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Env, envSchema } from '../config/env.js';
import {
  OBJECT_STORAGE,
  objectStorageEnv,
  objectStorageProvider,
} from './object-storage.provider.js';

/**
 * The media store's settings as the API's provider reads them (ADR-0073 9-51, Codex review of
 * #219, round 5): through ConfigService, which gives the raw environment's value back when the
 * schema's is undefined — so a setting left empty, as .env.example has every one of them, came
 * back as '' and defeated the store's defaults. Each case runs the API's own schema for these
 * keys over `process.env`, as the app's ConfigModule does with a .env copied from .env.example.
 */

const MEDIA_SETTINGS = [
  'MEDIA_STORAGE',
  'MEDIA_LOCAL_DIR',
  'MEDIA_S3_BUCKET',
  'MEDIA_S3_REGION',
  'MEDIA_S3_ACCESS_KEY_ID',
  'MEDIA_S3_SECRET_ACCESS_KEY',
] as const;
type MediaSetting = (typeof MEDIA_SETTINGS)[number];

/** A value of each setting the schema takes. */
const SET: Record<MediaSetting, string> = {
  MEDIA_STORAGE: 'local',
  MEDIA_LOCAL_DIR: '/tmp/buddha-media',
  MEDIA_S3_BUCKET: 'buddha-media',
  MEDIA_S3_REGION: 'us-east-1',
  MEDIA_S3_ACCESS_KEY_ID: 'AKIA',
  MEDIA_S3_SECRET_ACCESS_KEY: 'secret',
};

const saved = new Map(MEDIA_SETTINGS.map((key) => [key, process.env[key]]));
const opened: TestingModule[] = [];

afterEach(async () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(opened.splice(0).map((moduleRef) => moduleRef.close()));
});

/**
 * ConfigService and the provider's store over `env` — each media setting as given, the others
 * unset — under the API's schema for them (NODE_ENV as the test runner sets it: `test`).
 */
async function configured(env: Partial<Record<MediaSetting, string>>) {
  for (const key of MEDIA_SETTINGS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        validationSchema: z.object({
          NODE_ENV: envSchema.shape.NODE_ENV,
          ...Object.fromEntries(MEDIA_SETTINGS.map((key) => [key, envSchema.shape[key]])),
        }),
      }),
    ],
    providers: [objectStorageProvider],
  }).compile();
  opened.push(moduleRef);
  return {
    config: moduleRef.get<ConfigService<Env, true>>(ConfigService),
    storage: moduleRef.get<ObjectStorage>(OBJECT_STORAGE),
  };
}

describe('each media setting, as the provider reads it (objectStorageEnv)', () => {
  it.each(MEDIA_SETTINGS)(
    '%s left empty or blank is unset, not the raw string ConfigService falls back to; set, it is its value',
    async (key) => {
      for (const empty of ['', '  ']) {
        const { config } = await configured({ [key]: empty });
        // The fallback this reads around: the schema's undefined, then the raw value.
        expect(config.get(key, { infer: true })).toBe(empty);
        expect(objectStorageEnv(config)[key]).toBeUndefined();
      }
      const { config } = await configured({ [key]: SET[key] });
      expect(objectStorageEnv(config)[key]).toBe(SET[key]);
    },
  );
});

describe('the store the provider makes of empty settings', () => {
  /** Every setting left empty, as a .env copied from .env.example has them, but `over`. */
  const asExample = (over: Partial<Record<MediaSetting, string>> = {}) =>
    configured({ ...Object.fromEntries(MEDIA_SETTINGS.map((key) => [key, ''])), ...over });

  it('is the local directory outside production — the repository’s `.media` — not the bucket', async () => {
    const { storage } = await asExample();
    expect(storage.driver).toBe('local');
    expect(storage).toEqual(new LocalObjectStorage(DEFAULT_MEDIA_LOCAL_DIR));
  });

  it('with MEDIA_STORAGE=s3 and no bucket, is the unconfigured store — not a client for a bucket named ""', async () => {
    const { storage } = await asExample({ MEDIA_STORAGE: 's3' });
    expect(storage).toBeInstanceOf(UnconfiguredObjectStorage);
  });

  it('with a bucket, asks the deployment’s region rather than an empty one', async () => {
    const { storage } = await asExample({ MEDIA_STORAGE: 's3', MEDIA_S3_BUCKET: 'buddha-media' });
    expect(storage.driver).toBe('s3');
    // The driver keeps its client to itself: read here only to see the region it was made with.
    const { client } = storage as unknown as {
      client: { config: { region: () => Promise<string> } };
    };
    await expect(client.config.region()).resolves.toBe(DEFAULT_MEDIA_S3_REGION);
  });
});
