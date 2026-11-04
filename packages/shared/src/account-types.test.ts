import { describe, expect, it } from 'vitest';
import { closedAccountEmail } from './account-closure.js';
import { MARKET_MAKER_ACCOUNT_EMAIL, isHumanAccountType } from './account-types.js';
import { NO_EMAIL_DOMAIN, isNoEmailAddress } from './constants.js';
import { ACCOUNT_TYPES, ROLES } from './enums.js';

describe('account types (#115)', () => {
  it('has the two types the owner named, and no test-account or system type', () => {
    // ADR-0107 결정 4 #115: '일반 사용자'와 '운영 마켓메이커' 둘; 결정 2 #73 11항: 금고·담보는
    // 계정 유형이 아니다.
    expect(ACCOUNT_TYPES).toEqual(['member', 'market_maker']);
    // A value of its own, not the role's 'user' (the admin role is separate, #177 13항).
    expect(ACCOUNT_TYPES.filter((type) => (ROLES as readonly string[]).includes(type))).toEqual([]);
  });

  it('answers a person for 일반 사용자 only', () => {
    expect(ACCOUNT_TYPES.filter(isHumanAccountType)).toEqual(['member']);
    expect(isHumanAccountType('market_maker')).toBe(false);
  });

  it('gives the 운영 마켓메이커 an address no mail and no sign-in reaches, nobody else’s', () => {
    expect(MARKET_MAKER_ACCOUNT_EMAIL).toBe(`market-maker@${NO_EMAIL_DOMAIN}`);
    expect(isNoEmailAddress(MARKET_MAKER_ACCOUNT_EMAIL)).toBe(true);
    // A social placeholder is `{provider}_{id}@…` and a closed account's `closed_{id}@…`: a local
    // part with no '_' is neither, whatever the id.
    const [local] = MARKET_MAKER_ACCOUNT_EMAIL.split('@');
    expect(local).not.toContain('_');
    expect(MARKET_MAKER_ACCOUNT_EMAIL).not.toBe(closedAccountEmail('market-maker'));
  });
});
