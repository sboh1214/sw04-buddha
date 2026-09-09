import { DISPUTE_EVIDENCE_URL_MAX, DISPUTE_REASON_MAX, MARKET_STATUSES } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type Dispute } from './api';
import {
  type DisputeSectionInput,
  disputeErrorMessage,
  disputeFieldError,
  disputeFormSchema,
  disputeRefusalEndsDialog,
  disputeDeadlineShown,
  disputeSectionView,
  disputeSectionWanted,
  toCreateDisputeBody,
} from './dispute';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const dispute: Dispute = {
  id: 'c0ffee00-0000-4000-8000-000000000001',
  marketId: ID,
  marketSlug: 'rate-cut-2026',
  marketTitle: '기준금리 인하?',
  marketStatus: 'resolving',
  resolvedResult: 'YES',
  reason: '한국은행 발표는 동결이었습니다.',
  evidenceUrl: 'https://example.com/bok',
  status: 'open',
  adminNote: null,
  reviewedAt: null,
  createdAt: '2026-10-01T12:00:00.000Z',
};

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, { code, message: code, details } as never);

/** The signed-in, answered, row-less reading — the rung every window question starts from. */
const answered = {
  isLoggedIn: true,
  isPending: false,
  isLoadingError: false,
  isRefetchError: false,
};

const DEADLINE = '2026-10-02T00:00:00.000Z';
const BEFORE = Date.parse('2026-10-01T23:00:00.000Z');
const AFTER = Date.parse('2026-10-02T00:00:01.000Z');

const resolving = (patch: Partial<DisputeSectionInput> = {}): DisputeSectionInput => ({
  market: { status: 'resolving', disputeUntil: DEADLINE },
  now: BEFORE,
  query: answered,
  dispute: null,
  ...patch,
});

describe('disputeFormSchema', () => {
  it('accepts a reason with or without a URL, and trims both', () => {
    expect(disputeFormSchema.parse({ reason: '  근거가 다릅니다  ', evidenceUrl: '' })).toEqual({
      reason: '근거가 다릅니다',
      evidenceUrl: '',
    });
    expect(
      disputeFormSchema.parse({ reason: '근거', evidenceUrl: ' https://example.com/a ' }),
    ).toEqual({ reason: '근거', evidenceUrl: 'https://example.com/a' });
  });

  it('refuses a blank or over-long reason with the form’s own sentence', () => {
    // Blank after trimming is blank: the API's `.trim().min(1)` would refuse it, and the form
    // says so before the round trip.
    const blank = disputeFormSchema.safeParse({ reason: '   ', evidenceUrl: '' });
    expect(blank.success).toBe(false);
    expect(blank.error?.issues[0]?.message).toBe(copy.errDisputeReason);
    const long = disputeFormSchema.safeParse({
      reason: 'a'.repeat(DISPUTE_REASON_MAX + 1),
      evidenceUrl: '',
    });
    expect(long.success).toBe(false);
    expect(
      disputeFormSchema.safeParse({ reason: 'a'.repeat(DISPUTE_REASON_MAX), evidenceUrl: '' })
        .success,
    ).toBe(true);
  });

  it('asks the API’s own URL rule rather than restating it', () => {
    // Stated twice, a URL rule drifts: the server takes http(s) only and caps the length, and a
    // form that accepted `ftp://` or a longer one would hand the user a generic toast for it.
    for (const bad of ['ftp://example.com/a', 'example.com', 'javascript:alert(1)']) {
      const result = disputeFormSchema.safeParse({ reason: '근거', evidenceUrl: bad });
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(copy.errDisputeEvidence);
    }
    const tooLong = `https://example.com/${'a'.repeat(DISPUTE_EVIDENCE_URL_MAX)}`;
    expect(disputeFormSchema.safeParse({ reason: '근거', evidenceUrl: tooLong }).success).toBe(
      false,
    );
    expect(
      disputeFormSchema.safeParse({ reason: '근거', evidenceUrl: 'http://example.com/a' }).success,
    ).toBe(true);
  });
});

describe('toCreateDisputeBody', () => {
  it('sends a blank URL as null, which is how the API spells "none"', () => {
    expect(toCreateDisputeBody({ reason: ' 근거 ', evidenceUrl: '' })).toEqual({
      reason: '근거',
      evidenceUrl: null,
    });
    expect(toCreateDisputeBody({ reason: '근거', evidenceUrl: 'https://example.com/a' })).toEqual({
      reason: '근거',
      evidenceUrl: 'https://example.com/a',
    });
  });
});

describe('disputeSectionWanted', () => {
  it('wants the row only where the card could draw it', () => {
    // The same predicate gates the query: an open market's detail must not spend a private
    // `GET /me/disputes` per signed-in visit on a row nothing on that screen reads.
    for (const status of MARKET_STATUSES) {
      expect(disputeSectionWanted(status), status).toBe(
        status === 'resolving' || status === 'settled' || status === 'voided',
      );
    }
  });
});

describe('disputeDeadlineShown', () => {
  const DEADLINE = '2026-10-02T01:00:00.000Z';

  it('shows the deadline while the result is open to objection, and never after', () => {
    // The settle KEEPS the column — the worker's UPDATE writes status·settled_at·
    // status_event_id and nothing else — so a settled row still carries the instant the window
    // shut. PLAN 11.3 assigns the row by STATUS ("`settled`면 결과·내 손익"), and the same value
    // is labelled 정산 예정 on 정산 기준: drawn on a settled market it promises a settlement that
    // already happened.
    for (const status of MARKET_STATUSES) {
      expect(disputeDeadlineShown({ status, disputeUntil: DEADLINE }), status).toBe(
        status === 'resolving' ? DEADLINE : null,
      );
    }
  });

  it('is null wherever the column is empty', () => {
    // A `resolving` row with no window is the one `disputeSectionView` answers `notResolving`
    // for: there is no instant, so neither reader draws anything either.
    for (const status of MARKET_STATUSES) {
      expect(disputeDeadlineShown({ status, disputeUntil: null }), status).toBeNull();
    }
  });
});

describe('disputeSectionView', () => {
  it('draws nothing for a market that is not being resolved and has not finished', () => {
    // A dispute is an objection to a PROPOSED result; before one exists there is nothing to
    // object to, and no state of the session or the row changes that.
    for (const status of MARKET_STATUSES.filter(
      (s) => s !== 'resolving' && s !== 'settled' && s !== 'voided',
    )) {
      expect(
        disputeSectionView(resolving({ market: { status, disputeUntil: null } })),
        status,
      ).toEqual({ kind: 'hidden' });
      expect(
        disputeSectionView(resolving({ market: { status, disputeUntil: null }, dispute })),
        status,
      ).toEqual({ kind: 'hidden' });
    }
  });

  it('offers the button while the window is open, and only then', () => {
    expect(disputeSectionView(resolving())).toEqual({ kind: 'canFile', disputeUntil: DEADLINE });
    // At the deadline itself the window is closed: `dispute.service.ts` refuses on
    // `disputeUntil <= now`, and the section must not offer what the server will refuse.
    expect(disputeSectionView(resolving({ now: Date.parse(DEADLINE) }))).toEqual({
      kind: 'windowClosed',
    });
    expect(disputeSectionView(resolving({ now: AFTER }))).toEqual({ kind: 'windowClosed' });
  });

  it('leaves the last word to the server when there is no instant to measure against', () => {
    // `now` is the ticks window end and is absent when that read failed. Guessing at the clock
    // would compare two machines (the trade panel's 마감 gate says why); offering the button
    // costs at worst one DISPUTE_WINDOW_CLOSED, which the refusal path below turns into the
    // right state.
    expect(disputeSectionView(resolving({ now: undefined }))).toEqual({
      kind: 'canFile',
      disputeUntil: DEADLINE,
    });
  });

  it('closes on the server’s refusal, because the anchor does not tick', () => {
    // THE HAZARD: `now` is the page LOAD's instant. A reader who opened the page before the
    // deadline and pressed after it gets DISPUTE_WINDOW_CLOSED — and, with the anchor still
    // before the deadline, would be offered the button again under the toast that said the
    // window is over. The refusal is newer than the anchor, so it wins.
    expect(
      disputeSectionView(resolving({ refusal: apiError(409, 'DISPUTE_WINDOW_CLOSED') })),
    ).toEqual({ kind: 'windowClosed' });
    // Any other refusal leaves the window question to the anchor: a field error is the
    // dialog's to show, and a duplicate is answered by the refetch that draws the row.
    expect(disputeSectionView(resolving({ refusal: apiError(409, 'DUPLICATE_REQUEST') }))).toEqual({
      kind: 'canFile',
      disputeUntil: DEADLINE,
    });
  });

  it('says the market cannot be disputed now when it resolves with no deadline', () => {
    // No transition path writes `resolving` without `disputeUntil`; a test factory can. The
    // server would refuse the request either way, and this is the sentence it would refuse with.
    expect(
      disputeSectionView(resolving({ market: { status: 'resolving', disputeUntil: null } })),
    ).toEqual({ kind: 'notResolving' });
  });

  it('shows the account’s own dispute whatever the window says, and after the market finishes', () => {
    // The review's outcome is worth reading after the market has moved on (design 5.3): a
    // settled or voided market keeps drawing the row, with its 수용/기각 and the admin's note.
    for (const status of ['resolving', 'settled', 'voided'] as const) {
      const view = disputeSectionView(
        resolving({ market: { status, disputeUntil: DEADLINE }, now: AFTER, dispute }),
      );
      expect(view, status).toEqual({ kind: 'filed', dispute, stale: false });
    }
    // A refresh that failed after the row was drawn KEEPS the row and says so, rather than
    // replacing it with an error (the `listSection` rule).
    expect(
      disputeSectionView(resolving({ dispute, query: { ...answered, isRefetchError: true } })),
    ).toEqual({ kind: 'filed', dispute, stale: true });
  });

  it('walks the session ladder for a resolving market: signed out, pending, failed', () => {
    const signedOut = { ...answered, isLoggedIn: false };
    expect(disputeSectionView(resolving({ query: signedOut, dispute: undefined }))).toEqual({
      kind: 'signedOut',
    });
    // `pending` wins over `signedOut`: `useSession` pins `isPending` through hydration, and a
    // bare `!isLoggedIn` would flash the sign-in prompt on every load.
    expect(
      disputeSectionView(
        resolving({ query: { ...signedOut, isPending: true }, dispute: undefined }),
      ),
    ).toEqual({ kind: 'pending' });
    expect(
      disputeSectionView(
        resolving({ query: { ...answered, isPending: true }, dispute: undefined }),
      ),
    ).toEqual({ kind: 'pending' });
    expect(
      disputeSectionView(
        resolving({ query: { ...answered, isLoadingError: true }, dispute: undefined }),
      ),
    ).toEqual({ kind: 'failed' });
  });

  it('draws nothing on a finished market for everyone but a filer', () => {
    // No sign-in prompt for a market nobody can dispute any more, and no skeleton that would
    // collapse for the many visitors who filed nothing — only the row, when there is one.
    for (const status of ['settled', 'voided'] as const) {
      const market = { status, disputeUntil: DEADLINE };
      expect(disputeSectionView(resolving({ market, dispute: null })), status).toEqual({
        kind: 'hidden',
      });
      expect(
        disputeSectionView(
          resolving({ market, query: { ...answered, isLoggedIn: false }, dispute: undefined }),
        ),
        status,
      ).toEqual({ kind: 'hidden' });
      expect(
        disputeSectionView(
          resolving({ market, query: { ...answered, isPending: true }, dispute: undefined }),
        ),
        status,
      ).toEqual({ kind: 'hidden' });
      expect(
        disputeSectionView(
          resolving({ market, query: { ...answered, isLoadingError: true }, dispute: undefined }),
        ),
        status,
      ).toEqual({ kind: 'hidden' });
    }
  });
});

describe('disputeFieldError', () => {
  it('puts a refusal that names a field under that field, in the form’s own words', () => {
    expect(
      disputeFieldError(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'too long' }]),
      ),
    ).toEqual({ field: 'reason', message: copy.errDisputeReason });
    expect(
      disputeFieldError(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['evidenceUrl'], message: 'bad url' }]),
      ),
    ).toEqual({ field: 'evidenceUrl', message: copy.errDisputeEvidence });
  });

  it('answers nothing for a refusal that is not about a field', () => {
    // `status` is the market's, not the form's: that one is a toast (below), and the exception
    // filter hands VALIDATION_ERROR to any unmapped 4xx, so a code alone is never enough.
    expect(
      disputeFieldError(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['status'], message: 'not resolving' }]),
      ),
    ).toBeUndefined();
    expect(disputeFieldError(apiError(400, 'VALIDATION_ERROR'))).toBeUndefined();
    expect(disputeFieldError(apiError(409, 'DUPLICATE_REQUEST'))).toBeUndefined();
    expect(disputeFieldError(new Error('offline'))).toBeUndefined();
  });
});

describe('disputeRefusalEndsDialog', () => {
  it('closes the dialog only where the section now says what the toast said', () => {
    // These five have already changed the state behind the dialog — the cache was corrected or
    // the refusal itself is read by `disputeSectionView` — so an open form would be a form for a
    // request that can never succeed.
    expect(disputeRefusalEndsDialog(apiError(409, 'DISPUTE_WINDOW_CLOSED'))).toBe(true);
    expect(disputeRefusalEndsDialog(apiError(409, 'DUPLICATE_REQUEST'))).toBe(true);
    expect(
      disputeRefusalEndsDialog(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['status'], message: 'not resolving' }]),
      ),
    ).toBe(true);
    expect(disputeRefusalEndsDialog(apiError(401, 'UNAUTHENTICATED'))).toBe(true);
    expect(disputeRefusalEndsDialog(apiError(404, 'NOT_FOUND'))).toBe(true);
    // A field error is about to be fixed in place and a blip is about to be resent: the typed
    // reason is the thing worth keeping, so the dialog stays.
    expect(
      disputeRefusalEndsDialog(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'too long' }]),
      ),
    ).toBe(false);
    expect(disputeRefusalEndsDialog(apiError(500, 'INTERNAL'))).toBe(false);
    expect(disputeRefusalEndsDialog(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('disputeErrorMessage', () => {
  it('maps every refusal the route can answer to one Korean sentence', () => {
    expect(disputeErrorMessage(apiError(409, 'DISPUTE_WINDOW_CLOSED'))).toBe(
      copy.disputeWindowClosed,
    );
    expect(disputeErrorMessage(apiError(409, 'DUPLICATE_REQUEST'))).toBe(copy.disputeAlreadyFiled);
    expect(
      disputeErrorMessage(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['status'], message: 'not resolving' }]),
      ),
    ).toBe(copy.disputeNotResolving);
    expect(disputeErrorMessage(apiError(401, 'UNAUTHENTICATED'))).toBe(copy.disputeLoginToFile);
    expect(disputeErrorMessage(apiError(404, 'NOT_FOUND'))).toBe(copy.errTradeNotFound);
    // Anything else — a 5xx, a dropped connection, an unnamed VALIDATION_ERROR — is the
    // generic line, never an English `error.message`.
    expect(disputeErrorMessage(apiError(500, 'INTERNAL'))).toBe(copy.errUnknown);
    expect(disputeErrorMessage(new TypeError('Failed to fetch'))).toBe(copy.errUnknown);
    expect(disputeErrorMessage(apiError(400, 'VALIDATION_ERROR'))).toBe(copy.errUnknown);
  });
});
