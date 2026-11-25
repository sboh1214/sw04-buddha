import { type Outcome } from '../../packages/shared/dist/index.js';
import { HORIZON_MS, random, type Profile, type TapeEvent } from '../economic-simulation/inputs.ts';
import {
  BUNDLE,
  DELAY_MAX_HOURS,
  NORMAL_SPEND_BP,
  type Behaviour,
  type PersonType,
  type Variant,
} from './inputs.ts';

/*
 * #332 tapes in #71's `TapeEvent` form. Every draw is made whatever the state, in a fixed order, so
 * R0–R5 of one seed, combination and variant share the same people, directions and results — only
 * the amounts (from each wallet) and who trades (not someone waiting for a retry) differ.
 */

export interface Person {
  type: PersonType;
  behaviour: Behaviour;
  /** 지연 only: whole hours after the settlement it saw itself exhausted at (0–72). */
  delayHours: number;
}

type Draw = () => number;

/** Fisher–Yates with the #71 LCG: always n − 1 draws. */
function shuffled(n: number, draw: Draw): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(draw() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** Exact shares (n × share is whole for 20/100/500 people), assigned by seeded shuffles. */
export function assignPeople(people: number, variant: Variant, draw: Draw): Person[] {
  const byType = shuffled(people, draw);
  const byBehaviour = shuffled(people, draw);
  const exhaust = (people * variant.exhaustBp) / 10000;
  const immediate = (people * variant.behaviourBp.immediate) / 10000;
  const delayed = (people * variant.behaviourBp.delayed) / 10000;
  if (![exhaust, immediate, delayed].every(Number.isInteger))
    throw new RangeError('Variant shares must give whole people');
  const result: Person[] = Array.from({ length: people }, () => ({
    type: 'normal',
    behaviour: 'never',
    delayHours: 0,
  }));
  byType.forEach((person, rank) => {
    result[person]!.type = rank < exhaust ? 'exhaust' : 'normal';
  });
  byBehaviour.forEach((person, rank) => {
    result[person]!.behaviour =
      rank < immediate ? 'immediate' : rank < immediate + delayed ? 'delayed' : 'never';
  });
  for (const person of result) person.delayHours = Math.floor(draw() * (DELAY_MAX_HOURS + 1));
  return result;
}

export function createRandom(seed: number): Draw {
  return random(seed);
}

/** What one cycle draws, whatever the state: the order people arrive, their sides, the results. */
export interface CycleDraws {
  order: number[];
  sides: Outcome[];
  results: Outcome[];
}
export function drawCycle(profile: Profile, draw: Draw): CycleDraws {
  const order = shuffled(profile.people, draw);
  const sides = Array.from({ length: profile.people }, (): Outcome =>
    draw() < 0.5 ? 'YES' : 'NO',
  );
  const results = Array.from({ length: profile.markets }, (): Outcome =>
    draw() < 0.5 ? 'YES' : 'NO',
  );
  return { order, sides, results };
}

/** The Coin a person means to spend: 10% of available (일반형) or all of it (소진형). */
export function intendedCoin(person: Person, available: bigint): bigint {
  return person.type === 'exhaust' ? available : (available * BigInt(NORMAL_SPEND_BP)) / 10000n;
}

/** `budgetBp = ⌊amount × 10000 / S⌋` — #71's buy input, its budget a share of the once-granted S. */
export const budgetBpOf = (amount: bigint) => Number((amount * 10000n) / BUNDLE.startCoin);

/**
 * One cycle's tape. People arrive in the drawn order at #71's balanced pace (ten per 250ms from
 * 1s), each one IOC budget buy in market `person % markets`, held to the end. `trading[i]` false
 * (waiting for a retry) or a zero budget leaves the person out; the draws are made regardless.
 * Then #71's same-id replay of the first buy, the closes at the horizon and a probe buy after.
 */
export function createCycleTape(
  cycle: number,
  profile: Profile,
  people: readonly Person[],
  available: readonly bigint[],
  trading: readonly boolean[],
  draws: CycleDraws,
): TapeEvent[] {
  const result: TapeEvent[] = [];
  let sequence = 0;
  const id = () => `c${String(cycle).padStart(2, '0')}-input-${sequence++}`;
  draws.order.forEach((actor, position) => {
    if (!trading[actor]) return;
    const budgetBp = budgetBpOf(intendedCoin(people[actor]!, available[actor]!));
    if (budgetBp === 0) return;
    result.push({
      kind: 'buy',
      id: id(),
      at: 1000 + Math.floor(position / 10) * 250,
      actor,
      market: actor % profile.markets,
      outcome: draws.sides[actor]!,
      budgetBp,
      parts: 1,
      part: 0,
      limit: 99,
    });
  });
  const first = result[0];
  if (first) result.push({ kind: 'replay', id: id(), requestId: first.id, at: first.at + 1 });
  for (let market = 0; market < profile.markets; market++) {
    result.push({ kind: 'close', id: id(), at: HORIZON_MS, market });
    result.push({
      kind: 'buy',
      id: id(),
      at: HORIZON_MS + 1,
      actor: market % profile.people,
      market,
      outcome: 'YES',
      budgetBp: 100,
      parts: 1,
      part: 0,
      limit: 99,
    });
  }
  const order = (e: TapeEvent) => Number(e.id.slice(e.id.lastIndexOf('-') + 1));
  return result.sort((a, b) => a.at - b.at || order(a) - order(b));
}
