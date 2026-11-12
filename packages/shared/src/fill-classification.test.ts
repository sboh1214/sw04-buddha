import { describe, expect, it } from 'vitest';
import {
  classificationFillIdSchema,
  classificationRevisionSchema,
  requestFillClassificationBodySchema,
  decideFillClassificationBodySchema,
  fillClassificationPayloadSchema,
} from './fill-classification.js';
import { marketStatsEventSchema } from './market-stats.js';

const body = {
  expectedAccountId: 'operator',
  action: 'mark',
  baseRevision: '0',
  reason: '독립 확인한 체결 근거',
};
describe('fixed fill classification contracts', () => {
  it('accepts explicit fixed revisions and trims the private reason', () => {
    expect(requestFillClassificationBodySchema.parse({ ...body, reason: '  근거  ' }).reason).toBe(
      '근거',
    );
    expect(
      requestFillClassificationBodySchema.safeParse({
        ...body,
        action: 'clear',
        baseRevision: '9223372036854775806',
      }).success,
    ).toBe(true);
    expect(classificationFillIdSchema.safeParse('9007199254740991').success).toBe(true);
  });
  it.each(['', '-1', '01', '1.2', 'NaN', '9223372036854775807', '9'.repeat(100)])(
    'refuses unsafe revision %s without throwing',
    (value) => {
      expect(classificationRevisionSchema.safeParse(value).success).toBe(false);
    },
  );
  it.each(['0', '-1', '01', '1.2', '9007199254740992'])('refuses an unsafe fill ID %s', (value) => {
    expect(classificationFillIdSchema.safeParse(value).success).toBe(false);
  });
  it('cannot broaden a fixed fill into a filter, silently change action, or omit the account/reason', () => {
    expect(requestFillClassificationBodySchema.safeParse({ ...body, marketId: 'x' }).success).toBe(
      false,
    );
    expect(requestFillClassificationBodySchema.safeParse({ ...body, action: 'all' }).success).toBe(
      false,
    );
    expect(
      requestFillClassificationBodySchema.safeParse({ ...body, expectedAccountId: undefined })
        .success,
    ).toBe(false);
    expect(
      decideFillClassificationBodySchema.safeParse({ expectedAccountId: 'operator', reason: ' ' })
        .success,
    ).toBe(false);
    expect(
      fillClassificationPayloadSchema.safeParse({
        fillId: '1',
        marketId: '11111111-1111-4111-8111-111111111111',
        action: 'mark',
        baseRevision: '0',
        filter: {},
      }).success,
    ).toBe(false);
  });
  it('publishes only generic participant freshness, with no internal classification fields', () => {
    const parsed = marketStatsEventSchema.parse({
      type: 'market:stats',
      marketId: '11111111-1111-4111-8111-111111111111',
      traderCount: 0,
      statsRevision: '15',
      excluded: true,
      reason: 'private',
    });
    expect(parsed).toEqual({
      type: 'market:stats',
      marketId: '11111111-1111-4111-8111-111111111111',
      traderCount: 0,
      statsRevision: '15',
    });
  });
});
