import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { tradingAnomaliesKey } from '@/hooks/use-trading-anomalies';
import { nicknameShown } from '@/lib/account-closure';
import { byTagName, byTestId, renderWithQueries } from '@/test/render';
import { anomalyCandidate, anomalyReport } from '@/test/trading-anomalies';
import { system } from '@/theme/system';
import { AnomalyCard, AnomalyReport, TradingAnomaliesScreen } from './trading-anomalies';

describe('anomaly report presentation', () => {
  it('shows a failed refresh beside the preserved report instead of a fresh empty result', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = tradingAnomaliesKey('admin-a', '');
    client.setQueryData(['me'], { id: 'admin-a' });
    client.setQueryData(key, anomalyReport);
    try {
      await expect(
        client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error('503')) }),
      ).rejects.toThrow('503');
      const html = renderToStaticMarkup(
        <ChakraProvider value={system}>
          <QueryClientProvider client={client}>
            <TradingAnomaliesScreen />
          </QueryClientProvider>
        </ChakraProvider>,
      );
      expect(html).toContain(copy.anomalyRefreshFailed);
      expect(byTestId(html, 'anomaly-report')).toBeDefined();
      expect(byTestId(html, 'anomaly-empty')).toBeUndefined();
      expect(html).toContain(anomalyCandidate.market.title);
    } finally {
      client.clear();
    }
  });
  it('keeps actual legs, exact bigint quantity, current names and private review links', () => {
    const html = renderWithQueries(<AnomalyCard candidate={anomalyCandidate} />);
    expect(html).toContain('9,007,199,254,740,993');
    expect(html).toContain('9007199254740993');
    expect(html).toContain('YES');
    expect(html).toContain('NO');
    expect(html).toContain('37');
    expect(html).toContain('63');
    expect(html).toContain('/admin/markets/');
    expect(html).toContain('/admin/moderation/users/person-a');
    expect(html).toContain('/admin/moderation/users/person-b');
    expect(byTagName(html, 'button')).toHaveLength(0);
    expect(byTagName(html, 'details')).toHaveLength(1);
  });
  it('uses the closed-account nickname policy without exposing any substitute identifiers', () => {
    const html = renderWithQueries(
      <AnomalyCard
        candidate={{
          ...anomalyCandidate,
          actors: [{ userId: 'person-a', nickname: null }, anomalyCandidate.actors[1]!],
        }}
      />,
    );
    expect(html).toContain(nicknameShown(null));
    expect(byTagName(html, 'a').some((link) => link.text === 'person-a')).toBe(false);
  });
  it('distinguishes an unavailable calculation from an empty completed scan', () => {
    const undecided = {
      ...anomalyReport,
      candidates: [],
      source: { ...anomalyReport.source, complete: false },
      signals: anomalyReport.signals.map((signal) => ({ ...signal, status: 'undecided' as const })),
    };
    expect(
      byTestId(renderWithQueries(<AnomalyReport report={undecided} />), 'anomaly-empty')?.text,
    ).toBe(copy.anomalyUnavailableEmpty);
    expect(
      byTestId(
        renderWithQueries(<AnomalyReport report={{ ...anomalyReport, candidates: [] }} />),
        'anomaly-empty',
      )?.text,
    ).toBe(copy.anomalyEmpty);
  });
  it('never calls a truncated empty result a complete negative finding', () => {
    const report = {
      ...anomalyReport,
      candidates: [],
      source: { ...anomalyReport.source, truncated: true, complete: false },
    };
    const html = renderWithQueries(<AnomalyReport report={report} />);
    expect(byTestId(html, 'anomaly-empty')?.text).toBe(copy.anomalyPartialEmpty);
    expect(byTestId(html, 'anomaly-partial')?.text).toContain(copy.anomalyPartialHint);
  });
  it('labels candidate and evidence truncation independently', () => {
    const report = {
      ...anomalyReport,
      signals: anomalyReport.signals.map((signal) => ({ ...signal, candidatesTruncated: true })),
      candidates: [{ ...anomalyCandidate, evidenceTruncated: true, evidenceTotal: '100' }],
    };
    const html = renderWithQueries(<AnomalyReport report={report} />);
    expect(byTestId(html, 'anomaly-partial')).toBeDefined();
    expect(byTestId(html, 'anomaly-evidence-partial')?.text).toBe(copy.anomalyEvidencePartial);
  });
  it('only draws ready signal candidates and explains invalid combinations', () => {
    const report = {
      ...anomalyReport,
      signals: anomalyReport.signals.map((signal) => ({ ...signal, status: 'invalid' as const })),
    };
    const html = renderWithQueries(<AnomalyReport report={report} />);
    expect(byTestId(html, 'anomaly-candidate')).toBeUndefined();
    expect(html).toContain(copy.anomalyInvalidHint);
  });
  it('renders one local page with a local-more button and a fixed snapshot explanation', () => {
    const report = {
      ...anomalyReport,
      candidates: Array.from({ length: 21 }, (_, i) => ({ ...anomalyCandidate, id: String(i) })),
    };
    const html = renderWithQueries(<AnomalyReport report={report} />);
    expect((html.match(/data-testid="anomaly-candidate"/g) ?? []).length).toBe(20);
    expect(byTagName(html, 'button').map((row) => row.text)).toEqual([copy.anomalyMore]);
    expect(html).toContain(copy.anomalySnapshotHint);
    expect(html).toContain(copy.anomalyRoundTripHint);
  });
  it('shows only read controls and the non-judgment warning in the actual screen', () => {
    const html = renderWithQueries(<TradingAnomaliesScreen />, [
      [['me'], { id: 'admin-a' }],
      [tradingAnomaliesKey('admin-a', ''), anomalyReport],
    ]);
    expect(html).toContain(copy.anomalyPurpose);
    expect(byTagName(html, 'button').map((row) => row.text)).toEqual([
      copy.anomalyApplyFilter,
      copy.anomalyRecalculate,
    ]);
    expect(byTestId(html, 'anomaly-report')).toBeDefined();
  });
});
