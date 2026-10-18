/**
 * The one seam between 본인확인 (#183, ADR-0070) and whoever texts the code: 알리고 (the provider
 * the owner chose, ADR-0069 decision 1 #57-3) or the development sender, picked by SMS_PROVIDER
 * (sms.provider.ts). Another provider is another implementation of this interface.
 *
 * A sender takes the values of the message, not its words: each one writes the text from a
 * registered template (SMS_TEMPLATES, or the dev sender's mail template), so every word a member
 * can receive is a string the guard tests read (sms/templates.test.ts, mail/templates.test.ts).
 */
export interface VerificationCodeSms {
  /** The mobile number, digits only (`phoneSchema`): 01012345678. */
  to: string;
  /** The six digits. */
  code: string;
  /** How long the code is valid, as the text says it. */
  expiresInMinutes: number;
}

export interface SmsSender {
  /**
   * Resolves once the provider has taken the message — never a success for a text that was not
   * handed over — and otherwise rejects with an SmsSendError that says whether the text certainly
   * did not go (`refused`) or may have gone (`unknown`). The rejection's message carries neither
   * the number nor the code, since the API logs it. A rejection that is not an SmsSendError is
   * read as `unknown`: nothing then claims a send that may have reached a phone did not happen.
   */
  sendVerificationCode(sms: VerificationCodeSms): Promise<void>;
}

/** Injection token of the configured sender. Tests override it with an in-memory one. */
export const SMS_SENDER = Symbol('SMS_SENDER');

/**
 * What a failed send means for the text (ADR-0070 decision 7-3):
 *
 * - `refused`: it certainly did not go. Nothing reached the provider (no keys, the connection
 *   was refused or the host not found), or the provider answered and said no (a 4xx, a refusing
 *   `result_code`, no receiver taken).
 * - `unknown`: it may have gone. The request may have reached the provider but no readable
 *   answer came back — a timeout or a connection lost after sending, a 5xx, a 2xx that is not
 *   the provider's answer — so the provider may have taken it and texted the code.
 *
 * PhoneVerificationService forgets a `refused` send and keeps an `unknown` one: only a send that
 * certainly did not happen may leave the fixed daily limits uncounted. It answers them apart —
 * SMS_SEND_FAILED and SMS_SEND_UNCONFIRMED — so the screen can say the text may have come.
 */
export type SmsSendOutcome = 'refused' | 'unknown';

/**
 * Why a send failed, in words that hold no number and no code: the provider's result code and
 * message, an HTTP status, a network error's name. `redactDigits` is applied to anything a
 * provider or a transport wrote, which could quote the receiver. `outcome` is what the failure
 * says about the text: certainly not sent, or perhaps sent.
 */
export class SmsSendError extends Error {
  readonly outcome: SmsSendOutcome;

  constructor(outcome: SmsSendOutcome, message: string) {
    super(redactDigits(message));
    this.name = 'SmsSendError';
    this.outcome = outcome;
  }
}

/** The outcome a sender's rejection means: `unknown` unless an SmsSendError says `refused`. */
export function sendOutcome(error: unknown): SmsSendOutcome {
  return error instanceof SmsSendError ? error.outcome : 'unknown';
}

/**
 * `text` with every run of six or more digits replaced: a phone number (10–11 digits) or a code
 * (six) a provider's or a mail server's message might quote never reaches a log line.
 */
export function redactDigits(text: string): string {
  return text.replace(/\d{6,}/g, '[digits]');
}
