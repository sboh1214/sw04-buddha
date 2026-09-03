import { describe, expect, it } from 'vitest';
import {
  changeEmailConfirmationEmail,
  passwordResetEmail,
  verificationEmail,
} from './templates.js';

const url = 'http://localhost:3000/api/auth/verify-email?token=abc&callbackURL=%2F';

/** PLAN Appendix A: gambling vocabulary must never appear in user-facing text. */
const FORBIDDEN_WORDS = ['베팅', '배당', '배당률', '승률', '판돈', '당첨'];

describe('mail templates', () => {
  it('verification email is Korean, carries the link in text and html', () => {
    const mail = verificationEmail({ url });
    expect(mail.subject).toContain('이메일 주소를 인증');
    expect(mail.text).toContain(url);
    expect(mail.html).toContain('lang="ko"');
    expect(mail.html).toContain(
      'href="http://localhost:3000/api/auth/verify-email?token=abc&amp;callbackURL=%2F"',
    );
  });

  it('password reset email states the default 60 minute validity', () => {
    const mail = passwordResetEmail({ url });
    expect(mail.subject).toContain('비밀번호 재설정');
    expect(mail.text).toContain('60분');
    expect(passwordResetEmail({ url, expiresInMinutes: 15 }).text).toContain('15분');
  });

  it('change-email confirmation names the new address', () => {
    const mail = changeEmailConfirmationEmail({ url, newEmail: 'new@example.com' });
    expect(mail.subject).toContain('이메일 변경');
    expect(mail.text).toContain('new@example.com');
    expect(mail.html).toContain('new@example.com');
  });

  it('escapes html in interpolated values', () => {
    const mail = verificationEmail({ url: 'http://x/?a=<b>&c="d"' });
    expect(mail.html).not.toContain('<b>');
    expect(mail.html).toContain('&lt;b&gt;&amp;c=&quot;d&quot;');
  });

  it('contains no forbidden vocabulary', () => {
    const all = [
      verificationEmail({ url }),
      passwordResetEmail({ url }),
      changeEmailConfirmationEmail({ url, newEmail: 'x@y.z' }),
    ];
    for (const mail of all) {
      for (const word of FORBIDDEN_WORDS) {
        expect(mail.subject + mail.text + mail.html).not.toContain(word);
      }
    }
  });
});
