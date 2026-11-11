import { describe, expect, it } from 'vitest';
import {
  RELEASE_SETTINGS,
  TRADING_ANOMALY_SETTINGS,
  readReleaseSetting,
} from './release-settings.js';
import { findPrivateField } from './guards/private-data.js';
import {
  tradingAnomalyQuerySchema,
  tradingAnomalyReportSchema,
  TRADING_ANOMALY_SCAN_LIMIT,
  TRADING_ANOMALY_CANDIDATE_LIMIT,
  TRADING_ANOMALY_EVIDENCE_LIMIT,
} from './trading-anomalies.js';

describe('private trading anomaly contract', () => {
  it('registers all six positive explicit-only values with no launch defaults', () => {
    expect(Object.values(TRADING_ANOMALY_SETTINGS)).toHaveLength(6);
    for (const definition of Object.values(TRADING_ANOMALY_SETTINGS)) {
      expect(RELEASE_SETTINGS.get(definition.key)).toBe(definition);
      expect(readReleaseSetting(RELEASE_SETTINGS, definition, undefined)).toEqual({
        key: definition.key,
        status: 'undecided',
        value: null,
      });
      expect(definition.schema.safeParse(0).success).toBe(false);
      expect(definition.schema.safeParse(1.5).success).toBe(false);
      expect(definition.schema.safeParse(1).success).toBe(true);
    }
  });
  it('bounds response work separately from operator detection thresholds', () => {
    expect([
      TRADING_ANOMALY_SCAN_LIMIT,
      TRADING_ANOMALY_CANDIDATE_LIMIT,
      TRADING_ANOMALY_EVIDENCE_LIMIT,
    ]).toEqual([10000, 200, 50]);
    expect(TRADING_ANOMALY_SETTINGS.pairCount.schema.safeParse(10001).success).toBe(true);
  });
  it('accepts only optional market identity, never an arbitrary person or private-data search', () => {
    expect(tradingAnomalyQuerySchema.parse({})).toEqual({});
    expect(tradingAnomalyQuerySchema.safeParse({ marketId: 'bad' }).success).toBe(false);
    expect(tradingAnomalyQuerySchema.safeParse({ email: 'x@example.test' }).success).toBe(false);
    expect(tradingAnomalyQuerySchema.safeParse({ userId: 'person' }).success).toBe(false);
  });
  it('requires explicit settings and source completeness, rather than treating unavailable as empty', () => {
    expect(tradingAnomalyReportSchema.safeParse({ candidates: [] }).success).toBe(false);
    expect(
      tradingAnomalyReportSchema.parse({
        asOf: '2026-11-11T00:00:00.000Z',
        marketId: null,
        rangeStartedAt: null,
        source: {
          scannedFills: 0,
          limit: 10000,
          truncated: false,
          complete: false,
          oldestScannedAt: null,
        },
        signals: [],
        candidates: [],
      }),
    ).toMatchObject({ source: { complete: false } });
  });
  it.each(['tradingAnomaly', 'trading_anomalies', 'anomalyCandidates', 'roundTrip', 'humanPair'])(
    'guards the private report term %s',
    (name) => {
      expect(findPrivateField(name).map((row) => row.item)).toContain('risk-flag');
    },
  );
});
