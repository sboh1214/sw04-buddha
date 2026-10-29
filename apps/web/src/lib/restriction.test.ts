import { type ErrorCode } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { BUSINESS_INFO } from '@/legal/business-info';
import { ApiError } from './api';
import { formatInTimeZone, formatKst } from './datetime';
import {
  isRestricted,
  restrictedMessage,
  restrictionEndText,
  restrictionOf,
  restrictionTermText,
  restrictionsShown,
  WRITE_PAGE_RESTRICTION_KINDS,
} from './restriction';

/**
 * 작성 제한 (#185, ADR-0082) and 계정 제한 (#139, ADR-0085) as a refused write says them:
 * RESTRICTED's end in the member's zone or 무기한, which restriction and what it keeps closed, with
 * the way to 조치·신고 내역 under it — no appeal sentence and no deadline in the refusal (owner
 * decision 2026-10-22 evening, via #186: «끝나는 시각과 조치·신고 내역 링크(기한은 내역에)») — and the
 * banner's restrictions from the member's own read of them.
 */

const END = '2026-10-23T06:00:00.000Z';

function refused(status: number, code: ErrorCode, details?: unknown): ApiError {
  return new ApiError(status, { code, message: code, details });
}

const restricted = (endsAt: string | null) =>
  refused(403, 'RESTRICTED', { kind: 'writing', endsAt });
const accountRestricted = (endsAt: string | null) =>
  refused(403, 'RESTRICTED', { kind: 'account', endsAt });

describe('RESTRICTED', () => {
  it('reads the kind’s end, null for 무기한, and nothing of any other answer', () => {
    expect(restrictionOf(restricted(END))).toEqual({ kind: 'writing', endsAt: END });
    expect(restrictionOf(restricted(null))).toEqual({ kind: 'writing', endsAt: null });
    expect(restrictionOf(accountRestricted(END))).toEqual({ kind: 'account', endsAt: END });
    // Never from this API, which always sends them: the refusal is said without the end. (A
    // kind the API never sends stands for the unreadable.)
    expect(restrictionOf(refused(403, 'RESTRICTED', { kind: 'trading', endsAt: END }))).toEqual({
      kind: undefined,
      endsAt: undefined,
    });
    expect(restrictionOf(refused(403, 'FORBIDDEN'))).toBeUndefined();
    expect(restrictionOf(new TypeError('Failed to fetch'))).toBeUndefined();
  });

  it('tells a restriction’s refusal apart, which the screens follow with the way to 조치·신고 내역', () => {
    expect(isRestricted(restricted(END))).toBe(true);
    expect(isRestricted(restricted(null))).toBe(true);
    expect(isRestricted(accountRestricted(null))).toBe(true);
    expect(isRestricted(refused(403, 'RESTRICTED', { kind: 'x' }))).toBe(true);
    for (const error of [
      refused(403, 'FORBIDDEN'),
      refused(409, 'ONBOARDING_REQUIRED'),
      refused(429, 'RATE_LIMITED'),
      new TypeError('Failed to fetch'),
      null,
    ]) {
      expect(isRestricted(error)).toBe(false);
    }
  });

  it('writes the end in the member’s zone, or 무기한', () => {
    const tokyo = (iso: string) => formatInTimeZone(iso, 'Asia/Tokyo');
    expect(restrictionTermText(END, formatKst)).toBe(`${formatKst(END)}까지`);
    expect(restrictionTermText(END, tokyo)).toBe(`${tokyo(END)}까지`);
    expect(restrictionTermText(null, formatKst)).toBe('무기한');
    expect(restrictionEndText(END, formatKst)).toBe(formatKst(END));
    expect(restrictionEndText(null, formatKst)).toBe(copy.restrictionIndefinite);
  });

  it('says what it closes and until when, and nothing of the appeal (owner decision 2026-10-22)', () => {
    expect(restrictedMessage(restricted(END), 'writing', formatKst)).toBe(
      `작성 제한 중에는 글·댓글을 쓰거나 고칠 수 없습니다(${formatKst(END)}까지).`,
    );
    expect(restrictedMessage(restricted(null), 'writing', formatKst)).toBe(
      '작성 제한 중에는 글·댓글을 쓰거나 고칠 수 없습니다(무기한).',
    );
    // A public profile item in MY 설정: clearing it stays open (ADR-0069 decision 7).
    expect(restrictedMessage(restricted(END), 'profile', formatKst)).toBe(
      `작성 제한 중에는 공개 프로필을 새 값으로 바꿀 수 없습니다(${formatKst(END)}까지). 비우거나 지우는 것은 할 수 있습니다.`,
    );
    // The onboarding's interests step: nothing on that screen to clear — 건너뛰기 stays open
    // (owner decision 2026-10-23 answer 9).
    expect(restrictedMessage(restricted(END), 'onboardingInterests', formatKst)).toBe(
      `작성 제한 중에는 공개 프로필을 새 값으로 바꿀 수 없습니다(${formatKst(END)}까지). 건너뛰기는 할 수 있습니다.`,
    );
    expect(restrictedMessage(restricted(null), 'onboardingInterests', formatKst)).toBe(
      '작성 제한 중에는 공개 프로필을 새 값으로 바꿀 수 없습니다(무기한). 건너뛰기는 할 수 있습니다.',
    );
    // Each sentence of what stays open on its own screen only.
    for (const write of ['writing', 'nickname'] as const) {
      const message = restrictedMessage(restricted(END), write, formatKst) ?? '';
      expect(message).not.toContain(copy.errRestrictedClearAllowed);
      expect(message).not.toContain(copy.errRestrictedSkipAllowed);
    }
    expect(restrictedMessage(restricted(END), 'profile', formatKst)).not.toContain(
      copy.errRestrictedSkipAllowed,
    );
    expect(restrictedMessage(restricted(null), 'nickname', formatKst)).toBe(
      '작성 제한 중에는 닉네임을 바꿀 수 없습니다(무기한).',
    );
    expect(restrictedMessage(refused(403, 'RESTRICTED', { kind: 'x' }), 'writing', formatKst)).toBe(
      '작성 제한 중에는 글·댓글을 쓰거나 고칠 수 없습니다.',
    );
    expect(restrictedMessage(refused(403, 'FORBIDDEN'), 'writing', formatKst)).toBeUndefined();
    // No appeal sentence, deadline nor email in any of them: those are 조치·신고 내역's.
    for (const write of ['writing', 'profile', 'onboardingInterests', 'nickname'] as const) {
      for (const endsAt of [END, null]) {
        const message = restrictedMessage(restricted(endsAt), write, formatKst) ?? '';
        expect(message).not.toContain('이의');
        expect(message).not.toContain('14일');
        expect(message).not.toContain(BUSINESS_INFO.email);
        expect(message).not.toContain('{{');
      }
    }
  });
});

describe('RESTRICTED of an account restriction (#139, ADR-0085)', () => {
  it('names the account restriction where it refuses: a public profile item’s new value, a nickname (ADR-0069 decision 3 #37-9)', () => {
    expect(restrictedMessage(accountRestricted(END), 'profile', formatKst)).toBe(
      `계정 제한 중에는 공개 프로필을 새 값으로 바꿀 수 없습니다(${formatKst(END)}까지). 비우거나 지우는 것은 할 수 있습니다.`,
    );
    expect(restrictedMessage(accountRestricted(null), 'profile', formatKst)).toBe(
      '계정 제한 중에는 공개 프로필을 새 값으로 바꿀 수 없습니다(무기한). 비우거나 지우는 것은 할 수 있습니다.',
    );
    expect(restrictedMessage(accountRestricted(END), 'onboardingInterests', formatKst)).toBe(
      `계정 제한 중에는 공개 프로필을 새 값으로 바꿀 수 없습니다(${formatKst(END)}까지). 건너뛰기는 할 수 있습니다.`,
    );
    expect(restrictedMessage(accountRestricted(null), 'nickname', formatKst)).toBe(
      '계정 제한 중에는 닉네임을 바꿀 수 없습니다(무기한).',
    );
    // An account restriction refuses no writing (#57-12): were the API to say so, the sentence is
    // the writing restriction's, the only one that closes it.
    expect(restrictedMessage(accountRestricted(END), 'writing', formatKst)).toBe(
      `작성 제한 중에는 글·댓글을 쓰거나 고칠 수 없습니다(${formatKst(END)}까지).`,
    );
    // No appeal sentence, deadline, email — nor anything of who asked or approved.
    for (const write of ['profile', 'onboardingInterests', 'nickname'] as const) {
      for (const endsAt of [END, null]) {
        const message = restrictedMessage(accountRestricted(endsAt), write, formatKst) ?? '';
        expect(message.startsWith('계정 제한 중에는')).toBe(true);
        expect(message).not.toContain('이의');
        expect(message).not.toContain('14일');
        expect(message).not.toContain('운영자');
        expect(message).not.toContain(BUSINESS_INFO.email);
      }
    }
  });
});

describe('the banner’s restrictions (`GET /me/moderation/restriction`)', () => {
  const NOW = Date.parse('2026-10-22T12:00:00.000Z');
  const none = { restriction: null, accountRestriction: null };

  it('shows the one the member’s read answers, until its end and not at it', () => {
    const term = { kind: 'writing' as const, endsAt: new Date(NOW + 1).toISOString() };
    expect(restrictionsShown({ ...none, restriction: term }, NOW)).toEqual([term]);
    // Its end passed while the page was open: a term ends by itself (#45-12).
    expect(
      restrictionsShown(
        { ...none, restriction: { kind: 'writing', endsAt: new Date(NOW).toISOString() } },
        NOW,
      ),
    ).toEqual([]);
    // 무기한: until an operator lifts it.
    const indefinite = { kind: 'writing' as const, endsAt: null };
    expect(restrictionsShown({ ...none, restriction: indefinite }, NOW)).toEqual([indefinite]);
  });

  it('shows an account restriction the same way, and both — the writing one first — when both stand (#139)', () => {
    const account = { kind: 'account' as const, endsAt: new Date(NOW + 1).toISOString() };
    expect(restrictionsShown({ ...none, accountRestriction: account }, NOW)).toEqual([account]);
    expect(
      restrictionsShown(
        { ...none, accountRestriction: { kind: 'account', endsAt: new Date(NOW).toISOString() } },
        NOW,
      ),
    ).toEqual([]);
    const writing = { kind: 'writing' as const, endsAt: null };
    expect(restrictionsShown({ restriction: writing, accountRestriction: account }, NOW)).toEqual([
      writing,
      account,
    ]);
    // One ended, the other stands: the standing one alone.
    expect(
      restrictionsShown(
        {
          restriction: { kind: 'writing', endsAt: new Date(NOW - 1).toISOString() },
          accountRestriction: account,
        },
        NOW,
      ),
    ).toEqual([account]);
  });

  it('keeps the account restriction off the write page’s banner: MY 요약 and MY 설정 only (owner decision 2026-10-23)', () => {
    const account = { kind: 'account' as const, endsAt: null };
    const writing = { kind: 'writing' as const, endsAt: new Date(NOW + 1).toISOString() };
    expect(WRITE_PAGE_RESTRICTION_KINDS).toEqual(['writing']);
    expect(
      restrictionsShown(
        { ...none, accountRestriction: account },
        NOW,
        WRITE_PAGE_RESTRICTION_KINDS,
      ),
    ).toEqual([]);
    expect(
      restrictionsShown(
        { restriction: writing, accountRestriction: account },
        NOW,
        WRITE_PAGE_RESTRICTION_KINDS,
      ),
    ).toEqual([writing]);
    // The other pages speak of both.
    expect(restrictionsShown({ restriction: writing, accountRestriction: account }, NOW)).toEqual([
      writing,
      account,
    ]);
  });

  it('shows nothing while the read has not answered, nor when none stands', () => {
    expect(restrictionsShown(undefined, NOW)).toEqual([]);
    expect(restrictionsShown(none, NOW)).toEqual([]);
  });
});
