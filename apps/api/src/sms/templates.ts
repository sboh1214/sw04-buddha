/**
 * Korean text of the SMS the API sends (PLAN 0.1-6: UI strings in Korean, code in English): the
 * 본인확인 code (#183, ADR-0070). Like mail/templates.ts, every text is built here from values
 * only (a code, a number of minutes), never from words a caller picks, and this file imports
 * nothing but types — so templates.test.ts reads every word a member can receive by SMS, holds it
 * to EXCLUDED_FEATURES (@buddha/shared, #113) as mail is held, and checks that each text fits one
 * short SMS: 90 bytes in EUC-KR, the carriers' encoding, every character inside it.
 */
export interface SmsContent {
  text: string;
}

/** The service's name in a text, as mail/templates.ts writes it until PLAN 17 Q7 (brand). */
const SERVICE_NAME = 'buddha';

/** 본인확인 인증번호 (POST /me/phone-verification/code). */
export function verificationCodeSms(input: { code: string; expiresInMinutes: number }): SmsContent {
  return {
    text: `[${SERVICE_NAME}] 본인확인 인증번호는 ${input.code}입니다. ${String(input.expiresInMinutes)}분 안에 입력해 주세요.`,
  };
}

/**
 * Every SMS template, by name: functions declared in this file. The senders text what these
 * build and nothing else; a new text is a new line here, with its example inputs in
 * templates.test.ts, which the compiler asks for.
 */
export const SMS_TEMPLATES = {
  verificationCode: verificationCodeSms,
} as const satisfies Record<string, (input: never) => SmsContent>;
