import { describe, expect, it } from 'vitest';
import { NO_EMAIL_DOMAIN, PAID_COIN_SALES_ENABLED, isNoEmailAddress } from './constants.js';

describe('isNoEmailAddress', () => {
  it('recognises the synthetic Kakao/Naver addresses only', () => {
    expect(isNoEmailAddress(`kakao_123@${NO_EMAIL_DOMAIN}`)).toBe(true);
    expect(isNoEmailAddress(`NAVER_abc@${NO_EMAIL_DOMAIN.toUpperCase()}`)).toBe(true);
    expect(isNoEmailAddress('someone@example.com')).toBe(false);
    expect(isNoEmailAddress(`someone@sub.${NO_EMAIL_DOMAIN}`)).toBe(false);
  });
});

describe('PAID_COIN_SALES_ENABLED', () => {
  it('keeps paid Coin closed in the initial product (D9, ADR-0049; reopening is #111)', () => {
    expect(PAID_COIN_SALES_ENABLED).toBe(false);
  });
});
