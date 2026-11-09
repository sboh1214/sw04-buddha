import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import type { LedgerEntry } from '@/lib/api';
import { memberCorrection } from '@/test/reconciliation-corrections';
import { byTestId, renderWithQueries } from '@/test/render';
import { MemberCorrectionRow } from './reconciliation-correction-history';
import { LedgerRow } from './ledger-list';

describe('member correction history', () => {
  const ledger: LedgerEntry = {
    id: memberCorrection.eventId,
    type: 'RECONCILIATION_CORRECTION',
    amountCoin: '10',
    balanceAfterCoin: '110',
    refType: 'reconciliation_correction',
    refId: memberCorrection.id,
    memo: null,
    createdAt: memberCorrection.createdAt,
  };
  it('labels a matching ledger replenishment without describing its ledger credit as an actual increase', () => {
    const html = renderWithQueries(
      <LedgerRow
        entry={ledger}
        correction={{ ...memberCorrection, mode: 'replenish_ledger', balanceDeltaCoin: '0' }}
      />,
    );
    expect(byTestId(html, 'ledger-type')?.text).toBe(copy.reconciliationCorrectionReplenish);
    expect(byTestId(html, 'ledger-correction-effect')?.text).toBe(
      copy.reconciliationCorrectionReplenishHint,
    );
    expect(byTestId(html, 'ledger-amount')?.text).toContain('+10 Coin');
  });
  it('does not guess the actual effect of a legacy or unrelated correction ledger entry', () => {
    for (const correction of [
      undefined,
      {
        ...memberCorrection,
        eventId: 'another-event',
        mode: 'replenish_ledger' as const,
        balanceDeltaCoin: '0',
      },
    ]) {
      const html = renderWithQueries(<LedgerRow entry={ledger} correction={correction} />);
      expect(byTestId(html, 'ledger-correction-effect')?.text).toBe(
        copy.reconciliationCorrectionLedgerAmountHint,
      );
      expect(html).not.toContain(copy.reconciliationCorrectionReplenishHint);
    }
  });
  it('shows exactly the restored balance change and only the separately written member reason', () => {
    // Even a malformed object with internal fields cannot add those fields to this renderer.
    const entry = {
      ...memberCorrection,
      reason: 'internal-secret',
      requestedBy: { id: 'secret-admin' },
      snapshotKey: 'private-snapshot',
    };
    const html = renderWithQueries(<MemberCorrectionRow entry={entry} />);
    expect(byTestId(html, 'member-correction-balance-delta')?.text).toContain('+10 Coin');
    expect(byTestId(html, 'member-correction-reason')?.text).toBe(memberCorrection.userReason);
    expect(html).toContain(copy.reconciliationCorrectionRestore);
    for (const secret of ['internal-secret', 'secret-admin', 'private-snapshot'])
      expect(html).not.toContain(secret);
  });
  it('does not describe a ledger-only replenishment as a second actual payment', () => {
    const html = renderWithQueries(
      <MemberCorrectionRow
        entry={{
          ...memberCorrection,
          mode: 'replenish_ledger',
          balanceDeltaCoin: '0',
          balanceAfterCoin: '110',
        }}
      />,
    );
    expect(byTestId(html, 'member-correction-balance-delta')?.text).toBe(
      copy.reconciliationCorrectionNoBalanceChange,
    );
    expect(html).toContain(copy.reconciliationCorrectionReplenishHint);
    expect(html).not.toContain('+10 Coin');
  });
  it('preserves exact values beyond Number safe integers', () => {
    const html = renderWithQueries(
      <MemberCorrectionRow
        entry={{
          ...memberCorrection,
          amountCoin: '9007199254740993',
          balanceDeltaCoin: '9007199254740993',
          balanceAfterCoin: '9007199254741003',
        }}
      />,
    );
    expect(html).toContain('9,007,199,254,740,993 Coin');
    expect(html).toContain('9,007,199,254,741,003 Coin');
  });
});
