import {
  assertRiskLimits,
  marketLiquiditySettingsInputSchema,
  type Outcome,
  type RiskLimits,
} from '../../packages/shared/dist/index.js';

/** Synthetic candidates, not approved release values. S is granted ONCE per person across markets. */
export interface Candidate {
  id: string;
  startCoin: bigint;
  budgetCoin: bigint;
  maxLossCoin: bigint;
  b: number;
  levels: number;
  quantity: number;
  safetyTicks: number;
  protectionTicks: number;
  reduceAtBp: number;
  haltAtBp: number;
  reduceRatioBp: number;
}
const candidate = (
  id: string,
  s: number,
  a: number,
  l: number,
  b: number,
  levels: number,
  quantity: number,
  safetyTicks: number,
  protectionTicks: number,
  reduceAtBp: number,
  haltAtBp: number,
  reduceRatioBp: number,
): Candidate => ({
  id,
  startCoin: BigInt(s),
  budgetCoin: BigInt(a),
  maxLossCoin: BigInt(l),
  b,
  levels,
  quantity,
  safetyTicks,
  protectionTicks,
  reduceAtBp,
  haltAtBp,
  reduceRatioBp,
});
export const CANDIDATES: readonly Candidate[] = [
  candidate('C1', 1000, 10000, 2000, 40, 3, 10, 1, 3, 6000, 8000, 2500),
  candidate('C2', 1000, 10000, 2000, 100, 3, 10, 1, 3, 6000, 8000, 2500),
  candidate('C3', 1000, 10000, 2000, 100, 5, 20, 1, 3, 6000, 8000, 2500),
  candidate('C4', 1000, 10000, 2000, 100, 5, 20, 2, 2, 6000, 8000, 2500),
  candidate('C5', 1000, 10000, 4000, 100, 5, 20, 1, 5, 7000, 9000, 5000),
  candidate('C6', 2000, 20000, 8000, 200, 5, 40, 1, 5, 7000, 9000, 5000),
  candidate('C7', 5000, 10000, 2000, 100, 5, 20, 1, 3, 6000, 8000, 2500),
  candidate('C8', 500, 2000, 500, 20, 3, 5, 1, 3, 5000, 7500, 5000),
];
export const limitsOf = (c: Candidate): RiskLimits => ({
  maxLoss: c.maxLossCoin,
  reduceAtBp: c.reduceAtBp,
  haltAtBp: c.haltAtBp,
  reduceRatioBp: c.reduceRatioBp,
});
export function validateCandidate(c: Candidate) {
  marketLiquiditySettingsInputSchema.parse({
    budgetCoin: String(c.budgetCoin),
    maxLossCoin: String(c.maxLossCoin),
    b: c.b,
    levels: c.levels,
    quantity: c.quantity,
    safetyTicks: c.safetyTicks,
  });
  assertRiskLimits(limitsOf(c));
  if (
    c.startCoin < 1n ||
    c.startCoin > 1000000n ||
    !Number.isInteger(c.protectionTicks) ||
    c.protectionTicks < 1 ||
    c.protectionTicks > 98
  )
    throw new RangeError('Invalid simulation grant/protection input');
}

export interface Profile {
  id: string;
  people: number;
  markets: number;
  label: string;
}
export const PROFILES: readonly Profile[] = [20, 100, 500].flatMap((people) =>
  [1, 5, 20].map((markets) => ({
    id: `p${people}-m${markets}`,
    people,
    markets,
    label:
      people === 20 && markets === 1
        ? 'internal'
        : people === 100 && markets === 5
          ? 'initial-public'
          : people === 500 && markets === 20
            ? 'public-pressure'
            : 'scale-sensitivity',
  })),
);
export const SEEDS = [71, 20261112] as const;
export const HORIZON_MS = 420000;
export const SCAN_INTERVAL_MS = 60000;
export const SETTLEMENT_WAIT_MS = 24 * 60 * 60 * 1000;
export const SCENARIOS = [
  'balanced',
  'one-way',
  'whale',
  'news',
  'stale',
  'human-trade',
  'self-trade',
  'settlement',
] as const;
export type Scenario = (typeof SCENARIOS)[number];
export interface ScenarioCase {
  id: string;
  scenario: Scenario;
  refreshDelayMs: number;
  split: number;
  operatorPauseMs: number | null;
}
export const CASES: readonly ScenarioCase[] = [
  { id: 'balanced', scenario: 'balanced', refreshDelayMs: 250, split: 1, operatorPauseMs: null },
  { id: 'one-way', scenario: 'one-way', refreshDelayMs: 250, split: 1, operatorPauseMs: null },
  ...[1, 20].map((split) => ({
    id: `whale-${split}`,
    scenario: 'whale' as const,
    refreshDelayMs: 250,
    split,
    operatorPauseMs: null,
  })),
  ...[0, 30000, 300000].map((operatorPauseMs) => ({
    id: `news-stop-${operatorPauseMs}`,
    scenario: 'news' as const,
    refreshDelayMs: 250,
    split: 1,
    operatorPauseMs,
  })),
  ...[0, 250, 1000, 5000].map((refreshDelayMs) => ({
    id: `stale-${refreshDelayMs}`,
    scenario: 'stale' as const,
    refreshDelayMs,
    split: 1,
    operatorPauseMs: null,
  })),
  {
    id: 'human-trade',
    scenario: 'human-trade',
    refreshDelayMs: 250,
    split: 1,
    operatorPauseMs: null,
  },
  {
    id: 'self-trade',
    scenario: 'self-trade',
    refreshDelayMs: 250,
    split: 1,
    operatorPauseMs: null,
  },
  {
    id: 'settlement',
    scenario: 'settlement',
    refreshDelayMs: 250,
    split: 1,
    operatorPauseMs: null,
  },
];

/** Budget fractions are based on the once-granted S, never on future winnings. No made-up regrant. */
export type TapeEvent =
  | {
      kind: 'buy';
      id: string;
      at: number;
      actor: number;
      market: number;
      outcome: Outcome;
      budgetBp: number;
      part: number;
      parts: number;
      limit: number;
    }
  | {
      kind: 'post-buy' | 'sell';
      id: string;
      at: number;
      actor: number;
      market: number;
      outcome: Outcome;
      budgetBp: number;
      limit: number;
    }
  | { kind: 'bot-stop' | 'pause' | 'close'; id: string; at: number; market: number }
  | { kind: 'replay'; id: string; at: number; requestId: string };

/** Fixed integer PRNG for the synthetic actors/directions, not a source of probability estimates. */
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
export function createTape(profile: Profile, scenario: ScenarioCase, seed: number): TapeEvent[] {
  const draw = random(seed);
  const result: TapeEvent[] = [];
  let sequence = 0;
  const id = () => `input-${sequence++}`;
  const direction: Outcome = seed % 2 === 0 ? 'YES' : 'NO';
  const buy = (
    actor: number,
    market: number,
    at: number,
    outcome: Outcome,
    budgetBp: number,
    parts = 1,
    part = 0,
    limit = 99,
  ) => {
    const event: TapeEvent = {
      kind: 'buy',
      id: id(),
      at,
      actor,
      market,
      outcome,
      budgetBp,
      parts,
      part,
      limit,
    };
    result.push(event);
    return event;
  };
  if (scenario.scenario === 'human-trade' || scenario.scenario === 'self-trade') {
    for (let market = 0; market < profile.markets; market++) {
      result.push({ kind: 'bot-stop', id: id(), at: 0, market });
      const a = (market * 2) % profile.people,
        b = (a + 1) % profile.people;
      result.push({
        kind: 'post-buy',
        id: id(),
        at: 1000,
        actor: a,
        market,
        outcome: 'YES',
        budgetBp: 1000,
        limit: 50,
      });
      buy(scenario.scenario === 'self-trade' ? a : b, market, 1001, 'NO', 1000, 1, 0, 50);
      // A real, separate person next buys the opposite side, creating fully collateralized pairs.
      if (scenario.scenario === 'self-trade') buy(b, market, 1002, 'NO', 1000, 1, 0, 50);
      result.push({
        kind: 'post-buy',
        id: id(),
        at: 2000,
        actor: b,
        market,
        outcome: 'YES',
        budgetBp: 1000,
        limit: 51,
      });
      result.push({
        kind: 'sell',
        id: id(),
        at: 2001,
        actor: a,
        market,
        outcome: 'YES',
        budgetBp: 1000,
        limit: 1,
      });
    }
  } else if (scenario.scenario === 'whale') {
    for (let actor = profile.markets; actor < profile.people; actor++)
      buy(
        actor,
        actor % profile.markets,
        1000 + Math.floor(actor / 10) * 250,
        draw() < 0.5 ? 'YES' : 'NO',
        100,
      );
    for (let market = 0; market < profile.markets; market++)
      for (let part = 0; part < scenario.split; part++) {
        buy(
          market % profile.people,
          market,
          61000 + part * 250,
          direction,
          10000,
          scenario.split,
          part,
        );
      }
  } else {
    const batches =
      scenario.scenario === 'news'
        ? [1000, 61000, 106000, 371000]
        : scenario.scenario === 'stale'
          ? [1000, 1020, 1040, 1060]
          : [1000, 61000, 121000, 181000];
    for (let round = 0; round < batches.length; round++)
      for (let actor = 0; actor < profile.people; actor++) {
        const outcome: Outcome =
          scenario.scenario === 'one-way' ||
          (scenario.scenario === 'news' && round > 0) ||
          scenario.scenario === 'stale'
            ? direction
            : draw() < 0.5
              ? 'YES'
              : 'NO';
        const budgetBp = round % 2 === 0 ? 100 : 1000;
        buy(
          actor,
          actor % profile.markets,
          batches[round]! + Math.floor(actor / 10) * (scenario.scenario === 'stale' ? 1 : 250),
          outcome,
          budgetBp,
          1,
          0,
          scenario.scenario === 'news' && round > 0 ? 90 : 99,
        );
      }
    if (scenario.operatorPauseMs !== null)
      for (let market = 0; market < profile.markets; market++)
        result.push({ kind: 'pause', id: id(), at: 60000 + scenario.operatorPauseMs, market });
  }
  // Replays carry the very same id and terms at the adapter boundary, never a second spend.
  const first = result.find((event) => event.kind === 'buy');
  if (first) result.push({ kind: 'replay', id: id(), requestId: first.id, at: first.at + 1 });
  for (let market = 0; market < profile.markets; market++) {
    result.push({ kind: 'close', id: id(), at: HORIZON_MS, market });
    buy(market % profile.people, market, HORIZON_MS + 1, 'YES', 100);
  }
  return result.sort((a, b) => a.at - b.at || Number(a.id.slice(6)) - Number(b.id.slice(6)));
}

export function coinBudget(c: Candidate, event: Extract<TapeEvent, { kind: 'buy' }>): bigint {
  const total = (c.startCoin * BigInt(event.budgetBp)) / 10000n;
  const parts = BigInt(event.parts);
  const remainder = total % parts;
  return total / parts + (BigInt(event.part) < remainder ? 1n : 0n);
}
