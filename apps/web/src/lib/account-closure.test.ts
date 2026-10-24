import { ACCOUNT_CLOSURE_REFUSALS, type ErrorCode } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ACCOUNT_CLOSURE_KEY,
  CLOSURE_REFUSAL_TEXT,
  MY_CLOSURE_PATH,
  afterClosureInOrder,
  closureBlockers,
  closureCoinText,
  closureFailure,
  closureLines,
  isClosureConfirmed,
  nicknameShown,
} from './account-closure';
import { ApiError, type AccountClosureCheck } from './api';
import { formatKst } from './datetime';
import { isPrivateQueryKey } from './market-keys';
import { MY_SETTINGS_PATH, isMyTabCurrent } from './my';

/**
 * 탈퇴 (#140, ADR-0086; ADR-0069 decision 1 #57-15…#57-18, decision 3 #37-15…#37-17, decision 4
 * #140 rows): the confirmation screen's rules — where it is, what confirms, what refuses a closure
 * and how each refusal reads, the Coin it forfeits, a closed account's name on operators' screens,
 * and what follows a closure.
 */

const END = '2026-10-30T06:00:00.000Z';

function refused(status: number, code: ErrorCode, details?: unknown): ApiError {
  return new ApiError(status, { code, message: code, details });
}

const check = (overrides: Partial<AccountClosureCheck> = {}): AccountClosureCheck => ({
  availableCoin: '12000',
  refusals: [],
  restriction: null,
  startGrantReceived: false,
  pendingProposals: false,
  ...overrides,
});

describe('the confirmation screen', () => {
  it('lives under MY 설정, which stays the current tab, and names no cash-out (#113)', () => {
    expect(MY_CLOSURE_PATH).toBe('/my/settings/closure');
    expect(isMyTabCurrent(MY_CLOSURE_PATH, MY_SETTINGS_PATH)).toBe(true);
    expect(MY_CLOSURE_PATH).not.toMatch(/withdraw|cash|exchange|convert/);
  });

  it('reads the member’s check under a private root, never dehydrated', () => {
    expect(ACCOUNT_CLOSURE_KEY).toEqual(['me', 'closure']);
    expect(isPrivateQueryKey(ACCOUNT_CLOSURE_KEY)).toBe(true);
  });

  it('takes exactly ‘탈퇴’, blanks around it aside — the API’s rule (decision 4 #140)', () => {
    expect(isClosureConfirmed('탈퇴')).toBe(true);
    expect(isClosureConfirmed('  탈퇴 ')).toBe(true);
    for (const typed of ['', '탈', '탈 퇴', '탈퇴합니다', '탈퇴.', '확인', 'withdraw']) {
      expect(isClosureConfirmed(typed), typed).toBe(false);
    }
  });

  it('says what goes, that the 본인확인 record waits out its retention, and what stays (owner decision 2026-10-23 (3차) 7)', () => {
    expect(closureLines(check())).toEqual([
      { testId: 'closure-deleted', text: copy.closureDeleted },
      // Right under what goes at once: the code-send records keep the number and the real name
      // for #184's retention period (ADR-0070 2차 답 1).
      { testId: 'closure-phone-records', text: copy.closurePhoneRecords },
      { testId: 'closure-kept', text: copy.closureKept },
    ]);
    expect(copy.closurePhoneRecords).toBe(
      '휴대전화 본인확인 기록(번호·실명)은 보존기간 동안 보관된 뒤 지워집니다.',
    );
    // The line of what goes at once names neither the real name nor the number (ADR-0086 7-2).
    expect(copy.closureDeleted).not.toMatch(/실명|휴대전화|번호/);
  });

  it('tells only an account whose start Coin was paid that its number gets none again (owner decision 2026-10-23 (3차) 9)', () => {
    const lines = closureLines(check({ startGrantReceived: true }));
    expect(lines.at(-1)).toEqual({ testId: 'closure-start-grant', text: copy.closureStartGrant });
    expect(copy.closureStartGrant).toBe(
      '같은 휴대전화 번호로 다시 가입해도 시작 Coin은 다시 받을 수 없습니다.',
    );
    // A grant still waiting (cancelled by the closure, its number free again), none asked yet, or
    // the number's start Coin another account's: the API says false, and nothing is said.
    expect(closureLines(check({ startGrantReceived: false })).map((line) => line.testId)).toEqual([
      'closure-deleted',
      'closure-phone-records',
      'closure-kept',
    ]);
    // No other limit counted by number is mentioned (the same answer).
    expect(copy.closureStartGrant).not.toMatch(/한도|신고|좋아요|제안|빈도/);
  });

  it('tells only an account with a market proposal 접수 or 검토 that the operators process it and it will not see it (#77, owner decision 2026-10-24)', () => {
    const line = { testId: 'closure-proposals', text: copy.closureProposals };
    expect(copy.closureProposals).toBe(
      '낸 시장 제안은 운영자가 그대로 처리하며, 탈퇴한 뒤에는 볼 수 없습니다.',
    );
    // 접수 or 검토 (the API's `pendingProposals`): right under what stays.
    expect(closureLines(check({ pendingProposals: true }))).toEqual([
      { testId: 'closure-deleted', text: copy.closureDeleted },
      { testId: 'closure-phone-records', text: copy.closurePhoneRecords },
      { testId: 'closure-kept', text: copy.closureKept },
      line,
    ]);
    // None proposed, or every one decided or retracted (the API says false): nothing is said.
    expect(closureLines(check({ pendingProposals: false }))).not.toContainEqual(line);
    // With the start Coin's line too: the proposals' first, still right under what stays (what
    // the closure leaves behind), then the start Coin's (a sign-up after it) — ADR-0089 7-34.
    expect(
      closureLines(check({ pendingProposals: true, startGrantReceived: true })).map(
        (each) => each.testId,
      ),
    ).toEqual([
      'closure-deleted',
      'closure-phone-records',
      'closure-kept',
      'closure-proposals',
      'closure-start-grant',
    ]);
    // Nothing of the proposal limits counted by number (owner decision 2026-10-19 15, the start
    // Coin's line likewise).
    expect(copy.closureProposals).not.toMatch(/한도|번호|건/);
  });

  it('writes the Coin the closure forfeits as every screen writes Coin (#57-16)', () => {
    expect(closureCoinText(check())).toBe('12,000 Coin');
    expect(closureCoinText(check({ availableCoin: '0' }))).toBe('0 Coin');
  });

  it('says the forfeiture and that it cannot be undone (decision 4 #140 «마지막 확인»)', () => {
    expect(copy.closureForfeit).toContain('남은 Coin');
    expect(copy.closureForfeit).toContain('사라');
    expect(copy.closureIrreversible).toContain('되돌릴 수 없습니다');
    expect(copy.closureConfirmLabel).toContain("'탈퇴'");
    // The byline it promises is the one every public screen draws (#37-16).
    expect(copy.closureKept).toContain(copy.postAuthorFormer);
  });
});

describe('what refuses a closure', () => {
  it('has a sentence for every refusal the API names', () => {
    expect(Object.keys(CLOSURE_REFUSAL_TEXT).sort()).toEqual([...ACCOUNT_CLOSURE_REFUSALS].sort());
    for (const reason of ACCOUNT_CLOSURE_REFUSALS) {
      expect(CLOSURE_REFUSAL_TEXT[reason], reason).toContain('탈퇴');
    }
    // #57-17: an admin closes once the role is revoked; #57-16: not until all are settled.
    expect(CLOSURE_REFUSAL_TEXT.admin).toContain('회수');
    expect(CLOSURE_REFUSAL_TEXT.unsettled_contracts).toContain('정산');
  });

  it('lists nothing when nothing refuses it', () => {
    expect(closureBlockers(check(), formatKst)).toEqual([]);
  });

  it('lists the refusals in the order the closure asks them, then the restriction with its end', () => {
    expect(
      closureBlockers(
        check({
          refusals: ['admin', 'pending_orders'],
          restriction: { kind: 'account', endsAt: END },
        }),
        formatKst,
      ),
    ).toEqual([
      { message: CLOSURE_REFUSAL_TEXT.admin, restricted: false },
      { message: CLOSURE_REFUSAL_TEXT.pending_orders, restricted: false },
      {
        message: `계정 제한 중에는 탈퇴할 수 없습니다(${formatKst(END)}까지).`,
        restricted: true,
      },
    ]);
    // 무기한: until it is lifted (decision 4 #140 «무기한이면 풀릴 때까지»).
    expect(
      closureBlockers(check({ restriction: { kind: 'writing', endsAt: null } }), formatKst),
    ).toEqual([{ message: '작성 제한 중에는 탈퇴할 수 없습니다(무기한).', restricted: true }]);
  });
});

describe('a refused closure', () => {
  it('names the restriction and its end, with the way to 조치·신고 내역 under it', () => {
    expect(
      closureFailure(refused(403, 'RESTRICTED', { kind: 'writing', endsAt: END }), formatKst),
    ).toEqual({
      message: `작성 제한 중에는 탈퇴할 수 없습니다(${formatKst(END)}까지).`,
      restricted: true,
    });
  });

  it('says each CLOSURE_NOT_ALLOWED by its reason, and the plain refusal for one it cannot read', () => {
    for (const reason of ACCOUNT_CLOSURE_REFUSALS) {
      expect(closureFailure(refused(409, 'CLOSURE_NOT_ALLOWED', { reason }), formatKst)).toEqual({
        message: CLOSURE_REFUSAL_TEXT[reason],
        restricted: false,
      });
    }
    expect(
      closureFailure(refused(409, 'CLOSURE_NOT_ALLOWED', { reason: 'other' }), formatKst),
    ).toEqual({ message: copy.closureBlocked, restricted: false });
  });

  it('tells the account switched, the session gone, the confirmation, the API unreached and the rest apart', () => {
    const say = (error: unknown) => closureFailure(error, formatKst).message;
    expect(
      say(refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'another account' }])),
    ).toBe(copy.sessionChanged);
    expect(say(refused(401, 'UNAUTHENTICATED'))).toBe(copy.errClosureSignedOut);
    expect(
      say(refused(400, 'VALIDATION_ERROR', [{ path: ['confirmation'], message: 'invalid' }])),
    ).toBe(copy.errClosureConfirmation);
    expect(say(new TypeError('Failed to fetch'))).toBe(copy.errNetwork);
    expect(say(new ApiError(502, undefined))).toBe(copy.errNetwork);
    expect(say(refused(500, 'INTERNAL'))).toBe(copy.errUnknown);
    expect(closureFailure(refused(401, 'UNAUTHENTICATED'), formatKst).restricted).toBe(false);
  });
});

describe('a closed account on operators’ screens', () => {
  it('is named as every byline names it once the nickname went with the closure (#37-16)', () => {
    expect(nicknameShown('회원')).toBe('회원');
    expect(nicknameShown(null)).toBe(copy.postAuthorFormer);
  });
});

describe('after a closure', () => {
  it('clears the cookie first, then goes home — whatever the sign-out answered', async () => {
    const runs = async (signOut: () => Promise<{ error?: unknown }>) => {
      const ran: string[] = [];
      await afterClosureInOrder({
        signOut: () => {
          ran.push('signOut');
          return signOut();
        },
        onClosed: () => ran.push('onClosed'),
      });
      return ran;
    };
    expect(await runs(() => Promise.resolve({}))).toEqual(['signOut', 'onClosed']);
    // The server ended every session already: a failed sign-out keeps nobody signed in.
    expect(await runs(() => Promise.resolve({ error: { status: 500 } }))).toEqual([
      'signOut',
      'onClosed',
    ]);
    expect(await runs(() => Promise.reject(new Error('offline')))).toEqual(['signOut', 'onClosed']);
  });

  it('waits for the sign-out before it leaves', async () => {
    const ran: string[] = [];
    let finish: () => void = () => undefined;
    const done = afterClosureInOrder({
      signOut: () =>
        new Promise((resolve) => {
          finish = () => {
            ran.push('signed out');
            resolve({});
          };
        }),
      onClosed: () => ran.push('onClosed'),
    });
    await Promise.resolve();
    expect(ran).toEqual([]);
    finish();
    await done;
    expect(ran).toEqual(['signed out', 'onClosed']);
  });
});
