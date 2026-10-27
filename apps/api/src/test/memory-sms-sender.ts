import {
  SmsSendError,
  type SmsSender,
  type SmsSendOutcome,
  type VerificationCodeSms,
} from '../sms/sms-sender.js';

export interface MemorySmsSender extends SmsSender {
  /** Every verification code sent so far, oldest first. */
  messages: VerificationCodeSms[];
  /**
   * Makes the next sends reject. `refused` is the provider saying no, or out of reach before the
   * request left: no message is recorded. `unknown` is a send whose answer was lost after the
   * provider took it (a timeout): the message IS recorded — the phone got the text — and the
   * send rejects all the same.
   */
  failNext(times: number, outcome?: SmsSendOutcome): void;
  /** Makes the next send take `ms` before it resolves or rejects (a slow provider). */
  delayNext(ms: number): void;
  /** The code of the newest message to `phone` (digits), or a throw when there is none. */
  lastCodeTo(phone: string): string;
}

/** In-memory SmsSender for tests: records messages instead of texting anyone. */
export function createMemorySmsSender(): MemorySmsSender {
  let failures = 0;
  let failureOutcome: SmsSendOutcome = 'refused';
  let delayMs = 0;
  const messages: VerificationCodeSms[] = [];
  return {
    messages,
    failNext(times, outcome = 'refused') {
      failures = times;
      failureOutcome = outcome;
    },
    delayNext(ms) {
      delayMs = ms;
    },
    lastCodeTo(phone) {
      const message = messages.findLast((candidate) => candidate.to === phone);
      if (message === undefined) throw new Error(`no code was texted to ${phone}`);
      return message.code;
    },
    async sendVerificationCode(sms) {
      if (delayMs > 0) {
        const ms = delayMs;
        delayMs = 0;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      if (failures > 0) {
        failures -= 1;
        if (failureOutcome === 'unknown') messages.push(sms);
        throw new SmsSendError(failureOutcome, 'provider unavailable (memory sender)');
      }
      messages.push(sms);
      await Promise.resolve();
    },
  };
}
