// A fake SmartroPay for the integration suites (ADR-0042): the test credentials, a scriptable
// stand-in for the PG's HTTP API, and builders for what the PG sends back.
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { schema, type Db } from '@buddha/db';
import { paymentIdToMoid } from '@buddha/shared';
import { type SmartroConfig } from '../payments/payments-config.js';
import {
  SmartroUnreachableError,
  type SmartroAuth,
  type SmartroCancelBody,
  type SmartroClient,
  type SmartroResponse,
} from '../payments/smartro/smartro-client.js';
import { SMARTRO_NOTIFY_IPS } from '../payments/smartro/smartro-protocol.js';

/** setup-env's BETTER_AUTH_URL: the origin the callbacks redirect to and build their URLs on. */
export const TEST_WEB_ORIGIN = 'http://localhost:3000';

/** SmartroPay's STG server: the one address TEST_SMARTRO takes a 재통보 from. */
export const TEST_NOTIFY_IP = '211.193.35.11';

/**
 * STG credentials no real merchant holds. The key is ASCII and longer than the 32 the AES uses.
 * The 재통보 address check is ON, as on the real STG (SMARTRO_NOTIFY_IPS): the suites present
 * TEST_NOTIFY_IP with `remoteAddress`. `approvalBaseUrl` is never dialled — the fake client
 * stands in for the HTTP one.
 */
export const TEST_SMARTRO: SmartroConfig = {
  mode: 'STG',
  mid: 'buddhatest',
  merchantKey: 'TestMerchantKey-0123456789abcdefghij-not-a-real-key',
  cancelPassword: 'test-cancel-pw',
  approvalBaseUrl: 'http://127.0.0.1:9',
  notifyIps: SMARTRO_NOTIFY_IPS.STG,
};

/**
 * The PG's signature, computed here from the manual's formula rather than with
 * smartro-protocol.ts: a fake that signed with the code under test would agree with any bug in it.
 */
export function testSignValue(
  tid: string,
  resultCode: string,
  merchantKey: string = TEST_SMARTRO.merchantKey,
): string {
  return createHash('sha256')
    .update(
      tid.substring(0, 10) + resultCode + tid.substring(10, 15) + merchantKey + tid.substring(15),
    )
    .digest('base64');
}

/** A cancel request as SmartroPay reads it: `EncData` decrypted (AES-256-CBC, zero IV). */
export function decryptCancel(body: SmartroCancelBody): Record<string, string> {
  const decipher = createDecipheriv(
    'aes-256-cbc',
    Buffer.from(TEST_SMARTRO.merchantKey.substring(0, 32), 'utf8'),
    Buffer.alloc(16, 0),
  );
  const json = Buffer.concat([decipher.update(body.EncData, 'base64'), decipher.final()]);
  return JSON.parse(json.toString('utf8')) as Record<string, string>;
}

let tidSequence = 0;

/** A fresh 30-character Tid shaped like SmartroPay's (Mid + date + sequence). */
export function testTid(): string {
  tidSequence += 1;
  const stamp = String(Date.now()).slice(-8);
  return `${TEST_SMARTRO.mid}0928${stamp}${String(tidSequence).padStart(8, '0')}`;
}

export interface ApprovalAnswerInput {
  paymentId: string;
  priceKrw: number;
  tid: string;
  resultCode?: string;
  resultMsg?: string;
  payMethod?: string;
  /** Applied after signing: how a suite forges one field of an otherwise valid answer. */
  overrides?: Record<string, unknown>;
}

/** The approval (or inquiry) answer SmartroPay would give for a payment, signed. */
export function approvalAnswer(input: ApprovalAnswerInput): SmartroResponse {
  const resultCode = input.resultCode ?? '3001';
  return {
    PayMethod: input.payMethod ?? 'CARD',
    Mid: TEST_SMARTRO.mid,
    Tid: input.tid,
    Moid: paymentIdToMoid(input.paymentId),
    GoodsName: '포인트 10,000P',
    Amt: String(input.priceKrw),
    BuyerName: '홍길동',
    BuyerTel: '01012345678',
    AuthCode: '30001234',
    AuthDate: '260928103000',
    ResultCode: resultCode,
    ResultMsg: input.resultMsg ?? (resultCode === '3001' ? '카드 결제 성공' : '승인 거절'),
    SignValue: testSignValue(input.tid, resultCode),
    CardNum: '53651234****1234',
    // A field the manual does not list: answers may grow without notice.
    SomethingNew: 'ignored',
    ...input.overrides,
  };
}

export interface NotifyFormInput {
  paymentId: string;
  priceKrw: number;
  /** The notice's own Tid, which its SignValue covers (a cancel's may be a new one). */
  tid: string;
  /** The original approval's Tid; `tid` unless given (a cancel's may differ). */
  otid?: string;
  resultCode?: string;
  resultMsg?: string;
  /** 0 approval, 1 cancel, 2 cancel after settlement. */
  stateCd?: string;
  payMethod?: string;
  mid?: string;
  amt?: string;
  signValue?: string;
}

/** A 재통보 (신통보 parameter names) as SmartroPay would post it. */
export function notifyForm(input: NotifyFormInput): Record<string, string> {
  const resultCode = input.resultCode ?? '3001';
  return {
    PayMethod: input.payMethod ?? 'CARD',
    Mid: input.mid ?? TEST_SMARTRO.mid,
    Amt: input.amt ?? String(input.priceKrw),
    BuyerName: '홍길동',
    BuyerEmail: '',
    BuyerTel: '01012345678',
    GoodsName: '포인트 10,000P',
    Tid: input.tid,
    Otid: input.otid ?? input.tid,
    Moid: paymentIdToMoid(input.paymentId),
    AuthDate: '260928103000',
    AuthCode: '30001234',
    ResultCode: resultCode,
    ResultMsg: input.resultMsg ?? (resultCode === '3001' ? '카드 결제 성공' : '취소 성공'),
    StateCd: input.stateCd ?? '0',
    FnCd: '04',
    FnName: '삼성',
    SignValue: input.signValue ?? testSignValue(input.tid, resultCode),
  };
}

/** A form-urlencoded request body. */
export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' } as const;

type Answer = SmartroResponse | Promise<SmartroResponse>;

/**
 * The PG, scripted per test. Approval and inquiry answer "no answer" (a network failure) until
 * a suite scripts them, so an unexpected call shows up as `pending`, never as a success; the
 * cancel answers 2001. Every call is recorded — the cancel as SmartroPay would decrypt it.
 */
export class FakeSmartroClient implements SmartroClient {
  readonly approvals: SmartroAuth[] = [];
  readonly inquiries: SmartroAuth[] = [];
  readonly cancels: (Record<string, string> & { outerMid: string })[] = [];
  onApprove: (auth: SmartroAuth) => Answer = noAnswer;
  onInquire: (auth: SmartroAuth) => Answer = noAnswer;
  onCancel: (param: Record<string, string>) => Answer = cancelled;

  async approve(body: SmartroAuth): Promise<SmartroResponse> {
    this.approvals.push(body);
    return this.onApprove(body);
  }

  async inquire(body: SmartroAuth): Promise<SmartroResponse> {
    this.inquiries.push(body);
    return this.onInquire(body);
  }

  async cancel(body: SmartroCancelBody): Promise<SmartroResponse> {
    const param = decryptCancel(body);
    this.cancels.push({ ...param, outerMid: body.Mid });
    return this.onCancel(param);
  }

  /** Forget the calls and the scripts (call in beforeEach). */
  reset(): void {
    this.approvals.length = 0;
    this.inquiries.length = 0;
    this.cancels.length = 0;
    this.onApprove = noAnswer;
    this.onInquire = noAnswer;
    this.onCancel = cancelled;
  }
}

function noAnswer(): never {
  throw new SmartroUnreachableError('the fake PG was not scripted to answer');
}

function cancelled(): SmartroResponse {
  return { ResultCode: '2001', ResultMsg: '취소 성공', PayMethod: 'CARD' };
}

/**
 * A `pending` SmartroPay payment inserted directly, as `prepare` would reserve it — for suites
 * about what happens after the window (the ReturnUrl, the 재통보, a refund) rather than before.
 * `claimedBy`: the authentication Tid a ReturnUrl claimed it with (`provider_ref`), which the
 * PG's approval — and so any 재통보 that credits — always comes after.
 */
export async function reserveSmartroPayment(
  db: Db,
  userId: string,
  input: {
    amountP?: bigint;
    priceKrw?: number;
    packageId?: string | null;
    claimedBy?: string;
  } = {},
): Promise<typeof schema.payments.$inferSelect> {
  const [row] = await db
    .insert(schema.payments)
    .values({
      userId,
      amountP: input.amountP ?? 10_000n,
      priceKrw: input.priceKrw ?? 9_700,
      packageId: input.packageId ?? null,
      provider: 'smartro',
      status: 'pending',
      providerRef: input.claimedBy ?? null,
      idempotencyKey: randomUUID(),
    })
    .returning();
  if (!row) throw new Error('failed to reserve a SmartroPay payment');
  return row;
}
