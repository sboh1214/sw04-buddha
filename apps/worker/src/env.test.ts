import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const required = {
  REDIS_URL: 'redis://localhost:6379',
  DATABASE_URL: 'postgres://buddha_app:buddha@localhost:5432/buddha',
};

describe('parseEnv', () => {
  it('accepts the documented .env.example values', () => {
    expect(parseEnv({ ...required, NODE_ENV: 'test' })).toMatchObject({
      NODE_ENV: 'test',
      REDIS_URL: 'redis://localhost:6379',
    });
  });

  it('defaults NODE_ENV to development', () => {
    expect(parseEnv(required).NODE_ENV).toBe('development');
  });

  it('rejects a non-redis URL and names the offending key', () => {
    expect(() => parseEnv({ ...required, REDIS_URL: 'http://localhost' })).toThrow(/REDIS_URL/);
  });

  it('takes the media store’s keys as the API does, refusing the local directory in production (#46)', () => {
    expect(parseEnv(required).MEDIA_STORAGE).toBeUndefined();
    expect(parseEnv(required).MEDIA_S3_BUCKET).toBeUndefined();
    expect(parseEnv({ ...required, MEDIA_S3_BUCKET: 'tf-buddha-prod-media' }).MEDIA_S3_BUCKET).toBe(
      'tf-buddha-prod-media',
    );
    expect(() => parseEnv({ ...required, NODE_ENV: 'production', MEDIA_STORAGE: 'local' })).toThrow(
      /MEDIA_STORAGE/,
    );
    expect(() => parseEnv({ ...required, MEDIA_S3_SECRET_ACCESS_KEY: 's' })).toThrow(
      /MEDIA_S3_ACCESS_KEY_ID/,
    );
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => parseEnv({ REDIS_URL: required.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('defaults the health server to localhost:4100 (what the e2e runner polls)', () => {
    expect(parseEnv(required)).toMatchObject({
      WORKER_HEALTH_PORT: 4100,
      WORKER_HOST: 'localhost',
    });
  });

  it('accepts WORKER_HEALTH_PORT=0 (server disabled) and coerces the string', () => {
    expect(parseEnv({ ...required, WORKER_HEALTH_PORT: '0' }).WORKER_HEALTH_PORT).toBe(0);
    expect(
      parseEnv({ ...required, WORKER_HEALTH_PORT: '4101', WORKER_HOST: '0.0.0.0' }),
    ).toMatchObject({ WORKER_HEALTH_PORT: 4101, WORKER_HOST: '0.0.0.0' });
  });

  it('rejects a health port outside 0..65535 and names the key', () => {
    expect(() => parseEnv({ ...required, WORKER_HEALTH_PORT: '65536' })).toThrow(
      /WORKER_HEALTH_PORT/,
    );
    expect(() => parseEnv({ ...required, WORKER_HEALTH_PORT: '-1' })).toThrow(/WORKER_HEALTH_PORT/);
    expect(() => parseEnv({ ...required, WORKER_HEALTH_PORT: 'health' })).toThrow(
      /WORKER_HEALTH_PORT/,
    );
  });
});
