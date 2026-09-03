import { describe, expect, it } from 'vitest';
import { NO_EMAIL_DOMAIN, isNoEmailAddress } from './constants.js';

describe('isNoEmailAddress', () => {
  it('recognises the synthetic Kakao/Naver addresses only', () => {
    expect(isNoEmailAddress(`kakao_123@${NO_EMAIL_DOMAIN}`)).toBe(true);
    expect(isNoEmailAddress(`NAVER_abc@${NO_EMAIL_DOMAIN.toUpperCase()}`)).toBe(true);
    expect(isNoEmailAddress('someone@example.com')).toBe(false);
    expect(isNoEmailAddress(`someone@sub.${NO_EMAIL_DOMAIN}`)).toBe(false);
  });
});
