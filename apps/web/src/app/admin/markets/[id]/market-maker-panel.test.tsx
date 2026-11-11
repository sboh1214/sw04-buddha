import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { marketMaker } from '@/test/market-maker';
import { byTestId, renderWithQueries } from '@/test/render';
import { MarketMakerFacts } from './market-maker-panel';

describe('private market maker execution observations', () => {
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
