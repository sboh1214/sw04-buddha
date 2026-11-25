import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Economy, digest } from '../economic-simulation/model.ts';
import {
  Invariants,
  NEW_INVARIANTS,
  RegrantRun,
  SETTLEMENT_INVARIANTS,
  carryOver,
  checkIssuance,
  checkMint,
  checkMintOnce,
  checkPnlBasis,
  settleCycle,
  simulateRegrant,
  type RunInput,
} from './driver.ts';
import {
  BUNDLE,
  CYCLE_MS,
  MARKET_CASE,
  PROFILES,
  REGRANT_CANDIDATES,
  SEEDS,
  VARIANTS,
  validateRegrant,
} from './inputs.ts';
import {
  HOUR_MS,
  decide,
  readHistory,
  type RegrantFacts,
  type RegrantRow,
  type RegrantValues,
} from './rule.ts';

const candidate = (id: string) => REGRANT_CANDIDATES.find((c) => c.id === id)!;
const profile = (id: string) => PROFILES.find((p) => p.id === id)!;
const input = (c: string, p: string, v = 'V1', seed: number = SEEDS[0]): RunInput => ({
  candidate: candidate(c),
  profile: profile(p),
  variant: VARIANTS.find((x) => x.id === v)!,
  seed,
});

await test('the matrix is 6 candidates × 9 combinations × 2 variants × 2 seeds = 216 runs on C5', () => {
  assert.equal(REGRANT_CANDIDATES.length * PROFILES.length * VARIANTS.length * SEEDS.length, 216);
  assert.equal(BUNDLE.id, 'C5');
  for (const c of REGRANT_CANDIDATES) validateRegrant(c);
  assert.throws(() =>
    validateRegrant({ id: 'x', values: { ...candidate('R2').values!, thresholdCoin: 1000n } }),
  );
  assert.throws(() =>
    validateRegrant({ id: 'x', values: { ...candidate('R2').values!, totalCapCoin: 2100n } }),
  );
  assert.throws(() =>
    validateRegrant({ id: 'x', values: { ...candidate('R2').values!, periodLimit: 0 } }),
  );
});

await test('a run is deterministic, and R0–R5 share people, directions and results', () => {
  const a = simulateRegrant(input('R2', 'p20-m1'));
  const b = simulateRegrant(input('R2', 'p20-m1'));
  assert.equal(digest(a), digest(b));
  const control = new RegrantRun(input('R0', 'p20-m1'));
  const other = new RegrantRun(input('R5', 'p20-m1'));
  assert.deepEqual(control.people, other.people);
  const one = control.runCycle();
  const two = other.runCycle();
  assert.deepEqual(one.draws, two.draws);
  // Nobody is exhausted before the first settlement: the first tapes are the same.
  assert.equal(digest(one.tape), digest(two.tape));
  assert.notEqual(digest(simulateRegrant(input('R2', 'p20-m1', 'V1', SEEDS[1]))), digest(a));
});

await test('cycle 1 of R0: the driver’s settlement equals Economy.settlements() for the drawn results', () => {
  for (const p of ['p20-m1', 'p100-m5']) {
    const run = new RegrantRun(input('R0', p));
    const { economy, draws, settled } = run.runCycle();
    const model = economy.settlements();
    for (const row of settled.markets) {
      const same = model.find((s) => s.result === row.result)!;
      const market = same.marketPnl.find((m) => m.market === row.market)!;
      assert.deepEqual(
        { paid: row.paid, recall: row.recall, pnl: row.pnl },
        { paid: market.paid, recall: market.recall, pnl: market.pnl },
      );
    }
    if (draws.results.length === 1) {
      const same = model.find((s) => s.result === draws.results[0])!;
      assert.equal(
        settled.wallets.reduce((sum, coin) => sum + coin - BUNDLE.startCoin, 0n),
        same.humanPnlCoin,
      );
      assert.equal(settled.botPnl, same.botPnlCoin);
      assert.equal(settled.recovered, same.treasuryRecoveredCoin);
    }
  }
});

await test('a full run keeps every new invariant; R1 grants at most twice in 60 cycles', () => {
  const summary = simulateRegrant(input('R1', 'p20-m1', 'V2'));
  assert.equal(summary.invariants.violations, 0);
  for (const name of Object.values(NEW_INVARIANTS))
    if (name !== NEW_INVARIANTS.boundary || summary.requests.boundaryRetries > 0)
      assert.ok(summary.invariants.new[name]! > 0, name);
  assert.ok(Math.max(...Object.keys(summary.recipients.grantCountHistogram).map(Number)) <= 2);
  assert.equal(summary.recipients.capReached, 0);
  assert.equal(summary.requests.refusals.live_orders, 0);
  const control = simulateRegrant(input('R0', 'p20-m1', 'V2'));
  assert.equal(control.issuance.regrantCoin, 0n);
  assert.deepEqual(
    Object.entries(control.requests.refusals)
      .filter(([, n]) => n > 0)
      .map(([r]) => r),
    control.requests.sent > 0 ? ['not_ready'] : [],
  );
});

const values: RegrantValues = candidate('R4').values!;
const facts = (changes: Partial<RegrantFacts> = {}): RegrantFacts => ({
  restricted: false,
  admin: false,
  held: false,
  startGrantedAt: 0,
  availableCoin: 0n,
  liveOrders: false,
  unsettledPositions: false,
  ...changes,
});
const row = (createdAt: number, requestId = `r-0000-${String(createdAt).padStart(9, '0')}`) =>
  ({
    id: createdAt,
    requestId,
    amountCoin: values.amountCoin,
    availableBeforeCoin: 0n,
    createdAt,
  }) satisfies RegrantRow;
const fails = (name: string, run: () => void) =>
  assert.throws(run, (error: Error) => error.message.startsWith(name), name);

await test('counterexamples: each new invariant fails when its condition is broken', () => {
  const inv = new Invariants();
  const now = 10 * 24 * HOUR_MS;
  checkMint(inv, values, facts(), [], now);
  fails(NEW_INVARIANTS.exhausted, () =>
    checkMint(inv, values, facts({ availableCoin: values.thresholdCoin + 1n }), [], now),
  );
  fails(NEW_INVARIANTS.noOrders, () =>
    checkMint(inv, values, facts({ liveOrders: true }), [], now),
  );
  fails(NEW_INVARIANTS.noOrders, () =>
    checkMint(inv, values, facts({ unsettledPositions: true }), [], now),
  );
  fails(NEW_INVARIANTS.wait, () => checkMint(inv, values, facts(), [row(now - 1)], now));
  fails(NEW_INVARIANTS.period, () =>
    checkMint(
      inv,
      values,
      facts(),
      [row(now - 3 * 24 * HOUR_MS), row(now - 2 * 24 * HOUR_MS)],
      now,
    ),
  );
  fails(NEW_INVARIANTS.cap, () =>
    checkMint(
      inv,
      values,
      facts(),
      Array.from({ length: 10 }, (_, i) => row(i * 30 * 24 * HOUR_MS - 400 * 24 * HOUR_MS)),
      now,
    ),
  );
  fails(NEW_INVARIANTS.once, () =>
    checkMintOnce(inv, [row(1, 'r-0001-000001'), row(2, 'r-0001-000001')]),
  );
  fails(NEW_INVARIANTS.issuance, () => checkIssuance(inv, 1000n, 999n));
  fails(NEW_INVARIANTS.pnl, () => checkPnlBasis(inv, [1100n], [0n], 1000n, -99n));
  checkPnlBasis(inv, [1100n], [200n], 1000n, 100n);
});

await test('counterexamples: a ledger that grants wrongly, twice, or not at its boundary is caught', () => {
  // Grants whatever the rule says: the decide() re-check before the mint fails.
  const greedy = new RegrantRun(input('R2', 'p20-m1'));
  for (const account of greedy.accounts) {
    const apply = account.apply.bind(account);
    account.apply = (id, v, f, now) => apply(id, v, { ...f, availableCoin: 0n }, now);
  }
  greedy.wallets[0] = 2000n;
  greedy.state[0]!.episode = { requestId: 'r-0000-000001', startedAt: 0, waiting: false };
  assert.throws(
    () => greedy.request(0, 4 * CYCLE_MS, 'first'),
    (error: Error) => error.message.startsWith(NEW_INVARIANTS.decide),
  );
  // Mints again for a granted id: the once check fails.
  const twice = new RegrantRun(input('R5', 'p20-m1'));
  const account = twice.accounts[0]!;
  const apply = account.apply.bind(account);
  account.apply = (id, v, f, now) => {
    const answer = apply(id, v, f, now);
    return answer.outcome === 'replayed' ? { outcome: 'granted', regrant: answer.regrant } : answer;
  };
  twice.wallets[0] = 0n;
  twice.state[0]!.episode = { requestId: 'r-0000-000001', startedAt: 0, waiting: false };
  assert.throws(
    () => twice.request(0, CYCLE_MS, 'first'),
    (error: Error) => error.message.startsWith(NEW_INVARIANTS.once),
  );
  // Refuses an immediate retry at its own waitUntil: the boundary check fails.
  const late = new RegrantRun(input('R2', 'p20-m1'));
  for (const a of late.accounts) {
    const original = a.apply.bind(a);
    a.apply = (id, v, f, now) => {
      if (now % CYCLE_MS === 0) return original(id, v, f, now);
      const status = decide(v, f, readHistory(a.rows, now, v), now);
      return {
        outcome: 'refused',
        status: { ...status, eligible: false, refusals: ['waiting'], waitUntil: now + 1 },
      };
    };
  }
  assert.throws(
    () => late.run(),
    (error: Error) => error.message.startsWith(NEW_INVARIANTS.boundary),
  );
});

await test('counterexamples: settlement and the carried-over audit fail on broken books', () => {
  const run = new RegrantRun(input('R0', 'p20-m1'));
  const { economy, draws } = run.runCycle();
  const inv = new Invariants();
  const base = economy.wallets.map(() => BUNDLE.startCoin);
  settleCycle(inv, economy, draws.results, base);
  economy.markets[0]!.collateral += 100n;
  fails(SETTLEMENT_INVARIANTS.collateral, () => settleCycle(inv, economy, draws.results, base));
  economy.markets[0]!.collateral -= 100n;
  fails(SETTLEMENT_INVARIANTS.zeroSum, () =>
    settleCycle(
      inv,
      economy,
      draws.results,
      base.map((coin, i) => (i === 0 ? coin + 1n : coin)),
    ),
  );
  // The existing audit() runs on the carried baseline: a Coin minted outside it is caught.
  const fresh = new Economy(BUNDLE, profile('p20-m1'), MARKET_CASE);
  carryOver(
    fresh,
    fresh.wallets.map((coin, i) => (i === 0 ? coin + 500n : coin)),
  );
  fresh.wallets[1]! += 1n;
  assert.throws(() => fresh.audit(), /Issued Coin equals/);
});
