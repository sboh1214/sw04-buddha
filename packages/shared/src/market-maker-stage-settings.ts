import { assertRiskLimits } from './market-maker/risk.js';
import type { ReleaseSettingReading } from './release-settings.js';

export interface MarketMakerStageSettings {
  reduceAtBp: number;
  haltAtBp: number;
  reduceRatioBp: number;
}

export type MarketMakerStageSettingsResult =
  | { kind: 'ready'; settings: MarketMakerStageSettings }
  | { kind: 'unavailable'; reason: 'undecided' | 'invalid' };

/** Proposal/test values execute too; absent or incompatible values never get defaults. */
export function marketMakerStageSettings(readings: {
  reduceAtBp: ReleaseSettingReading<number>;
  haltAtBp: ReleaseSettingReading<number>;
  reduceRatioBp: ReleaseSettingReading<number>;
}): MarketMakerStageSettingsResult {
  const { reduceAtBp, haltAtBp, reduceRatioBp } = readings;
  if (
    reduceAtBp.status === 'undecided' ||
    haltAtBp.status === 'undecided' ||
    reduceRatioBp.status === 'undecided'
  )
    return { kind: 'unavailable', reason: 'undecided' };
  const settings = {
    reduceAtBp: reduceAtBp.value,
    haltAtBp: haltAtBp.value,
    reduceRatioBp: reduceRatioBp.value,
  };
  try {
    // maxLoss is irrelevant to the global ratios; the market supplies its own fixed limit.
    assertRiskLimits({ maxLoss: 1n, ...settings });
  } catch {
    return { kind: 'unavailable', reason: 'invalid' };
  }
  return { kind: 'ready', settings };
}
