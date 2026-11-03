import { describe, expect, it } from 'vitest';
import { MARKET_STATUSES, type MarketStatus } from './enums.js';
import {
  INTERIM_MARKET_TRANSITIONS,
  MARKET_LIFECYCLE_TRANSITIONS,
  PRE_CLOSE_MARKET_STATUSES,
  canTransitionMarket,
  isPreCloseMarketStatus,
} from './market-lifecycle.js';

/** Every allowed (from, to) pair, as `from>to`. */
function allowedPairs(): string[] {
  return MARKET_STATUSES.flatMap((from) =>
    MARKET_STATUSES.filter((to) => canTransitionMarket(from, to)).map((to) => `${from}>${to}`),
  );
}

describe('market lifecycle transitions (N03 §3, ADR-0093, #174)', () => {
  it("is exactly N03 §3's order, OPEN ↔ PAUSED, ADR-0093's additions and one interim edge", () => {
    expect(allowedPairs().sort()).toEqual(
      [
        // N03 §3, in order.
        'draft>review',
        'review>scheduled',
        'scheduled>open',
        'open>closed',
        'closed>provisional',
        'provisional>resolved',
        'resolved>settling',
        'settling>settled',
        // OPEN ↔ PAUSED.
        'open>paused',
        'paused>open',
        // ADR-0093 result 1: back to a draft, ended before opening, the early or scheduled close
        // of a paused market, and the close with no user fill.
        'review>draft',
        'scheduled>draft',
        'scheduled>cancelled',
        'paused>closed',
        'open>cancelled',
        'paused>cancelled',
        // Interim: today's immediate judgement (#152). #21 removed the direct open from a draft.
        'closed>resolved',
      ].sort(),
    );
  });

  it('opens a market only from SCHEDULED, besides the resume of a paused one (#21)', () => {
    // The interim draft → open is gone: a draft reaches OPEN only through review and approval.
    expect(canTransitionMarket('draft', 'open')).toBe(false);
    expect(MARKET_STATUSES.filter((from) => canTransitionMarket(from, 'open'))).toEqual([
      'scheduled',
      'paused',
    ]);
    expect(INTERIM_MARKET_TRANSITIONS.some((edge) => edge.to === 'open')).toBe(false);
  });

  it('never reopens a closed market and never goes back from a confirmed result', () => {
    for (const to of ['open', 'paused'] as const) {
      for (const from of [
        'closed',
        'provisional',
        'resolved',
        'settling',
        'settled',
        'cancelled',
      ] as const) {
        expect(canTransitionMarket(from, to)).toBe(false);
      }
    }
    expect(canTransitionMarket('resolved', 'provisional')).toBe(false);
    expect(canTransitionMarket('settled', 'settling')).toBe(false);
  });

  it('ends at SETTLED and CANCELLED, and repeats no status', () => {
    expect(MARKET_LIFECYCLE_TRANSITIONS.settled).toEqual([]);
    expect(MARKET_LIFECYCLE_TRANSITIONS.cancelled).toEqual([]);
    for (const status of MARKET_STATUSES) expect(canTransitionMarket(status, status)).toBe(false);
  });

  it('names the issue that removes each interim edge, none of which is a lifecycle edge', () => {
    for (const edge of INTERIM_MARKET_TRANSITIONS) {
      expect(edge.until).toMatch(/^#\d+$/);
      expect(MARKET_LIFECYCLE_TRANSITIONS[edge.from]).not.toContain(edge.to);
    }
  });

  it('reaches every status from a draft', () => {
    const reached = new Set<MarketStatus>(['draft']);
    for (let changed = true; changed;) {
      changed = false;
      for (const from of [...reached]) {
        for (const to of MARKET_LIFECYCLE_TRANSITIONS[from]) {
          if (!reached.has(to)) {
            reached.add(to);
            changed = true;
          }
        }
      }
    }
    expect([...reached].sort()).toEqual([...MARKET_STATUSES].sort());
  });
});

describe('PRE_CLOSE_MARKET_STATUSES', () => {
  it('is every status before the close, a paused market included (ADR-0093 decision 1 item 3)', () => {
    expect(PRE_CLOSE_MARKET_STATUSES).toEqual(['draft', 'review', 'scheduled', 'open', 'paused']);
    expect(isPreCloseMarketStatus('paused')).toBe(true);
    expect(isPreCloseMarketStatus('closed')).toBe(false);
    expect(isPreCloseMarketStatus('cancelled')).toBe(false);
  });
});
