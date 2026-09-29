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
export const APPROVAL_SUCCESS_CODES: readonly string[] = [
  '3001',
  '4000',
  'A000',
  'KP00',
  'NP00',
  'PP00',
  'LP00',
  'PI00',
  '0000',
];

const APPROVAL_SUCCESS: ReadonlySet<string> = new Set(APPROVAL_SUCCESS_CODES);

export function isApprovalSuccess(resultCode: string | null | undefined): boolean {
  return typeof resultCode === 'string' && APPROVAL_SUCCESS.has(resultCode);
}

/**
 * Approval answers that are no decline: the PG's own side failed, or its link to the card
 * company or easy-pay did, so the answer does not say whether the card was charged (the 통합코드
 * table's own words). The approval still fails the payment (ADR-0042 「ReturnUrl」 step 5, an owner
 * decision); the admin list flags such a claimed `failed` payment (`needsReview`) so a person
 * checks the card in the merchant admin. Only the methods a CARD window reaches (the card and
 * the easy-pays ShowEasyPay leaves visible) and the payment server's own error codes:
 * - undefined or system errors, retry later: 9999 (미지정 오류 / 시스템에러 - 잠시 후 재거래;
 *   토스페이: 정의되지 않은 코드… PG사로 문의), W999 (시스템에러 잠시후 재 거래);
 * - the payment server's internal failures: W027–W030 (내부 처리 오류, DB Insert/Update/Select),
 *   W051 (데이터 저장 실패, code.do_level_ L1647–1648 — its own storage failing, after the card
 *   company may have approved);
 * - W038 (중복 결제 요청, code.do_level_ L1621–1622): an approval asked again for a transaction
 *   already on its way, which only a charge that went through (or is going through) can meet;
 * - a connection failing: W299 ({변수} 연결오류), NP98 / NP99 (잠시 후 재거래, 네이버페이 연결
 *   오류 / 오류), SmilePay 9998 (연결 실패), 1101 (응답 지연으로인한 실패), 1032 (서비스
 *   지연처리 발생);
 * - an error on the approver's side: LP99 (PG, 은행 및 기타 오류), PI19 (승인 중계기관 오류),
 *   PI51 (서버에서 에러가 발생), 티머니페이 6001 (처리중 에러가 발생).
 * Kept apart from classifyCancel's UNKNOWN_CODES, which answer a cancel, not an approval — but
 * every generic one of those (NP98, NP99, LP99, 9999, SmilePay's 1101 and 9998) is here too.
 * A false positive only costs a person one look, so a code in doubt is flagged.
 *
 * Deliberately NOT here: 3002 (VAN실패 응답, L571–572) and 3095 (카드사 실패 응답, L625–626).
 * Each is the card side's own answer — the VAN, or the card company, answered and said no — so
 * the charge was refused, not left unknown; flagging them would flag every such decline. (The
 * manual gives them no text beyond that; if one ever turns out to be a VAN link failure, it
 * belongs here.) Nor are the
 * generic easy-pay "결제 실패" codes (PP01, KP01, NP01, S999: declines), the result inquiry's own
 * codes (6017, 6021, W036: an inquiry fails no payment), or codes of methods a CARD window never
 * reaches (A101, 4008, TS51, W210, W399, PS51).
 */
export const APPROVAL_UNKNOWN_CODES: readonly string[] = [
  '9999',
  'W999',
  'W027',
  'W028',
  'W029',
  'W030',
  'W051',
  'W038',
  'W299',
  'NP98',
  'NP99',
  'LP99',
  'PI19',
  'PI51',
  '6001',
  '1032',
  '1101',
  '9998',
];

const APPROVAL_UNKNOWN: ReadonlySet<string> = new Set(APPROVAL_UNKNOWN_CODES);

/** Whether an approval's ResultCode is no decline but the PG's failure (APPROVAL_UNKNOWN_CODES). */
export function isApprovalUnknown(resultCode: string | null | undefined): boolean {
  return typeof resultCode === 'string' && APPROVAL_UNKNOWN.has(resultCode);
}

/** A KRW amount as SmartroPay writes it (digits only, above zero), or null. */
export function parseKrw(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,12}$/.test(value)) return null;
  const amount = Number(value);
  return amount > 0 ? amount : null;
}

/**
 * What a cancel answer says about the card (the 통합코드 table):
 * - `cancelled`: it is cancelled now, or was already.
 * - `refused`: a definite "no" — the card stays charged, so a refund may put the P back.
 * - `unknown`: the card may or may not be cancelled — never put P back or reopen on this.
 */
export type CancelClassification = 'cancelled' | 'refused' | 'unknown';

/**
 * Cancelled whatever the method: 2001 취소 성공, 2013 기취소 (a retried cancel whose first
 * answer was lost), and the easy-pay "already cancelled" codes, whose prefix names their payer
 * (NP17 NaverPay, LP17 L.pay: 이미 전체 취소된 결제; PI15 PinPay: 이미 취소 완료된 결제).
 */
const CANCELLED_CODES: ReadonlySet<string> = new Set(['2001', '2013', 'NP17', 'LP17', 'PI15']);

/**
 * "Already cancelled" codes that mean it only for ONE method: for CARD, 2015 is 해당거래
 * 취소실패 — an ordinary refusal — and only SmilePay uses it for 기취소 거래; 3402 is T-money's.
 */
const CANCELLED_CODES_BY_METHOD: Readonly<Record<string, ReadonlySet<string>>> = {
  SMILEPAY: new Set(['2015']),
  TMONEYPAY: new Set(['3402']),
};

/**
 * Unknown whatever the method: NP19/NP24 and LP19/LP24 (a previous cancel is not finished and
 * must be retried), 2045 취소 차수 불일치 (a CancelSeq=1 resend after a completed cancel), and
 * the unspecified or connection errors NP98, NP99, LP99 and 9999.
 */
const UNKNOWN_CODES: ReadonlySet<string> = new Set([
  'NP19',
  'NP24',
  'LP19',
  'LP24',
  '2045',
  'NP98',
  'NP99',
  'LP99',
  '9999',
]);

/** SmilePay's own "no answer": 1101 응답 지연으로 인한 실패, 9998 연결 실패. */
const UNKNOWN_CODES_BY_METHOD: Readonly<Record<string, ReadonlySet<string>>> = {
  SMILEPAY: new Set(['1101', '9998']),
};

/**
 * Classifies a cancel answer by its ResultCode and the payment's PayMethod (`payments.method`,
 * or the answer's own PayMethod when the payment has none): the codes are per method, and one
 * number can mean "already cancelled" for one method and "refused" for another. No ResultCode
 * at all says nothing about the card: `unknown`.
 */
export function classifyCancel(
  resultCode: string | undefined,
  method: string | null | undefined,
): CancelClassification {
  const code = resultCode?.trim().toUpperCase() ?? '';
  if (code.length === 0) return 'unknown';
  const payMethod = method?.trim().toUpperCase() ?? '';
  if (CANCELLED_CODES.has(code) || CANCELLED_CODES_BY_METHOD[payMethod]?.has(code)) {
    return 'cancelled';
  }
  if (UNKNOWN_CODES.has(code) || UNKNOWN_CODES_BY_METHOD[payMethod]?.has(code)) return 'unknown';
  return 'refused';
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
