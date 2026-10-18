/**
 * The configured SmsSender (ADR-0070 decision 4): which sender SMS_PROVIDER and NODE_ENV pick and
 * what reaches it — the 알리고 keys and the test mode. createTestApp replaces the sender, so this
 * is the only test that builds the real one. Above all, a production API must never pick the
 * development sender or 알리고's test mode by itself: both answer "sent" for a code no phone
 * receives, the silent success the owner ruled out (ADR-0069 decision 1 #57-3). Runs everywhere:
 * `fetch` is a stub and the mailer is in memory.
 */
import { type FactoryProvider, Logger } from '@nestjs/common';
import { type ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { type Env, envSchema } from '../config/env.js';
import { createMemoryMailer, type MemoryMailer } from '../test/memory-mailer.js';
import { ALIGO_SEND_URL } from './aligo-sms-sender.js';
import { devSmsAddress } from './dev-sms-sender.js';
import { SmsSendError, type SmsSender } from './sms-sender.js';
import { smsSenderProvider } from './sms.provider.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/buddha',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
} as const;
const aligo = { ALIGO_API_KEY: 'api-key', ALIGO_USER_ID: 'buddha', ALIGO_SENDER: '0212345678' };
const sms = { to: '01098765432', code: '012345', expiresInMinutes: 3 };

/** The sender the provider builds from `raw`, parsed by the env schema as the API boots. */
function build(raw: Record<string, string>, mailer: MemoryMailer): SmsSender {
  const env = envSchema.parse({ ...base, ...raw });
  const config = { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
  const { useFactory } = smsSenderProvider as FactoryProvider<SmsSender>;
  return useFactory(config, mailer) as SmsSender;
}

describe('smsSenderProvider', () => {
  let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  let mailer: MemoryMailer;
  let warn: MockInstance;

  beforeEach(() => {
    // Stubbed before the factory runs: the 알리고 sender takes the global fetch when it is built.
    fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ result_code: 1, message: 'success', success_cnt: 1 }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    mailer = createMemoryMailer();
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fails every production send without the 알리고 keys: no fetch, no mail, one warning', async () => {
    const sender = build({ NODE_ENV: 'production' }, mailer);
    const error = await sender.sendVerificationCode(sms).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SmsSendError);
    expect((error as SmsSendError).outcome).toBe('refused');
    expect(fetch).not.toHaveBeenCalled();
    expect(mailer.messages).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('texts through 알리고 in production, with the configured keys and no test mode', async () => {
    const sender = build({ NODE_ENV: 'production', ...aligo }, mailer);
    await sender.sendVerificationCode(sms);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(ALIGO_SEND_URL);
    const body = Object.fromEntries(init?.body as URLSearchParams);
    expect(body).toMatchObject({
      key: 'api-key',
      user_id: 'buddha',
      sender: '0212345678',
      receiver: sms.to,
    });
    expect(body).not.toHaveProperty('testmode_yn');
    expect(mailer.messages).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('asks 알리고 for its test mode only when ALIGO_TEST_MODE says so', async () => {
    const sender = build({ NODE_ENV: 'production', ...aligo, ALIGO_TEST_MODE: 'true' }, mailer);
    await sender.sendVerificationCode(sms);
    expect((fetch.mock.calls[0]![1]?.body as URLSearchParams).get('testmode_yn')).toBe('Y');
  });

  it('mails the code to Mailpit outside production, asking 알리고 nothing', async () => {
    for (const NODE_ENV of ['development', 'test']) {
      const local = createMemoryMailer();
      await build({ NODE_ENV }, local).sendVerificationCode(sms);
      expect(local.messages.map((mail) => mail.to)).toEqual([devSmsAddress(sms.to)]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('texts through 알리고 outside production when SMS_PROVIDER says so', async () => {
    await build(
      { NODE_ENV: 'development', SMS_PROVIDER: 'aligo', ...aligo },
      mailer,
    ).sendVerificationCode(sms);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mailer.messages).toEqual([]);
  });
});
