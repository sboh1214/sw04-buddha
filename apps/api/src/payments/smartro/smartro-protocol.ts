import { createCipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { formatP, type SmartroMode } from '@buddha/shared';

/**
 * SmartroPay 일반연동 as pure functions (ADR-0042): the signatures, the cancel payload, the
 * clock format and the result codes. No I/O and no configuration here — callers pass the
 * merchant key in — so every rule of the manual has a unit test with a fixed vector.
 */

/** Approval (and inquiry) host per mode; `SMARTRO_APPROVAL_BASE_URL` may override it outside production. */
export const SMARTRO_APPROVAL_HOSTS: Readonly<Record<SmartroMode, string>> = {
  STG: 'https://tapproval.smartropay.co.kr',
  REAL: 'https://approval.smartropay.co.kr',
};

/** The SDK host of each build per mode. The SDK decides its own mode from this host. */
const SMARTRO_SCRIPT_HOSTS: Readonly<Record<SmartroMode, { pc: string; mobile: string }>> = {
  STG: { pc: 'https://tpay.smartropay.co.kr', mobile: 'https://tmpay.smartropay.co.kr' },
  REAL: { pc: 'https://pay.smartropay.co.kr', mobile: 'https://mpay.smartropay.co.kr' },
};

export const SMARTRO_APPROVAL_PATH = '/payment/approval/urlCallApproval.do';
export const SMARTRO_INQUIRY_PATH = '/payment/approval/approvalInquiry.do';
export const SMARTRO_CANCEL_PATH = '/payment/approval/cancel.do';

/**
 * Where our callbacks live on the web origin (SmartroCallbackController's routes), as the PG and
 * the browser reach them.
 */
export const SMARTRO_CALLBACK_PATH = '/api/v1/payments/smartro';

/** ReturnUrl and StopUrl: at most 100 characters, protocol included (the manual). */
export const SMARTRO_CALLBACK_URL_MAX = 100;

/**
 * The SmartroPay servers a 재통보 may come from, per mode (the manual's "스마트로페이 SERVER IP"
 * table): STG's one server; REAL's two 재통보 servers (211.193.35.216/217) and, to be safe, its
 * payment server (211.193.35.20). The notice's SignValue covers only Tid and ResultCode, so the
 * sender's address is the other half of telling SmartroPay's notice from a forged one.
 */
export const SMARTRO_NOTIFY_IPS: Readonly<Record<SmartroMode, readonly string[]>> = {
  STG: ['211.193.35.11'],
  REAL: ['211.193.35.216', '211.193.35.217', '211.193.35.20'],
};

/**
 * Whether `ip` (Fastify's `request.ip`) is one of `allowed`. Behind Caddy that is the peer Caddy
 * names in X-Forwarded-For (TRUST_PROXY trusts Caddy alone, and Caddy drops a client-supplied
 * header); without a proxy it is the socket peer, which a dual-stack listener reports as
 * `::ffff:a.b.c.d` for an IPv4 client.
 */
export function isAllowedNotifyAddress(
  ip: string | undefined,
  allowed: readonly string[],
): boolean {
  if (ip === undefined) return false;
  const address = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  return allowed.includes(address);
}

/** ReturnUrl / StopUrl of a payment: the web origin, so the browser stays same-site, and the Moid in `m`. */
export function smartroCallbackUrl(
  webOrigin: string,
  kind: 'return' | 'stop',
  moid: string,
): string {
  return `${webOrigin}${SMARTRO_CALLBACK_PATH}/${kind}?m=${moid}`;
}

/**
 * ResultCodes that mean "approved", whatever the PayMethod the payer ended up using in the
 * window (it may switch from CARD to an easy-pay option, which ShowEasyPay leaves visible):
 * 3001 CARD, 4000 BANK, A000 CELLPHONE, KP00 KAKAO, NP00 NAVER, PP00 PAYCO, LP00 LPAY,
 * PI00 PINPAY, 0000 SAMSUNGPAY/TOSS/TMONEYPAY/SMILEPAY and the rest. 4100/4110 (a virtual
 * account issued or paid) are deliberately absent: we only ever ask for CARD.
 */
const APPROVAL_SUCCESS_CODES: ReadonlySet<string> = new Set([
  '3001',
  '4000',
  'A000',
  'KP00',
  'NP00',
  'PP00',
  'LP00',
  'PI00',
  '0000',
]);

/** 2001 cancelled; 2013 already cancelled — a retried cancel whose first answer was lost. */
const CANCEL_SUCCESS_CODES: ReadonlySet<string> = new Set(['2001', '2013']);

export function isApprovalSuccess(resultCode: string | undefined): boolean {
  return resultCode !== undefined && APPROVAL_SUCCESS_CODES.has(resultCode);
}

export function isCancelSuccess(resultCode: string | undefined): boolean {
  return resultCode !== undefined && CANCEL_SUCCESS_CODES.has(resultCode);
}

/** `base64(sha256(text))` over the UTF-8 bytes — the one digest every SmartroPay signature uses. */
function sha256Base64(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

/** The request signature: `EncryptData = base64(sha256(EdiDate + Mid + Amt + MerchantKey))`. */
export function encryptData(
  ediDate: string,
  mid: string,
  amt: string,
  merchantKey: string,
): string {
  return sha256Base64(ediDate + mid + amt + merchantKey);
}

/**
 * The result signature: `base64(sha256(Tid[0:10] + ResultCode + Tid[10:15] + MerchantKey +
 * Tid[15:]))`. The approval answer and every 재통보 carry one.
 */
export function signValue(tid: string, resultCode: string, merchantKey: string): string {
  return sha256Base64(
    tid.slice(0, 10) + resultCode + tid.slice(10, 15) + merchantKey + tid.slice(15),
  );
}

/** Whether `given` is the SignValue of (tid, resultCode), compared in constant time. */
export function verifySignValue(
  given: string,
  tid: string,
  resultCode: string,
  merchantKey: string,
): boolean {
  const expected = Buffer.from(signValue(tid, resultCode, merchantKey), 'utf8');
  const actual = Buffer.from(given, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The cancel's own check: `HashData = base64(sha256(Tid + MerchantKey + CancelAmt + PartialCancelCode))`. */
export function cancelHashData(
  tid: string,
  merchantKey: string,
  cancelAmt: string,
  partialCancelCode: string,
): string {
  return sha256Base64(tid + merchantKey + cancelAmt + partialCancelCode);
}

/**
 * The cancel request's `EncData`: the parameter JSON under AES-256-CBC with PKCS#7 padding,
 * keyed by the first 32 characters of the merchant key as UTF-8 bytes, a zero IV, base64 out.
 * A merchant key whose first 32 characters are not 32 bytes (a non-ASCII key) throws rather
 * than encrypting under a key SmartroPay does not hold.
 */
export function encryptCancelPayload(json: string, merchantKey: string): string {
  const key = Buffer.from(merchantKey.substring(0, 32), 'utf8');
  if (key.length !== 32)
    throw new RangeError('the merchant key must start with 32 ASCII characters');
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16, 0));
  return Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]).toString('base64');
}

/** Korea has no daylight saving time, so Asia/Seoul is UTC+9 all year. */
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `yyyyMMddHHmmss` of `at` in Asia/Seoul: the EdiDate SmartroPay expects (the containers run UTC). */
export function ediDate(at: Date): string {
  return new Date(at.getTime() + SEOUL_OFFSET_MS).toISOString().replace(/[-T:]/g, '').slice(0, 14);
}

/**
 * The SDK URLs of `mode` with the manual's `?version=<yyyyMMdd>` cache-buster (the Seoul date of
 * `at`), so a browser picks up a new SDK within a day.
 */
export function smartroScriptUrls(mode: SmartroMode, at: Date): { pc: string; mobile: string } {
  const version = ediDate(at).slice(0, 8);
  const hosts = SMARTRO_SCRIPT_HOSTS[mode];
  const path = `/asset/js/SmartroPAY-1.0.min.js?version=${version}`;
  return { pc: hosts.pc + path, mobile: hosts.mobile + path };
}

/**
 * `MallUserId` (≤ 20 characters): stable per account so the PG can key easy-pay members, but
 * not reversible to our user id — the first 20 hex digits of its SHA-256.
 */
export function mallUserId(userId: string): string {
  return createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 20);
}

/** `GoodsName` (≤ 40 characters): what the payer sees in the window, e.g. `포인트 10,000P`. */
export function goodsName(amountP: bigint): string {
  return `포인트 ${formatP(amountP)}`;
}

/** SmartroPay length limits are in characters; a string longer than `max` is cut, never rejected. */
export function truncateChars(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}
