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

  it('rejects a missing DATABASE_URL', () => {
    expect(() => parseEnv({ REDIS_URL: required.REDIS_URL })).toThrow(/DATABASE_URL/);
  });
});
