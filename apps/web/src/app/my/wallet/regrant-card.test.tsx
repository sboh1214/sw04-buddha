import { readFileSync } from 'node:fs';
import { type MyRestriction } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { useRegrantStatus } from '@/hooks/use-regrant';
import { ApiError, type LedgerEntry, type Me, type RegrantStatus } from '@/lib/api';
import { formatInTimeZone, SEOUL_TIME_ZONE } from '@/lib/datetime';
import { myRestrictionKey } from '@/lib/moderation';
import { type RegrantPressFailure, regrantPressFailure, regrantStatusKey } from '@/lib/regrant';
import { byId, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { LedgerRow } from './ledger-list';
import { RegrantCard, RegrantPressRefusal } from './regrant-card';

const ACCOUNT = {
  id: 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46',
  balance: { availableCoin: '900000', lockedCoin: '0' },
  profile: { role: 'user' },
} as Me;

const WAIT_UNTIL = '2026-11-22T06:00:00.000Z';
const NEXT_PERIOD = '2026-12-01T00:00:00.000Z';

const eligible: RegrantStatus = {
  open: true,
  eligible: true,
  refusals: [],
  amountCoin: '50000',
  thresholdCoin: '990000',
  waitHours: 0,
  waitUntil: null,
  periodDays: 30,
  periodLimit: 3,
  periodUsed: 1,
  nextPeriodAt: null,
  totalCapCoin: '500000',
  totalGrantedCoin: '50000',
  remainingCapCoin: '450000',
};

const notReady: RegrantStatus = {
  open: false,
  eligible: false,
  refusals: ['not_ready', 'no_start_grant'],
  amountCoin: null,
  thresholdCoin: null,
  waitHours: null,
  waitUntil: null,
  periodDays: null,
  periodLimit: null,
  periodUsed: null,
  nextPeriodAt: null,
  totalCapCoin: null,
  totalGrantedCoin: null,
  remainingCapCoin: null,
};

/** The card as its first paint draws it, `GET /me` and `GET /me/regrant` answered. */
const drawn = (status?: RegrantStatus, me: Me | undefined = ACCOUNT) =>
  renderWithQueries(<RegrantCard />, [
    ...(me === undefined ? [] : [[ME_QUERY_KEY, me] as const]),
    ...(status === undefined || me === undefined
      ? []
      : [[regrantStatusKey(me.id), status] as const]),
  ]);

/** Whether the card's 재지급 신청 is drawn and off. */
const applyOff = (html: string) => byTestId(html, 'regrant-apply')?.attributes.disabled;

/** The element 재지급 신청 points at (`aria-describedby`), or undefined when it points at none. */
const applyDescription = (html: string) => {
  const id = byTestId(html, 'regrant-apply')?.attributes['aria-describedby'];
  return id === undefined ? undefined : byId(html, id);
};

/**
 * 재지급 카드 as drawn (#74, ADR-0155; owner answers 2026-11-21 9·10·12): always on the wallet,
 * '준비 중' while a setting is undecided, the numbers and the button while open, and every reason
 * with its numbers when a request now would be refused. What each sentence says is lib/regrant.ts'
 * (regrant.test.ts); the press is the hook's (use-regrant.test.ts) and the e2e's (regrant.spec.ts).
 */
describe('RegrantCard', () => {
  it("says '준비 중' alone while a setting is undecided, its button off (owner answer 12)", () => {
    const html = drawn(notReady);
    expect(byTestId(html, 'regrant-card')).toBeDefined();
    expect(byTestId(html, 'regrant-panel')?.attributes['data-open']).toBe('false');
    expect(byTestId(html, 'regrant-not-ready')?.text).toBe(copy.regrantNotReady);
    expect(byTestId(html, 'regrant-amount')).toBeUndefined();
    // Nothing else the server named while not ready: '준비 중' says it.
    expect(byTestId(html, 'regrant-blocked')).toBeUndefined();
    expect(byTestId(html, 'regrant-apply')?.text).toBe(copy.regrantApply);
    expect(applyOff(html)).toBeDefined();
    // Off, it points at the line that says why.
    expect(applyDescription(html)?.attributes['data-testid']).toBe('regrant-not-ready');
  });

  it('lists the amount, the threshold, the period and the cap left, and turns the button on', () => {
    const html = drawn(eligible);
    expect(byTestId(html, 'regrant-panel')?.attributes['data-eligible']).toBe('true');
    expect(byTestId(html, 'regrant-amount')?.text).toBe('50,000 Coin');
    expect(byTestId(html, 'regrant-threshold')?.text).toBe('가용 코인 990,000 Coin 이하');
    expect(byTestId(html, 'regrant-period')?.text).toBe('최근 30일 3회 중 2회');
    expect(byTestId(html, 'regrant-remaining-cap')?.text).toBe(
      '450,000 Coin (누적 상한 500,000 Coin)',
    );
    expect(byTestId(html, 'regrant-conditions')?.text).toBe(copy.regrantConditions);
    // No 대기기간 to speak of at 0 hours.
    expect(byTestId(html, 'regrant-wait')).toBeUndefined();
    expect(byTestId(html, 'regrant-blocked')).toBeUndefined();
    expect(byTestId(html, 'regrant-not-ready')).toBeUndefined();
    expect(applyOff(html)).toBeUndefined();
    // On: nothing to point at.
    expect(byTestId(html, 'regrant-apply')?.attributes['aria-describedby']).toBeUndefined();
    // Nothing pressed yet: no result line, and no refresh notice.
    expect(byTestId(html, 'regrant-granted')).toBeUndefined();
    expect(byTestId(html, 'regrant-replayed')).toBeUndefined();
    expect(byTestId(html, 'regrant-error')).toBeUndefined();
    expect(byTestId(html, 'regrant-stale')).toBeUndefined();
  });

  it('turns the button off and says every reason with its numbers and times (owner answer 9)', () => {
    const html = drawn({
      ...eligible,
      eligible: false,
      refusals: ['restricted', 'not_exhausted', 'live_orders', 'waiting', 'period_limit'],
      waitHours: 24,
      waitUntil: WAIT_UNTIL,
      periodUsed: 3,
      nextPeriodAt: NEXT_PERIOD,
    });
    expect(applyOff(html)).toBeDefined();
    expect(byTestId(html, 'regrant-blocked')?.text).toContain(copy.regrantBlocked);
    const reasons = [...html.matchAll(/\sdata-reason="([a-z_]+)"/g)];
    expect(reasons.map(([, reason]) => reason)).toEqual([
      'restricted',
      'not_exhausted',
      'live_orders',
      'waiting',
      'period_limit',
    ]);
    const text = byTestId(html, 'regrant-blocked')?.text ?? '';
    // The times in the member's zone — Seoul on the server's paint.
    const shown = (iso: string) => formatInTimeZone(iso, SEOUL_TIME_ZONE);
    for (const line of [
      '계정 제한 중에는 재지급을 받을 수 없습니다.',
      '가용 코인이 990,000 Coin 이하일 때 받을 수 있습니다.',
      copy.regrantRefusalLiveOrders,
      `대기기간이 지나지 않았습니다. ${shown(WAIT_UNTIL)}부터 받을 수 있습니다.`,
      `최근 30일 동안 받을 수 있는 3회를 모두 받았습니다. ${shown(NEXT_PERIOD)}부터 다시 받을 수 있습니다.`,
    ]) {
      expect(text, line).toContain(line);
    }
    // The account restriction's line has the way to 조치·신고 내역 under it, and only that one.
    expect(testIdsStartingWith(html, 'restricted-moderation-link')).toHaveLength(1);
    expect(byTestId(html, 'regrant-period')?.text).toBe('최근 30일 3회 중 0회');
    expect(byTestId(html, 'regrant-wait')?.text).toBe(
      '마지막 재지급(처음이면 시작 Coin을 받은 때) 뒤 24시간이 지나야 받을 수 있습니다.',
    );
    // Off, it points at the reasons (W6: as the order panel's buttons point at the line).
    const description = applyDescription(html);
    expect(description?.attributes['data-testid']).toBe('regrant-blocked');
    expect(description?.text).toContain(copy.regrantRefusalLiveOrders);
  });

  it('says the account restriction’s end from the restriction MY reads (owner decision 2026-10-22)', () => {
    const restricted: RegrantStatus = { ...eligible, eligible: false, refusals: ['restricted'] };
    const shown = (iso: string) => formatInTimeZone(iso, SEOUL_TIME_ZONE);
    const until = '2026-12-01T00:00:00.000Z';
    const withRestriction = (accountRestriction: MyRestriction['accountRestriction']) =>
      renderWithQueries(<RegrantCard />, [
        [ME_QUERY_KEY, ACCOUNT],
        [regrantStatusKey(ACCOUNT.id), restricted],
        [myRestrictionKey(ACCOUNT.id), { restriction: null, accountRestriction }],
      ]);
    const line = (html: string) => byTestId(html, 'regrant-refusal');

    const term = withRestriction({ kind: 'account', endsAt: until });
    expect(line(term)?.attributes['data-reason']).toBe('restricted');
    expect(line(term)?.text).toContain(
      `계정 제한 중에는 재지급을 받을 수 없습니다(${shown(until)}까지).`,
    );
    expect(testIdsStartingWith(term, 'restricted-moderation-link')).toHaveLength(1);
    expect(line(withRestriction({ kind: 'account', endsAt: null }))?.text).toContain(
      '계정 제한 중에는 재지급을 받을 수 없습니다(무기한).',
    );
    // Read as none (the status read before it ended): the sentence alone, no end made up.
    expect(line(withRestriction(null))?.text).toContain(
      '계정 제한 중에는 재지급을 받을 수 없습니다.',
    );
  });

  it('says an admin’s account restriction with its end too (ADR-0155 결과 5, 결정 8)', () => {
    // One admin can restrict another, and admins get re-grants on the members' terms: `account`
    // names the admin first, the restriction is still held (`useAccountBlock`'s `restricted`).
    const admin = { ...ACCOUNT, profile: { role: 'admin' } } as Me;
    const restricted: RegrantStatus = { ...eligible, eligible: false, refusals: ['restricted'] };
    const shown = (iso: string) => formatInTimeZone(iso, SEOUL_TIME_ZONE);
    const until = '2026-12-01T00:00:00.000Z';
    const withRestriction = (accountRestriction: MyRestriction['accountRestriction']) =>
      renderWithQueries(<RegrantCard />, [
        [ME_QUERY_KEY, admin],
        [regrantStatusKey(admin.id), restricted],
        [myRestrictionKey(admin.id), { restriction: null, accountRestriction }],
      ]);
    const line = (html: string) => byTestId(html, 'regrant-refusal');

    const term = withRestriction({ kind: 'account', endsAt: until });
    expect(line(term)?.text).toContain(
      `계정 제한 중에는 재지급을 받을 수 없습니다(${shown(until)}까지).`,
    );
    expect(testIdsStartingWith(term, 'restricted-moderation-link')).toHaveLength(1);
    const indefinite = withRestriction({ kind: 'account', endsAt: null });
    expect(line(indefinite)?.text).toContain('계정 제한 중에는 재지급을 받을 수 없습니다(무기한).');
    // None held: the sentence alone, as for a member.
    expect(line(withRestriction(null))?.text).toContain(
      '계정 제한 중에는 재지급을 받을 수 없습니다.',
    );
    expect(line(withRestriction(null))?.text).not.toContain('(무기한)');
  });

  it('keeps the card drawn under a notice when a read again fails, its rung only for a first read', () => {
    // A read again failed over the status held (TanStack keeps the data): the card stays — a
    // grant's line with it — under MY's refresh notice and its 다시 시도 (`listView`'s `stale`).
    const html = renderWithQueries(
      <RegrantCard />,
      [
        [ME_QUERY_KEY, ACCOUNT],
        [regrantStatusKey(ACCOUNT.id), eligible],
      ],
      (queryClient) => {
        queryClient
          .getQueryCache()
          .find({ queryKey: regrantStatusKey(ACCOUNT.id), exact: true })
          ?.setState({ status: 'error', error: new Error('read again failed') });
      },
    );
    expect(byTestId(html, 'regrant-stale')?.attributes.role).toBe('status');
    expect(byTestId(html, 'regrant-stale')?.text).toContain(copy.marketRefreshFailed);
    expect(byTestId(html, 'regrant-stale')?.text).toContain(copy.retry);
    expect(byTestId(html, 'regrant-status-failed')).toBeUndefined();
    expect(byTestId(html, 'regrant-panel')?.attributes['data-eligible']).toBe('true');
    expect(byTestId(html, 'regrant-amount')?.text).toBe('50,000 Coin');
    expect(applyOff(html)).toBeUndefined();
  });

  it('draws a skeleton until the status is read, and only the intro with no profile', () => {
    const pending = drawn();
    expect(byTestId(pending, 'regrant-card')).toBeDefined();
    expect(byTestId(pending, 'regrant-apply')).toBeUndefined();
    expect(byTestId(pending, 'regrant-panel')).toBeUndefined();
    // No `Me` and no session (the balance card above says why): the card is there, with no button.
    const none = drawn(undefined, undefined);
    expect(byTestId(none, 'regrant-card')).toBeDefined();
    expect(byTestId(none, 'regrant-apply')).toBeUndefined();
  });

  it('never draws another account’s status: the panel reads the `Me` it was drawn for', () => {
    const html = renderWithQueries(<RegrantCard />, [
      [ME_QUERY_KEY, ACCOUNT],
      [regrantStatusKey('someone-else'), eligible],
    ]);
    expect(byTestId(html, 'regrant-panel')).toBeUndefined();
    expect(byTestId(html, 'regrant-apply')).toBeUndefined();
  });
});

/**
 * The line under the button after a refused press (`RegrantPressRefusal`), drawn over the status
 * as the panel reads it (`useRegrantStatus`'s `dataUpdatedAt`): no click runs under node, so the
 * press is what the panel keeps of it (`regrantPressFailure` with the status's reading after the
 * hook's onError — use-regrant.test.ts checks that reading is the details').
 */
describe('RegrantPressRefusal', () => {
  const READ = Date.parse('2026-11-21T03:00:00.000Z');
  const liveOrder: RegrantStatus = { ...eligible, eligible: false, refusals: ['live_orders'] };
  const apiError = (status: number, code: string, details?: unknown) =>
    new ApiError(status, {
      code,
      message: 'x',
      ...(details === undefined ? {} : { details }),
    } as never);
  const format = (iso: string) => iso;

  /** The line as the panel draws it, over the status held under `ACCOUNT`. */
  function Line({ failure }: { failure: RegrantPressFailure }) {
    const status = useRegrantStatus(ACCOUNT.id);
    return status.data === undefined ? null : (
      <RegrantPressRefusal
        failure={failure}
        status={status.data}
        statusUpdatedAt={status.dataUpdatedAt}
      />
    );
  }
  const drawnOver = (
    failure: RegrantPressFailure,
    status: RegrantStatus,
    readAt: number,
    readAgainFailed = false,
  ) =>
    renderWithQueries(<Line failure={failure} />, [], (queryClient) => {
      queryClient.setQueryData(regrantStatusKey(ACCOUNT.id), status, { updatedAt: readAt });
      if (readAgainFailed) {
        queryClient
          .getQueryCache()
          .find({ queryKey: regrantStatusKey(ACCOUNT.id), exact: true })
          ?.setState({ status: 'error', error: new Error('read again failed') });
      }
    });

  const refused = regrantPressFailure(
    apiError(409, 'REGRANT_NOT_ALLOWED', liveOrder),
    format,
    READ,
  );

  it('announces REGRANT_NOT_ALLOWED’s reasons while the status is the reading they became', () => {
    const html = drawnOver(refused, liveOrder, READ);
    expect(byTestId(html, 'regrant-error')?.attributes.role).toBe('alert');
    expect(byTestId(html, 'regrant-error')?.text).toBe(
      `${copy.regrantBlocked} ${copy.regrantRefusalLiveOrders}`,
    );
    // A read again that failed is no newer reading: the line stays.
    expect(byTestId(drawnOver(refused, liveOrder, READ, true), 'regrant-error')).toBeDefined();
  });

  it('goes once a newer reading says otherwise — eligible, the button on above it', () => {
    // The order cancelled in another tab, the balance moved, the status read again: eligible.
    expect(byTestId(drawnOver(refused, eligible, READ + 1_000), 'regrant-error')).toBeUndefined();
    // Read again and refused for another reason: the list above says that one, the line went.
    const notExhausted: RegrantStatus = { ...liveOrder, refusals: ['not_exhausted'] };
    expect(
      byTestId(drawnOver(refused, notExhausted, READ + 1_000), 'regrant-error'),
    ).toBeUndefined();
    // Read again saying the very same (the refusal's own read of `['me']` moved the balance the
    // card had, which reads the status again at once): the announcement stays.
    expect(byTestId(drawnOver(refused, liveOrder, READ + 1_000), 'regrant-error')?.text).toBe(
      `${copy.regrantBlocked} ${copy.regrantRefusalLiveOrders}`,
    );
  });

  it('keeps any other refusal until the next press, whatever the status reads since', () => {
    for (const error of [
      apiError(403, 'RESTRICTED', { kind: 'account', endsAt: null }),
      apiError(409, 'REGRANT_NOT_ALLOWED'),
      new TypeError('fetch failed'),
    ]) {
      const failure = regrantPressFailure(error, format, READ);
      expect(failure.readingAt).toBeNull();
      expect(byTestId(drawnOver(failure, eligible, READ + 1_000), 'regrant-error')).toBeDefined();
    }
  });
});

/**
 * What a press draws, and what waits on screen: no effect nor click runs under node, so the
 * panel's wiring is pinned in its source (as `useAccountBlock`'s and the order book's are); the
 * sentences are lib/regrant.ts' (regrant.test.ts), the press the hook's (use-regrant.test.ts).
 */
describe('RegrantPanel', () => {
  const source = readFileSync(new URL('./regrant-card.tsx', import.meta.url), 'utf8');
  const panel = source.slice(source.indexOf('export function RegrantPanel('));

  it('announces every refusal of a press, REGRANT_NOT_ALLOWED’s until a newer reading', () => {
    // Read after the hook's onError, which put the details in the status's place.
    expect(panel).toContain(
      'setFailure(regrantPressFailure(error, format, regrantStatusReadAt(queryClient, accountId)));',
    );
    // A line a newer reading withdrew stays withdrawn: the press is dropped as the card renders.
    expect(panel).toMatch(
      /const keptFailure = regrantFailureKept\(failure, current, status\.dataUpdatedAt, format\);\s*if \(keptFailure !== failure\) setFailure\(keptFailure\);/,
    );
    expect(panel).toMatch(
      /<RegrantPressRefusal\s+failure=\{failure\}\s+status=\{current\}\s+statusUpdatedAt=\{status\.dataUpdatedAt\}\s*\/>/,
    );
    expect(panel).toMatch(
      /const refusal = regrantFailureShown\(failure, status, statusUpdatedAt, format\);\s*if \(refusal === null\) return null;\s*return \(\s*<Alert\.Root status="error" role="alert" data-testid="regrant-error">/,
    );
  });

  it('draws a replayed answer apart from a fresh grant, with what it says of each (N01 §9)', () => {
    expect(panel).toContain(
      "data-testid={granted.replayed ? 'regrant-replayed' : 'regrant-granted'}",
    );
    expect(panel).toContain('{regrantResultText(granted, format)}');
    expect(panel).toContain(
      'setGranted(await apply.mutateAsync({ expectedAccountId: accountId }));',
    );
  });

  it('reads the status again when the wait or the period’s slot runs out on screen', () => {
    expect(panel).toContain('useRegrantRereadAt(accountId, status.data);');
  });

  it('shows the error rung only with no status held, and the refresh notice over one', () => {
    expect(panel).toContain('const view = listView(status);');
    expect(panel).toMatch(/if \(status\.data === undefined\) \{\s*return view === 'failed' \?/);
    expect(panel).toContain("{view === 'stale' && (");
  });

  it('reads the account restriction only while the status names one', () => {
    expect(panel).toContain(
      "const block = useAccountBlock(status.data?.refusals.includes('restricted') ? me : undefined);",
    );
    // Held whatever the role: an admin's restriction says its end too.
    expect(panel).toContain(
      'const restrictionEndsAt = block.restricted ? block.restrictionEndsAt : undefined;',
    );
  });
});

describe('the 재지급 ledger row', () => {
  it("names a REGRANT entry '재지급' with its Coin in, and links nothing (#74)", () => {
    const entry: LedgerEntry = {
      id: '4301',
      kind: 'REGRANT',
      amountCoin: '50000',
      balanceAfterCoin: '60000',
      refType: 'regrant',
      refId: '0b8a3c5e-2f4d-4e6a-9b1c-3d5e7f9a1b2c',
      memo: null,
      marketId: null,
      marketSlug: null,
      marketTitle: null,
      orderId: null,
      correctionEffect: null,
      createdAt: '2026-11-21T03:00:00.000Z',
    };
    const html = renderWithQueries(<LedgerRow entry={entry} variant="full" />);
    expect(byTestId(html, 'ledger-type')?.text).toBe(copy.ledgerTypeRegrant);
    expect(byTestId(html, 'ledger-amount')?.text).toBe('+50,000 Coin');
    expect(byTestId(html, 'ledger-order-link')).toBeUndefined();
    expect(byTestId(html, 'ledger-settlement-link')).toBeUndefined();
    expect(byTestId(html, 'ledger-market')).toBeUndefined();
  });
});
