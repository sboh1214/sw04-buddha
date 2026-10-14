/**
 * Korean copy for transactional emails (PLAN 0.1-6: UI strings in Korean, code in English).
 * Templates are pure functions of their inputs so they can be unit-tested without SMTP.
 * The wording names nothing the plan leaves out — gambling words (D21) included — which
 * templates.test.ts checks against EXCLUDED_FEATURES (@buddha/shared, #113).
 *
 * Every mail the API sends is built here and registered in MAIL_TEMPLATES (docs/GUARDS.md, #113):
 * templates.test.ts renders each registered template and reads every string in this file, and
 * fails when an exported template is not registered or when anything outside this file writes the
 * subject, text or html of a message that reaches `Mailer.send`. So that every word a mail says is
 * a string of this file, a template takes only mail inputs (a link, an address, a number:
 * MAIL_INPUTS in the test), never words its caller picks, and this file imports nothing but types.
 */
export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

/** Display name until PLAN 17 Q7 (brand) is answered. */
export const SERVICE_NAME = 'buddha';

/** Minimal HTML escaping for values interpolated into the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout(title: string, paragraphs: string[], url: string, button: string): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`).join('');
  const href = escapeHtml(url);
  return (
    `<!doctype html><html lang="ko"><body style="font-family:Pretendard,-apple-system,` +
    `'Segoe UI',sans-serif;color:#1a1a1a;line-height:1.6;padding:24px">` +
    `<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(title)}</h1>${body}` +
    `<p style="margin:20px 0"><a href="${href}" style="display:inline-block;padding:10px 18px;` +
    `background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(button)}</a></p>` +
    `<p style="margin:0 0 12px;font-size:12px;color:#666">버튼이 동작하지 않으면 아래 주소를 복사해 ` +
    `브라우저에 붙여 넣으세요.<br><a href="${href}">${href}</a></p>` +
    `</body></html>`
  );
}

/** 이메일 인증 (better-auth `emailVerification.sendVerificationEmail`) */
export function verificationEmail(input: { url: string; expiresInMinutes?: number }): EmailContent {
  // better-auth default emailVerification.expiresIn is 3600 s.
  const minutes = input.expiresInMinutes ?? 60;
  const title = `[${SERVICE_NAME}] 이메일 주소를 인증해 주세요`;
  const paragraphs = [
    `${SERVICE_NAME}에 가입해 주셔서 감사합니다.`,
    `아래 버튼을 눌러 이메일 주소를 인증해 주세요. 링크는 ${String(minutes)}분 동안만 유효합니다.`,
    '본인이 가입한 것이 아니라면 이 메일을 무시하셔도 됩니다.',
  ];
  return {
    subject: title,
    text: `${paragraphs.join('\n\n')}\n\n인증하기: ${input.url}\n`,
    html: layout(title, paragraphs, input.url, '이메일 인증하기'),
  };
}

/** 비밀번호 재설정 (better-auth `emailAndPassword.sendResetPassword`) */
export function passwordResetEmail(input: {
  url: string;
  expiresInMinutes?: number;
}): EmailContent {
  // better-auth default emailAndPassword.resetPasswordTokenExpiresIn is 3600 s.
  const minutes = input.expiresInMinutes ?? 60;
  const title = `[${SERVICE_NAME}] 비밀번호 재설정 안내`;
  const paragraphs = [
    '비밀번호 재설정 요청을 받았습니다.',
    `아래 버튼을 눌러 새 비밀번호를 설정해 주세요. 링크는 ${String(minutes)}분 동안만 유효합니다.`,
    '본인이 요청한 것이 아니라면 이 메일을 무시하셔도 됩니다. 비밀번호는 변경되지 않습니다.',
  ];
  return {
    subject: title,
    text: `${paragraphs.join('\n\n')}\n\n비밀번호 재설정: ${input.url}\n`,
    html: layout(title, paragraphs, input.url, '비밀번호 재설정하기'),
  };
}

/** 이메일 변경 확인 (better-auth `user.changeEmail.sendChangeEmailConfirmation`) */
export function changeEmailConfirmationEmail(input: {
  url: string;
  newEmail: string;
}): EmailContent {
  const title = `[${SERVICE_NAME}] 이메일 변경 확인`;
  const paragraphs = [
    `이메일 주소를 ${input.newEmail}(으)로 변경하는 요청을 받았습니다.`,
    '아래 버튼을 눌러 변경을 승인해 주세요.',
    '본인이 요청한 것이 아니라면 이 메일을 무시하셔도 됩니다. 이메일은 변경되지 않습니다.',
  ];
  return {
    subject: title,
    text: `${paragraphs.join('\n\n')}\n\n이메일 변경 승인: ${input.url}\n`,
    html: layout(title, paragraphs, input.url, '이메일 변경 승인하기'),
  };
}

/**
 * Every mail template, by name: functions declared in this file. The mail code sends what these
 * build and nothing else; a new mail is a new line here (with its example inputs in
 * templates.test.ts, which the compiler asks for, and any new input in its MAIL_INPUTS).
 */
export const MAIL_TEMPLATES = {
  verification: verificationEmail,
  passwordReset: passwordResetEmail,
  changeEmailConfirmation: changeEmailConfirmationEmail,
} as const satisfies Record<string, (input: never) => EmailContent>;
