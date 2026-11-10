import { describe, expect, it } from 'vitest';
import { marketMakerStageSettings } from './market-maker-stage-settings.js';
import {
  MARKET_MAKER_REDUCE_AT_BP_SETTING,
  MARKET_MAKER_HALT_AT_BP_SETTING,
  MARKET_MAKER_REDUCE_RATIO_BP_SETTING,
  RELEASE_SETTINGS,
  readReleaseSetting,
  type ReleaseSettingStatus,
} from './index.js';

const definitions = {
  reduceAtBp: MARKET_MAKER_REDUCE_AT_BP_SETTING,
  haltAtBp: MARKET_MAKER_HALT_AT_BP_SETTING,
  reduceRatioBp: MARKET_MAKER_REDUCE_RATIO_BP_SETTING,
};
function readings(
  values: [number | null, number | null, number | null],
  status: Exclude<ReleaseSettingStatus, 'undecided'> = 'approved',
) {
  const read = (key: keyof typeof definitions, value: number | null) =>
    readReleaseSetting(
      RELEASE_SETTINGS,
      definitions[key],
      value === null ? undefined : { status, value },
    );
  return {
    reduceAtBp: read('reduceAtBp', values[0]),
    haltAtBp: read('haltAtBp', values[1]),
    reduceRatioBp: read('reduceRatioBp', values[2]),
  };
}

describe('global market maker stage settings', () => {
  it.each([
    [null, 8_000, 2_500],
    [6_000, null, 2_500],
    [6_000, 8_000, null],
  ] as const)(
    'refuses to infer any missing threshold or ratio (%s, %s, %s)',
    (reduce, halt, ratio) => {
      expect(marketMakerStageSettings(readings([reduce, halt, ratio]))).toEqual({
        kind: 'unavailable',
        reason: 'undecided',
      });
    },
  );
  it.each(['proposal', 'test', 'approved'] as const)(
    'uses an explicit %s value without another default',
    (status) => {
      expect(marketMakerStageSettings(readings([6_000, 8_000, 2_500], status))).toEqual({
        kind: 'ready',
        settings: { reduceAtBp: 6_000, haltAtBp: 8_000, reduceRatioBp: 2_500 },
      });
    },
  );
  it.each([
    [0, 0, 0],
    [10_000, 10_000, 5_000],
  ])('keeps the existing inclusive math boundary %s/%s/%s', (reduce, halt, ratio) => {
    expect(marketMakerStageSettings(readings([reduce, halt, ratio])).kind).toBe('ready');
  });
  it('refuses individually valid settings whose reduction threshold exceeds halt', () => {
    expect(marketMakerStageSettings(readings([8_001, 8_000, 2_500]))).toEqual({
      kind: 'unavailable',
      reason: 'invalid',
    });
  });
  it.each([-1, 0.5, Infinity, 10_001])(
    'rejects an invalid stored threshold %s at the normal setting reader',
    (value) => {
      expect(() => readings([value, 10_000, 2_500])).toThrow('stored value does not fit');
    },
  );
  it.each([-1, 0.5, Infinity, 5_001])('rejects an invalid stored reduction ratio %s', (value) => {
    expect(() => readings([6_000, 8_000, value])).toThrow('stored value does not fit');
  });
});
