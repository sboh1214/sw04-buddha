import * as z from 'zod';
import { SmsSendError, type SmsSender, type VerificationCodeSms } from './sms-sender.js';
import { SMS_TEMPLATES } from './templates.js';

/** 알리고's single-send endpoint (문자보내기): HTTPS POST, form-encoded, JSON answer. */
export const ALIGO_SEND_URL = 'https://apis.aligo.in/send/';

export interface AligoCredentials {
  /** 인증용 API Key. */
  apiKey: string;
  /** The account id the key belongs to. */
  userId: string;
  /** The sender number registered with 알리고 (발신번호), digits. */
  sender: string;
}

export interface AligoSmsSenderOptions {
  /** Undefined when ALIGO_* are not set: every send then fails (owner decision, ADR-0069). */
  credentials: AligoCredentials | undefined;
  /** `testmode_yn=Y`: answered as usual, texted to nobody and not charged (ALIGO_TEST_MODE). */
  testMode: boolean;
  /** For tests; the global `fetch` otherwise. */
  fetch?: typeof fetch;
  /** How long a send may take before it counts as failed. Default 10 s. */
  timeoutMs?: number;
}

/**
 * What `/send/` answers: `result_code` 1 when it took the request (negative with the reason in
 * `message` when not), and the counts of the receivers it took and refused. Numbers may come as
 * strings, so they are coerced; anything else in the answer is ignored.
 */
const aligoAnswerSchema = z.object({
  result_code: z.coerce.number(),
  message: z.string().optional(),
  success_cnt: z.coerce.number().optional(),
});

/**
 * Connection failures that happen before a byte of the request leaves (undici's `cause.code`):
 * the provider never saw the send. Any other network failure — a timeout, a reset or a socket
 * closed mid-request — may come after 알리고 took the message.
 */
const NOT_SENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * 알리고 (ADR-0069 decision 1 #57-3): one short SMS (`msg_type=SMS`, the template fits 90 bytes)
 * to one receiver from the registered sender number. A send is a success only when the HTTP
 * answer is 2xx, its JSON says `result_code` 1 and, when it counts receivers, it took one;
 * anything else rejects with an SmsSendError naming the provider's result code and message, never
 * the number or the code. The rejection also says whether the text may have gone anyway
 * (`SmsSendOutcome`, ADR-0070 decision 7-3):
 *
 * - `refused` — no keys; a connection that failed before sending (`NOT_SENT_NETWORK_CODES`); an
 *   HTTP answer below 500 that is not 2xx; a refusing `result_code`; no receiver taken.
 * - `unknown` — a timeout (AbortSignal) or any other network failure; a 5xx, which a gateway in
 *   front of 알리고 can answer after the message was taken; a 2xx whose body is not 알리고's JSON.
 *
 * 알리고 has no delivery webhook: what it took is what the API knows.
 */
export function createAligoSmsSender(options: AligoSmsSenderOptions): SmsSender {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async sendVerificationCode(sms: VerificationCodeSms): Promise<void> {
      const credentials = options.credentials;
      if (credentials === undefined) {
        throw new SmsSendError(
          'refused',
          'aligo: ALIGO_API_KEY, ALIGO_USER_ID and ALIGO_SENDER are not set',
        );
      }
      const { text } = SMS_TEMPLATES.verificationCode({
        code: sms.code,
        expiresInMinutes: sms.expiresInMinutes,
      });
      const body = new URLSearchParams({
        key: credentials.apiKey,
        user_id: credentials.userId,
        sender: credentials.sender,
        receiver: sms.to,
        msg: text,
        msg_type: 'SMS',
      });
      if (options.testMode) body.set('testmode_yn', 'Y');

      let response: Response;
      try {
        response = await send(ALIGO_SEND_URL, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const code = networkErrorCode(error);
        throw new SmsSendError(
          code !== undefined && NOT_SENT_NETWORK_CODES.has(code) ? 'refused' : 'unknown',
          `aligo unreachable: ${describeNetworkError(error)}`,
        );
      }
      if (!response.ok) {
        throw new SmsSendError(
          response.status >= 500 ? 'unknown' : 'refused',
          `aligo answered HTTP ${String(response.status)}`,
        );
      }
      let answer: z.infer<typeof aligoAnswerSchema>;
      try {
        answer = aligoAnswerSchema.parse(await response.json());
      } catch {
        // A 2xx: whatever sits in front of 알리고 accepted the request, and nothing says it did
        // not pass it on.
        throw new SmsSendError('unknown', 'aligo answered something other than its JSON');
      }
      if (answer.result_code !== 1) {
        throw new SmsSendError(
          'refused',
          `aligo refused: result_code ${String(answer.result_code)} ${answer.message ?? ''}`.trim(),
        );
      }
      if (answer.success_cnt !== undefined && answer.success_cnt < 1) {
        throw new SmsSendError('refused', `aligo took no receiver: ${answer.message ?? ''}`.trim());
      }
    },
  };
}

/** The system code of a network failure (`ECONNREFUSED`), from undici's `cause`. */
function networkErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause = error.cause as { code?: unknown } | undefined;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

/** A network failure's name and system code (`TimeoutError`, `TypeError ECONNREFUSED`). */
function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = networkErrorCode(error);
  return code === undefined ? error.name : `${error.name} ${code}`;
}
