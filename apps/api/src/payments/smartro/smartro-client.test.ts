/**
 * The real SmartroPay client over a stubbed global fetch: where each call goes, what it sends,
 * and that every way of NOT getting a readable answer is SmartroUnreachableError — the one
 * error the flows read as "outcome unknown" rather than "refused".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchSmartroClient, SmartroUnreachableError } from './smartro-client.js';

const BASE = 'https://tapproval.smartropay.co.kr';

function stubFetch(answer: () => Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(answer);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FetchSmartroClient', () => {
  it('posts JSON to the approval, inquiry and cancel paths and returns the JSON answer', async () => {
    const spy = stubFetch(() => Promise.resolve(Response.json({ ResultCode: '3001', Amt: 9700 })));
    const client = new FetchSmartroClient(BASE);

    await expect(client.approve({ Tid: 't', TrAuthKey: 'k' })).resolves.toEqual({
      ResultCode: '3001',
      Amt: 9700,
    });
    await client.inquire({ Tid: 't', TrAuthKey: 'k' });
    await client.cancel({ EncData: 'e', Mid: 'm' });

    expect(spy.mock.calls.map(([url]) => url)).toEqual([
      `${BASE}/payment/approval/urlCallApproval.do`,
      `${BASE}/payment/approval/approvalInquiry.do`,
      `${BASE}/payment/approval/cancel.do`,
    ]);
    const [, init] = spy.mock.calls[0]!;
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ Tid: 't', TrAuthKey: 'k' }),
    });
    // Bounded: a PG that never answers must not hold the request forever.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('turns a network failure into SmartroUnreachableError without the request in the message', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    const error = await new FetchSmartroClient(BASE)
      .approve({ Tid: 't', TrAuthKey: 'secret-auth-key' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SmartroUnreachableError);
    expect((error as Error).message).toContain('fetch failed');
    expect((error as Error).message).not.toContain('secret-auth-key');
  });

  it('turns a timeout into SmartroUnreachableError', async () => {
    const client = new FetchSmartroClient(BASE, 5);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
    );
    await expect(client.approve({ Tid: 't', TrAuthKey: 'k' })).rejects.toThrow(/timed out/);
  });

  it('turns a non-2xx status, a non-JSON body and a non-object JSON into SmartroUnreachableError', async () => {
    const client = new FetchSmartroClient(BASE);
    for (const response of [
      () => new Response('busy', { status: 503 }),
      () => new Response('<html>maintenance</html>', { status: 200 }),
      () => Response.json(['not', 'an', 'object']),
      () => Response.json(null),
    ]) {
      stubFetch(() => Promise.resolve(response()));
      await expect(client.cancel({ EncData: 'e', Mid: 'm' })).rejects.toBeInstanceOf(
        SmartroUnreachableError,
      );
    }
  });
});
