import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { formatKst } from '@/lib/datetime';
import { marketMaker } from '@/test/market-maker';
import { byTestId, renderWithQueries } from '@/test/render';
import { MarketMakerFacts } from './market-maker-panel';

describe('private market maker execution observations', () => {
  it('shows a market before recall eligibility without inventing a completion or amount', () => {
    const html = renderWithQueries(<MarketMakerFacts data={marketMaker} />);
    const recall = byTestId(html, 'market-maker-recall')!;
    expect(recall.text).toContain(copy.marketMakerRecallNotDue);
    expect(recall.text).not.toContain(copy.marketMakerRecallCompleted);
    expect(recall.text).not.toContain(copy.marketMakerRecallPending);
    expect(recall.text).not.toContain(copy.marketMakerRecallAmount);
    expect(html).not.toContain('<button');
  });
  it('shows an unfinished recall without inferring a failure or a pending payout', () => {
    const html = renderWithQueries(
      <MarketMakerFacts
        data={{
          ...marketMaker,
          recall: { status: 'pending' },
          readiness: { blockers: ['ledger_hold', 'market_not_open'] },
        }}
      />,
    );
    const recall = byTestId(html, 'market-maker-recall')!;
    expect(recall.text).toContain(copy.marketMakerRecallPending);
    expect(recall.text).toContain(copy.marketMakerRecallPendingHint);
    expect(recall.text).not.toContain('실패');
    expect(recall.text).not.toContain('지급');
    expect(recall.text).not.toContain(copy.marketMakerRecallAmount);
    expect(html).not.toContain('<button');
    expect(byTestId(html, 'market-maker-readiness')?.text).toContain(copy.marketMakerLedgerHold);
  });
  it.each([
    ['not_allocated', '0', 'cancelled', copy.marketMakerRecallNotAllocated],
    ['empty', '0', 'settled', copy.marketMakerRecallEmpty],
    ['transferred', '12345', 'settled', copy.marketMakerRecallTransferred],
  ] as const)(
    'shows the recorded %s outcome, amount, time and terminal basis',
    (outcome, amountCoin, terminalStatus, label) => {
      const completedAt = '2026-11-11T01:30:00.000Z';
      const html = renderWithQueries(
        <MarketMakerFacts
          data={{
            ...marketMaker,
            recall: {
              status: 'completed',
              outcome,
              terminalStatus,
              amountCoin,
              ledgerEntryId: outcome === 'transferred' ? '987654321' : null,
              completedAt,
            },
            // A later hold must not be erased or treated as contradicted by old completion.
            readiness: { blockers: ['ledger_hold'] },
            runtime: { ...marketMaker.runtime!, state: 'error', lastError: 'funds_inconsistent' },
          }}
        />,
      );
      const recall = byTestId(html, 'market-maker-recall')!;
      expect(recall.text).toContain(copy.marketMakerRecallCompleted);
      expect(byTestId(html, 'market-maker-recall-outcome')?.text).toBe(label);
      expect(recall.text).toContain(amountCoin === '0' ? '0 Coin' : '12,345 Coin');
      expect(recall.text).toContain(formatKst(completedAt));
      expect(recall.text).toContain(
        terminalStatus === 'settled'
          ? copy.marketMakerRecallSettled
          : copy.marketMakerRecallCancelled,
      );
      expect(recall.text).toContain(copy.marketMakerRecallHistoryHint);
      expect(recall.text).not.toContain(copy.marketMakerRecallPendingHint);
      expect(recall.text).not.toContain('987654321');
      expect(html).not.toContain('<button');
      expect(byTestId(html, 'market-maker-readiness')?.text).toContain(copy.marketMakerLedgerHold);
      expect(byTestId(html, 'market-maker-state')?.text).toBe(copy.marketMakerError);
      expect(byTestId(html, 'market-maker-last-error')?.text).toContain(
        copy.marketMakerUnknownError,
      );
    },
  );
  it.each([
    ['waiting', 'ledger_hold', copy.marketMakerRecallAttemptWaiting, copy.marketMakerRecallHeld],
    [
      'failed',
      'execution_failed',
      copy.marketMakerRecallAttemptFailed,
      copy.marketMakerRecallExecution,
    ],
  ] as const)(
    'shows observed %s separately from pending completion',
    (state, reason, label, detail) => {
      const html = renderWithQueries(
        <MarketMakerFacts
          data={{
            ...marketMaker,
            recall: { status: 'pending' },
            recallAttempt: {
              attempts: 2,
              state,
              reason,
              lastAttemptAt: '2026-11-11T01:30:00.000Z',
              lastFailureAt: state === 'failed' ? '2026-11-11T01:30:00.000Z' : null,
              lastFailureReason: state === 'failed' ? 'execution_failed' : null,
            },
          }}
        />,
      );
      const text = byTestId(html, 'market-maker-recall-attempt')!.text;
      expect(text).toContain(label);
      expect(text).toContain(detail);
      expect(text).toContain('2회');
      expect(html).not.toContain('<button');
    },
  );
  it('separates historical successful opening from current blockers and pending execution', () => {
    const html = renderWithQueries(
      <MarketMakerFacts
        data={{ ...marketMaker, readiness: { blockers: ['ledger_hold', 'intake_closed'] } }}
      />,
    );
    expect(byTestId(html, 'market-maker-last-open')?.text).toContain(copy.marketMakerOpenSucceeded);
    expect(byTestId(html, 'market-maker-readiness')?.text).toContain(copy.marketMakerLedgerHold);
    expect(byTestId(html, 'market-maker-readiness')?.text).toContain(copy.marketMakerIntakeClosed);
    expect(byTestId(html, 'market-maker-readiness')?.text).not.toContain(
      copy.marketMakerNoBlockers,
    );
    expect(byTestId(html, 'market-maker-pending')?.text).toBe(copy.marketMakerPending);
    expect(html).toContain('시험값 7,000');
    expect(html).not.toContain(`${copy.adminReleaseSettingApprovedHint} 7,000`);
    expect(html).not.toContain('<button');
  });
  it('keeps a missing runtime as unobserved, without inventing allocation or choosing risk defaults', () => {
    const html = renderWithQueries(
      <MarketMakerFacts
        data={{
          ...marketMaker,
          config: null,
          openedVersion: null,
          runtime: null,
          lastOpenAttempt: null,
          readiness: { blockers: ['liquidity_missing', 'not_allocated', 'risk_settings_missing'] },
          stageSettings: {
            status: 'undecided',
            reduceAtBp: {
              ...marketMaker.stageSettings.reduceAtBp,
              status: 'undecided',
              value: null,
            },
            haltAtBp: { ...marketMaker.stageSettings.haltAtBp, status: 'undecided', value: null },
            reduceRatioBp: {
              ...marketMaker.stageSettings.reduceRatioBp,
              status: 'undecided',
              value: null,
            },
          },
        }}
      />,
    );
    expect(html).toContain(copy.marketMakerNoRuntime);
    expect(html).toContain(copy.marketMakerNotAllocated);
    expect(html).not.toContain(copy.marketMakerOpenSucceeded);
    expect(html).not.toContain('7000');
    expect(byTestId(html, 'market-maker-state')).toBeUndefined();
  });
  it('uses a neutral fallback for unknown past reasons and keeps raw failure details off the page', () => {
    const html = renderWithQueries(
      <MarketMakerFacts
        data={{
          ...marketMaker,
          runtime: {
            ...marketMaker.runtime!,
            state: 'error',
            reason: 'future_reason',
            lastError: 'SELECT secret_column FROM ledger_accounts <script>secret()</script>',
            lastFailureAt: '2026-11-10T01:11:00.000Z',
          },
        }}
      />,
    );
    expect(html).toContain(copy.marketMakerUnknownReason);
    expect(byTestId(html, 'market-maker-state')?.text).toBe(copy.marketMakerError);
    expect(byTestId(html, 'market-maker-last-error')?.text).toContain(copy.marketMakerUnknownError);
    expect(html).not.toContain('SELECT');
    expect(html).not.toContain('secret_column');
    expect(html).not.toContain('secret()');
    expect(html).not.toContain('<script>');
  });
  it.each([
    ['not_trading', copy.marketMakerMarketNotOpen],
    ['close_passed', copy.marketMakerClosePassed],
    ['paused', copy.marketMakerPaused],
    ['stopped', copy.marketMakerExecutionStopped],
    ['retry_exhausted', copy.marketMakerRetryExhausted],
    ['execution_failed', copy.marketMakerError],
    ['risk_settings_missing', copy.marketMakerRiskSettingsMissing],
    ['risk_settings_invalid', copy.marketMakerRiskSettingsInvalid],
    ['intake_closed', copy.marketMakerIntakeClosed],
    ['no_quotes', copy.marketMakerNoQuotes],
    ['admission_refused', copy.marketMakerAdmissionRefused],
    ['missing_config', copy.marketMakerLiquidityMissing],
    ['missing_market_maker', copy.marketMakerAccountMissing],
    ['missing_funds', copy.marketMakerNotAllocated],
    ['treasury_missing', copy.marketMakerTreasuryMissing],
    ['market_maker_approval_missing', copy.marketMakerApprovalMissing],
    ['market_maker_funds_inconsistent', copy.marketMakerFundsInconsistent],
  ])('explains the historical %s code without replacing current conditions', (reason, label) => {
    const html = renderWithQueries(
      <MarketMakerFacts
        data={{
          ...marketMaker,
          runtime: { ...marketMaker.runtime!, reason, lastError: reason },
          lastOpenAttempt: { ...marketMaker.lastOpenAttempt!, reason, succeededAt: null },
          readiness: { blockers: [] },
        }}
      />,
    );
    expect(byTestId(html, 'market-maker-last-error')?.text).toContain(label);
    expect(byTestId(html, 'market-maker-last-open')?.text).toContain(label);
    expect(byTestId(html, 'market-maker-readiness')?.text).toBe(
      copy.marketMakerCurrentConditions + copy.marketMakerNoBlockers,
    );
    expect(html).not.toContain(reason);
  });
});
