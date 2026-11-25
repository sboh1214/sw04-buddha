import { REGRANT_SETTINGS } from '../../packages/shared/dist/index.js';
import {
  CANDIDATES,
  CASES,
  HORIZON_MS,
  PROFILES,
  SEEDS,
  SETTLEMENT_WAIT_MS,
  type Candidate,
  type ScenarioCase,
} from '../economic-simulation/inputs.ts';
import { type RegrantValues } from './rule.ts';

/*
 * #332 inputs (owner answers 332-1 (a), 332-2 (b), ADR-0172). Every ratio, time and candidate here
 * is a synthetic test input, not a demand forecast nor a verified or recommended release value
 * (N01 §10, N00 §7). Only the C5 bundle the owner chose (133-33) is run.
 */

const c5 = CANDIDATES.find((c) => c.id === 'C5');
if (!c5) throw new Error('#71 candidate C5 is missing');
export const BUNDLE: Candidate = c5;
/** #71's nine people × market combinations, unchanged. */
export { PROFILES, SEEDS };
/** The cycle's market scenario: #71's `balanced` case (refresh 250ms), only its timing is used. */
const balanced = CASES.find((c) => c.id === 'balanced');
if (!balanced) throw new Error('#71 balanced case is missing');
export const MARKET_CASE: ScenarioCase = balanced;

/** One cycle: open → #71's 7-minute tape → close → settle 24h later → re-grant requests. */
export const CYCLE_MS = HORIZON_MS + SETTLEMENT_WAIT_MS;
export const CYCLES = 60;
/** The start grant is paid at time 0, when the first cycle opens (the wait counts from it). */
export const START_GRANTED_AT = 0;

export interface RegrantCandidate {
  id: string;
  /** null: the six undecided ('준비 중', `not_ready`) — the control. */
  values: RegrantValues | null;
}
const regrant = (
  id: string,
  threshold: number,
  amount: number,
  waitHours: number,
  periodDays: number,
  periodLimit: number,
  cap: number,
): RegrantCandidate => ({
  id,
  values: {
    thresholdCoin: BigInt(threshold),
    amountCoin: BigInt(amount),
    waitHours,
    periodDays,
    periodLimit,
    totalCapCoin: BigInt(cap),
  },
});
export const REGRANT_CANDIDATES: readonly RegrantCandidate[] = [
  { id: 'R0', values: null },
  regrant('R1', 50, 200, 168, 30, 1, 1000),
  regrant('R2', 100, 500, 72, 30, 2, 2000),
  regrant('R3', 100, 1000, 168, 30, 2, 3000),
  regrant('R4', 200, 1000, 24, 7, 2, 10000),
  regrant('R5', 500, 1000, 0, 7, 7, 50000),
];

/** Every threshold R1–R5 use: exhaustion is also counted at each, so R0 pairs with any Rk. */
export const THRESHOLDS: readonly bigint[] = [
  ...new Set(REGRANT_CANDIDATES.flatMap((c) => (c.values ? [c.values.thresholdCoin] : []))),
].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
/**
 * R0 has no threshold, so the driver needs one only to decide when a simulated person sends a
 * request (always refused `not_ready`, nothing changes): the smallest R1–R5 threshold.
 */
export const R0_APPLY_AT_COIN: bigint = THRESHOLDS[0]!;

/** The six ranges of the release settings, and #332's constraints (threshold < S, cap = k × amount). */
export function validateRegrant(c: RegrantCandidate, bundle: Candidate = BUNDLE) {
  if (c.values === null) return;
  const v = c.values;
  REGRANT_SETTINGS.thresholdCoin.schema.parse(Number(v.thresholdCoin));
  REGRANT_SETTINGS.amountCoin.schema.parse(Number(v.amountCoin));
  REGRANT_SETTINGS.waitHours.schema.parse(v.waitHours);
  REGRANT_SETTINGS.periodDays.schema.parse(v.periodDays);
  REGRANT_SETTINGS.periodLimit.schema.parse(v.periodLimit);
  REGRANT_SETTINGS.totalCapCoin.schema.parse(Number(v.totalCapCoin));
  if (v.thresholdCoin >= bundle.startCoin)
    throw new RangeError(`${c.id}: a fresh account would count as exhausted`);
  if (v.totalCapCoin % v.amountCoin !== 0n)
    throw new RangeError(`${c.id}: the cap must be a whole number of grants`);
}

export type PersonType = 'normal' | 'exhaust';
export type Behaviour = 'immediate' | 'delayed' | 'never';
export interface Variant {
  id: string;
  label: string;
  /** Share of 소진형 people (spend all available each cycle), basis points. */
  exhaustBp: number;
  /** Shares of 즉시 / 지연 / 안 함 among people who become exhausted, basis points. */
  behaviourBp: Record<Behaviour, number>;
}
export const VARIANTS: readonly Variant[] = [
  {
    id: 'V1',
    label: '기본',
    exhaustBp: 2000,
    behaviourBp: { immediate: 6000, delayed: 3000, never: 1000 },
  },
  {
    id: 'V2',
    label: '소진 압력',
    exhaustBp: 5000,
    behaviourBp: { immediate: 9000, delayed: 1000, never: 0 },
  },
];
/** 일반형 buys with this share of its available Coin; 소진형 with all of it. */
export const NORMAL_SPEND_BP = 1000;
/** 지연 sends its request this many whole hours after the settlement it saw itself exhausted at. */
export const DELAY_MAX_HOURS = 72;
