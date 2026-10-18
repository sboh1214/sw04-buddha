/**
 * The 알리고 sender (ADR-0069 decision 1 #57-3, ADR-0070) against a fake `fetch`: what it posts,
 * and that it calls nothing a success but `result_code` 1 — no keys, a network failure, another
 * status, an unreadable body and a refusal all reject, with neither the number nor the code in
 * the error, and each says whether the text certainly did not go (`refused`) or may have gone
 * (`unknown`, decision 7-3). Runs everywhere.
 */
import { createMemoryMailer } from '../test/memory-mailer.js';
import { describe, expect, it, vi } from 'vitest';
import { ALIGO_SEND_URL, createAligoSmsSender } from './aligo-sms-sender.js';
import { createDevSmsSender, devSmsAddress } from './dev-sms-sender.js';
import { redactDigits, SmsSendError, type SmsSendOutcome, sendOutcome } from './sms-sender.js';

const credentials = { apiKey: 'api-key', userId: 'buddha', sender: '0212345678' };
const sms = { to: '01098765432', code: '012345', expiresInMinutes: 3 };

function answering(body: unknown, init: ResponseInit = { status: 200 }) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        ...init,
        headers: { 'content-type': 'application/json;charset=UTF-8' },
      }),
    ),
  );
}

/**
 * The rejection of a send, checked to say nothing of the number or the code and to say what it
 * means for the text: `outcome`.
 */
async function refusal(send: Promise<void>, outcome: SmsSendOutcome): Promise<string> {
  const error = await send.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SmsSendError);
  const message = (error as Error).message;
  expect({ message, outcome: (error as SmsSendError).outcome }).toEqual({ message, outcome });
  expect(message).not.toContain(sms.to);
  expect(message).not.toContain(sms.code);
  return message;
}

describe('createAligoSmsSender', () => {
  it('posts one short SMS from the registered sender to the number, form-encoded', async () => {
    const fetch = answering({
      result_code: 1,
      message: '',
      msg_id: 123,
      success_cnt: 1,
      error_cnt: 0,
      msg_type: 'SMS',
    });
    await createAligoSmsSender({ credentials, testMode: false, fetch }).sendVerificationCode(sms);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(ALIGO_SEND_URL);
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = init?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      key: 'api-key',
      user_id: 'buddha',
      sender: '0212345678',
      receiver: '01098765432',
      msg: '[buddha] 본인확인 인증번호는 012345입니다. 3분 안에 입력해 주세요.',
      msg_type: 'SMS',
    });
  });

  it('asks for the test mode when told, and takes a result code written as a string', async () => {
    const fetch = answering({ result_code: '1', message: 'success' });
    await createAligoSmsSender({ credentials, testMode: true, fetch }).sendVerificationCode(sms);
    expect((fetch.mock.calls[0]![1]?.body as URLSearchParams).get('testmode_yn')).toBe('Y');
  });

  it('fails every send without its keys, asking nobody (owner decision 2026-10-17)', async () => {
    const fetch = answering({ result_code: 1 });
    const message = await refusal(
      createAligoSmsSender({ credentials: undefined, testMode: false, fetch }).sendVerificationCode(
        sms,
      ),
      'refused',
    );
    expect(message).toContain('ALIGO_API_KEY');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails on a refusal, naming the result code and the message but not the receiver', async () => {
    const fetch = answering({ result_code: -101, message: `인증오류입니다. ${sms.to}` });
    const message = await refusal(
      createAligoSmsSender({ credentials, testMode: false, fetch }).sendVerificationCode(sms),
      'refused',
    );
    expect(message).toContain('result_code -101');
    expect(message).toContain('인증오류입니다.');
  });

  it('fails when the provider took no receiver', async () => {
    const fetch = answering({ result_code: 1, success_cnt: 0, error_cnt: 1 });
    await refusal(
      createAligoSmsSender({ credentials, testMode: false, fetch }).sendVerificationCode(sms),
      'refused',
    );
  });

  const networkFailure = (code: string) =>
    vi.fn<typeof fetch>(() =>
      Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code } })),
    );

  it('fails as refused when nothing reached the provider or it answered no', async () => {
    for (const fake of [
      answering({ result_code: 1 }, { status: 400 }),
      answering({ result_code: 1 }, { status: 404 }),
      networkFailure('ECONNREFUSED'),
      networkFailure('ENOTFOUND'),
      networkFailure('UND_ERR_CONNECT_TIMEOUT'),
    ]) {
      await refusal(
        createAligoSmsSender({ credentials, testMode: false, fetch: fake }).sendVerificationCode(
          sms,
        ),
        'refused',
      );
    }
  });

  it('fails as unknown when the provider may have taken the text: a 5xx, an unreadable 2xx, a lost connection', async () => {
    for (const fake of [
      answering({ result_code: 1 }, { status: 503 }),
      answering({ result_code: 1 }, { status: 504 }),
      answering('<html>maintenance</html>'),
      answering({ message: 'no code' }),
      networkFailure('ECONNRESET'),
      networkFailure('UND_ERR_SOCKET'),
      vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed'))),
    ]) {
      await refusal(
        createAligoSmsSender({ credentials, testMode: false, fetch: fake }).sendVerificationCode(
          sms,
        ),
        'unknown',
      );
    }
  });

  it('gives up after its timeout, not knowing whether the text went', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
    );
    const sender = createAligoSmsSender({
      credentials,
      testMode: false,
      fetch: hanging,
      timeoutMs: 20,
    });
    const message = await refusal(sender.sendVerificationCode(sms), 'unknown');
    expect(message).toContain('TimeoutError');
  });
});

describe('createDevSmsSender (SMS_PROVIDER=dev)', () => {
  it('mails the code to the Mailpit address of the number, as a registered template', async () => {
    const mailer = createMemoryMailer();
    await createDevSmsSender(mailer).sendVerificationCode(sms);
    expect(mailer.messages).toHaveLength(1);
    const [mail] = mailer.messages;
    expect(mail?.to).toBe(devSmsAddress(sms.to));
    expect(mail?.to).toBe('sms-01098765432@sms.buddha.local');
    expect(mail?.subject).toContain(sms.code);
    expect(mail?.text).toContain(`본인확인 인증번호는 ${sms.code}입니다. 3분 안에`);
  });

  it('fails the send when the mail fails, naming neither the number nor the code', async () => {
    const mailer = createMemoryMailer();
    mailer.failNext(1);
    await refusal(createDevSmsSender(mailer).sendVerificationCode(sms), 'refused');
    expect(mailer.messages).toEqual([]);
  });
});

describe('redactDigits', () => {
  it('hides every run of six or more digits: numbers and codes', () => {
    expect(redactDigits('to 01012345678, code 012345, result_code -101, HTTP 503')).toBe(
      'to [digits], code [digits], result_code -101, HTTP 503',
    );
    expect(new SmsSendError('refused', '550 <sms-01012345678@sms.buddha.local>').message).toBe(
      '550 <sms-[digits]@sms.buddha.local>',
    );
  });
});

describe('sendOutcome', () => {
  it('reads a failure as unknown unless an SmsSendError says refused', () => {
    expect(sendOutcome(new SmsSendError('refused', 'no'))).toBe('refused');
    expect(sendOutcome(new SmsSendError('unknown', 'lost'))).toBe('unknown');
    // A sender's bug says nothing about the text: it may have gone.
    expect(sendOutcome(new TypeError('x is undefined'))).toBe('unknown');
    expect(sendOutcome('thrown string')).toBe('unknown');
  });
});
