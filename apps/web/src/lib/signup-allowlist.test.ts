import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError } from './api';
import {
  clearRequestActions,
  signupAllowlistFailure,
  signupAllowlistLines,
  signupAllowlistPhoneError,
  signupAllowlistReasonError,
} from './signup-allowlist';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code: code as ApiError['code'],
    message: code,
    ...(details === undefined ? {} : { details }),
  });

describe('가입 허용 목록 helpers (#330, ADR-0174)', () => {
  it('reads the pasted lines, every non-blank one a number in any usual spelling (I1)', () => {
    expect(signupAllowlistLines('010-1234-5678\n\n  010 1111 2222 \r\n01033334444\n')).toEqual({
      phones: ['01012345678', '01011112222', '01033334444'],
    });
  });

  it('names the lines that are not a number, and sends nothing', () => {
    expect(signupAllowlistLines('01012345678\n02-123-4567\n\nabc')).toEqual({
      error: `${copy.adminSignupAllowlistBadLines} 2, 4`,
    });
    expect(signupAllowlistLines(' \n\n')).toEqual({ error: copy.adminSignupAllowlistNoPhones });
  });

  it('checks the reason and the removed number as the server does', () => {
    expect(signupAllowlistReasonError('  ')).toBe(copy.errSignupAllowlistReason);
    expect(signupAllowlistReasonError('x'.repeat(501))).toBe(copy.errSignupAllowlistReason);
    expect(signupAllowlistReasonError('참여 취소')).toBeUndefined();
    expect(signupAllowlistPhoneError('010-1234-5678')).toBeUndefined();
    expect(signupAllowlistPhoneError('02-123-4567')).toBe(copy.errSignupAllowlistPhone);
  });

  it('says why a write was refused', () => {
    const notAllowed = (reason: string) =>
      signupAllowlistFailure(apiError(409, 'SIGNUP_ALLOWLIST_NOT_ALLOWED', { reason }), 'entries');
    expect(notAllowed('last_entry')).toEqual({ message: copy.errSignupAllowlistLastEntry });
    expect(notAllowed('empty')).toEqual({ message: copy.errSignupAllowlistEmpty });
    expect(notAllowed('clear_pending')).toEqual({ message: copy.errSignupAllowlistClearPending });
    expect(notAllowed('other')).toEqual({ message: copy.errUnknown });
    expect(signupAllowlistFailure(apiError(404, 'NOT_FOUND'), 'entries')).toEqual({
      message: copy.errSignupAllowlistNotFound,
    });
    expect(
      signupAllowlistFailure(
        apiError(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message: 'no_decider' }]),
        'entries',
      ),
    ).toEqual({ message: copy.errSignupAllowlistNoDecider });
    expect(
      signupAllowlistFailure(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'too short' }]),
        'entries',
      ),
    ).toEqual({ field: 'reason', message: copy.errSignupAllowlistReason });
    expect(
      signupAllowlistFailure(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['phones', 3], message: 'bad' }]),
        'entries',
      ),
    ).toEqual({ field: 'phones', message: copy.adminSignupAllowlistBadLines });
    expect(
      signupAllowlistFailure(
        apiError(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'other' }]),
        'entries',
      ),
    ).toEqual({ message: copy.sessionChanged });
    expect(signupAllowlistFailure(new Error('offline'), 'entries')).toEqual({
      message: copy.errUnknown,
    });
  });

  it('says why a decision on the clear was refused, the request gone included', () => {
    const approval = (message: string) =>
      signupAllowlistFailure(
        apiError(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message }]),
        'decision',
      );
    expect(approval('requester')).toEqual({ message: copy.errApprovalRequester });
    expect(approval('decided')).toEqual({ message: copy.errApprovalDecided });
    expect(approval('retracted')).toEqual({ message: copy.errApprovalRetracted });
    expect(approval('not_requester')).toEqual({ message: copy.errApprovalNotRequester });
    expect(approval('other')).toEqual({ message: copy.errUnknown });
    expect(signupAllowlistFailure(apiError(404, 'NOT_FOUND'), 'decision')).toEqual({
      message: copy.errSignupAllowlistClearNotFound,
    });
    expect(
      signupAllowlistFailure(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'too short' }]),
        'decision',
      ),
    ).toEqual({ field: 'reason', message: copy.errSignupAllowlistReason });
  });

  it('lets the requester retract the clear and any other admin decide it, nobody while unknown', () => {
    const request = { requestedBy: { id: 'admin-a', nickname: 'a' } };
    expect(clearRequestActions(request, 'admin-a')).toEqual({
      own: true,
      canDecide: false,
      canRetract: true,
    });
    expect(clearRequestActions(request, 'admin-b')).toEqual({
      own: false,
      canDecide: true,
      canRetract: false,
    });
    expect(clearRequestActions(request, undefined)).toEqual({
      own: false,
      canDecide: false,
      canRetract: false,
    });
  });

  it('keeps the owner’s sentence for a refused number word for word (330-5)', () => {
    expect(copy.errSignupNotListed).toBe(
      '이 번호로는 지금 가입할 수 없습니다. 지금은 미리 등록된 번호로만 가입할 수 있는 폐쇄 테스트 기간입니다.',
    );
  });
});
