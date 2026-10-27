import { describe, expect, it } from 'vitest';
import {
  AUTO_NICKNAME_PREFIX,
  NICKNAME_CHANGE_INTERVAL_DAYS,
  isAutoNickname,
  keptNicknameViolation,
  NICKNAME_HOLD_DAYS,
  NICKNAME_REFUSALS,
  NICKNAME_RESERVED_WORDS,
  nicknameKey,
  nicknameNotAllowedDetailsSchema,
  nicknameRuleViolation,
  nicknameSchema,
} from './nickname.js';

describe('nicknameSchema', () => {
  it('accepts Hangul, letters, digits and underscore within 2..20 chars', () => {
    for (const ok of ['user_A7K2', '홍길동', 'user01', 'ab', '가'.repeat(20)]) {
      expect(nicknameSchema.safeParse(ok).success).toBe(true);
    }
  });

  it('rejects length and charset violations', () => {
    for (const bad of ['a', '가'.repeat(21), 'hello world', 'nick-name', '닉네임!', '']) {
      expect(nicknameSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('nickname rules (#57-6)', () => {
  it('keeps the fixed values of the owner’s decision', () => {
    expect(AUTO_NICKNAME_PREFIX).toBe('user_');
    expect(NICKNAME_CHANGE_INTERVAL_DAYS).toBe(30);
    expect(NICKNAME_HOLD_DAYS).toBe(30);
    expect(NICKNAME_RESERVED_WORDS).toEqual([
      '운영자',
      '관리자',
      '운영팀',
      '공식',
      'admin',
      'buddha',
    ]);
  });

  it('compares nicknames ignoring the case of their letters', () => {
    expect(nicknameKey('Abc_홍길동1')).toBe('abc_홍길동1');
    expect(nicknameKey('ABC')).toBe(nicknameKey('abc'));
  });

  it('lets an ordinary nickname through', () => {
    for (const ok of ['홍길동', 'trader_kim', 'abc', 'useR', 'my_user_1', '예측가_A7K2']) {
      expect(nicknameRuleViolation(ok), ok).toBeNull();
    }
  });

  it('refuses the auto nickname’s prefix in a typed one, in any case', () => {
    for (const bad of ['user_A7K2', 'user_kim', 'USER_kim', 'User_1']) {
      expect(nicknameRuleViolation(bad), bad).toBe('auto_prefix');
    }
  });

  it('refuses a reserved word anywhere in it, in any case', () => {
    for (const bad of [
      '운영자',
      '진짜운영자',
      '관리자2',
      '운영팀장',
      '공식계정',
      '비공식',
      'admin',
      'Admin_kim',
      'superADMIN',
      'buddha',
      'BuddhaFan',
    ]) {
      expect(nicknameRuleViolation(bad), bad).toBe('reserved_word');
    }
  });

  it('refuses a reserved word spread over underscores, the charset’s only separator', () => {
    for (const bad of ['관_리_자', '운영_팀', '공_식', 'ad_min', 'Ad_Min', 'admi_n', 'b_uddha']) {
      expect(nicknameRuleViolation(bad), bad).toBe('reserved_word');
    }
    // The prefix is still read on the nickname as typed: an underscore elsewhere is no prefix.
    expect(nicknameRuleViolation('my_user_1')).toBeNull();
    expect(nicknameRuleViolation('u_ser_kim')).toBeNull();
  });

  it('knows the auto nickname by its exact shape (ADR-0052)', () => {
    for (const auto of ['user_A7K2', 'user_2345', 'user_ZZZZ']) {
      expect(isAutoNickname(auto), auto).toBe(true);
    }
    // Not the trigger's: lower case, a letter it never draws (0, O, 1, I), another length.
    for (const typed of [
      'user_kim',
      'user_a7k2',
      'user_A0K2',
      'user_AOK2',
      'user_A7K',
      'USER_A7K2',
    ]) {
      expect(isAutoNickname(typed), typed).toBe(false);
    }
  });

  it('holds every nickname an account confirms as it is to the rules, but the auto one', () => {
    // The offered auto nickname is confirmed as it is (#57-6).
    expect(keptNicknameViolation('user_A7K2')).toBeNull();
    // One typed before #58 meets the rules now.
    expect(keptNicknameViolation('user_kim')).toBe('auto_prefix');
    expect(keptNicknameViolation('buddha_official')).toBe('reserved_word');
    expect(keptNicknameViolation('운_영_자')).toBe('reserved_word');
    expect(keptNicknameViolation('예측가_A7K2')).toBeNull();
    expect(keptNicknameViolation('홍길동')).toBeNull();
    // An admin's too, the seed's 관리자 included (오너 결정 2026-10-19 (2차) 2).
    expect(keptNicknameViolation('관리자')).toBe('reserved_word');
    expect(keptNicknameViolation('관리자2')).toBe('reserved_word');
  });

  it('leaves look-alikes to the reports (오너 결정 2026-10-19 (2차) 7)', () => {
    for (const lookAlike of ['adm1n', '0fficial', 'budd4a', '관1리자']) {
      expect(nicknameRuleViolation(lookAlike), lookAlike).toBeNull();
    }
  });

  it('describes each refusal, the interval with when the next change is allowed', () => {
    for (const reason of NICKNAME_REFUSALS.filter((r) => r !== 'change_interval')) {
      expect(nicknameNotAllowedDetailsSchema.parse({ reason })).toEqual({ reason });
    }
    const interval = { reason: 'change_interval', nextChangeAt: '2026-11-17T00:00:00.000Z' };
    expect(nicknameNotAllowedDetailsSchema.parse(interval)).toEqual(interval);
    expect(nicknameNotAllowedDetailsSchema.safeParse({ reason: 'change_interval' }).success).toBe(
      false,
    );
    expect(nicknameNotAllowedDetailsSchema.safeParse({ reason: 'held' }).success).toBe(false);
  });
});
