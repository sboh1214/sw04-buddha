import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OrderTerms } from '../../packages/shared/dist/index.js';
import {
  CANDIDATES,
  PROFILES,
  CASES,
  SEEDS,
  HORIZON_MS,
  coinBudget,
  createTape,
  validateCandidate,
} from './inputs.ts';
import { Economy, digest, simulate } from './model.ts';

const candidate = CANDIDATES[1]!;
const profile = PROFILES[0]!;
const scenario = CASES[0]!;
const terms = (
  outcome: 'YES' | 'NO',
  side: 'buy' | 'sell',
  qty: number,
  limit = 50,
  timeInForce: 'gtc' | 'ioc' = 'gtc',
): OrderTerms => ({ outcome, side, qty, limitPriceCoin: limit, timeInForce, budgetCoin: null });
function humanMarket(markets = 1) {
  const model = new Economy(candidate, { ...profile, markets }, scenario);
  for (const m of model.markets)
    model.execute({ id: `stop-${m.id}`, kind: 'bot-stop', at: 0, market: m.id }, new Map());
  return model;
}

await test('the full matrix independently crosses population and market count, validates all joint candidates', () => {
  assert.equal(CANDIDATES.length * PROFILES.length * CASES.length * SEEDS.length, 2016);
  for (const c of CANDIDATES) validateCandidate(c);
  assert.equal(new Set(PROFILES.map((p) => `${p.people}/${p.markets}`)).size, 9);
  assert.notEqual(SEEDS[0] % 2, SEEDS[1] % 2);
  assert.throws(() => validateCandidate({ ...candidate, maxLossCoin: candidate.budgetCoin + 1n }));
});
await test('the normalized tape is candidate-independent and deterministic; whales retain their once-granted S', () => {
  const split = CASES.find((c) => c.id === 'whale-20')!;
  const tape = createTape(profile, split, SEEDS[0]);
  assert.equal(digest(tape), digest(createTape(profile, split, SEEDS[0])));
  const whale = tape.filter((e) => e.kind === 'buy' && e.budgetBp === 10000);
  assert.equal(whale.length, 20);
  assert.equal(
    tape.some((e) => e.kind === 'buy' && e.actor === 0 && e.at < 61000),
    false,
  );
  for (const c of CANDIDATES)
    assert.equal(
      whale.reduce((sum, event) => sum + (event.kind === 'buy' ? coinBudget(c, event) : 0n), 0n),
      c.startCoin,
    );
});
await test('real shared matcher mints exactly 100 collateral, trades without minting, settles all outcomes once', () => {
  const model = humanMarket();
  const m = model.markets[0]!;
  model.order(m, 'H0', 'post', terms('YES', 'buy', 5));
  const paired = model.order(m, 'H1', 'pair', terms('NO', 'buy', 5, 50, 'ioc'));
  assert.equal(paired.filledQty, 5);
  assert.equal(m.collateral, 500n);
  model.order(m, 'H2', 'buyer', terms('YES', 'buy', 2, 60));
  const sold = model.order(m, 'H0', 'seller', terms('YES', 'sell', 2, 1, 'ioc'));
  assert.equal(sold.amountCoin, 120n);
  assert.equal(m.collateral, 500n);
  model.audit();
  model.execute({ id: 'close', kind: 'close', market: 0, at: HORIZON_MS }, new Map());
  const settled = model.settlements();
  assert.deepEqual(
    settled.map((s) => s.paidCoin),
    [500n, 500n, 500n],
  );
  assert.ok(settled.every((s) => s.retryUnchanged && s.botPnlCoin + s.humanPnlCoin === 0n));
});
await test('self trades spend nothing; a different actor still fills the existing human order', () => {
  const model = humanMarket();
  const m = model.markets[0]!;
  model.order(m, 'H0', 'post', terms('YES', 'buy', 3));
  const before = model.assetDigest();
  const self = model.order(m, 'H0', 'self', terms('NO', 'buy', 3, 50, 'ioc'));
  assert.equal(self.filledQty, 0);
  assert.equal(self.reason, 'self_trade');
  assert.equal(model.assetDigest(), before);
  assert.equal(model.order(m, 'H1', 'other', terms('NO', 'buy', 3, 50, 'ioc')).filledQty, 3);
  model.audit();
});
await test('one grant and all live reservations are shared across a human’s markets', () => {
  const model = humanMarket(2);
  const a = model.markets[0]!,
    b = model.markets[1]!;
  assert.equal(model.wallets[0], candidate.startCoin);
  model.order(a, 'H0', 'lock', terms('YES', 'buy', 20));
  const before = model.assetDigest();
  assert.equal(model.order(b, 'H0', 'over', terms('YES', 'buy', 1)).reason, 'insufficient_coin');
  assert.equal(model.assetDigest(), before);
  model.audit();
});
await test('accepted and rejected request replays mutate no assets; changed terms with the same ID fail', () => {
  const model = humanMarket();
  const m = model.markets[0]!;
  const input = terms('YES', 'buy', 2);
  const first = model.order(m, 'H0', 'same', input);
  const before = model.assetDigest();
  assert.deepEqual(model.order(m, 'H0', 'same', input), first);
  assert.equal(model.assetDigest(), before);
  assert.throws(() => model.order(m, 'H0', 'same', { ...input, qty: 3 }), /Same request ID/);
  const tooBig = terms('NO', 'buy', 100);
  const rejected = model.order(m, 'H0', 'rejected', tooBig);
  assert.equal(rejected.reason, 'insufficient_coin');
  assert.deepEqual(model.order(m, 'H0', 'rejected', tooBig), rejected);
  model.audit();
});
await test('an unchanged ladder preserves existing order IDs and priority', () => {
  const model = new Economy(candidate, profile, scenario);
  const m = model.markets[0]!;
  const before = digest(m.book);
  model.refresh(m);
  assert.equal(digest(m.book), before);
  model.audit();
});
await test('a changed target cancels whole affected remainders and reposts; adapter checks actual shared projection', () => {
  const model = new Economy(CANDIDATES[2]!, profile, scenario);
  const m = model.markets[0]!;
  const initial = new Map(m.book.map((row) => [row.id, row.remainingQty]));
  model.order(m, 'H0', 'take', terms('YES', 'buy', 3, 99, 'ioc'));
  const before = new Map(m.book.map((row) => [row.id, row.remainingQty]));
  model.refresh(m);
  model.audit();
  const cancelled = model.trace.filter((row) => row.kind === 'cancel' && row.reason === 'refresh');
  assert.ok(cancelled.length > 0);
  for (const row of cancelled) assert.equal(row.qty, before.get(String(row.id)));
  assert.ok(m.book.some((row) => !initial.has(row.id)));
});
await test('zero or sub-contract purchasing power is retained, never rounded up into a free contract', () => {
  const c = CANDIDATES[7]!;
  const model = new Economy(c, profile, scenario);
  const m = model.markets[0]!;
  const before = model.assetDigest();
  const result = model.order(m, 'H0', 'small', {
    outcome: 'YES',
    side: 'buy',
    timeInForce: 'ioc',
    limitPriceCoin: 99,
    qty: null,
    budgetCoin: 5n,
  });
  assert.equal(result.filledQty, 0);
  assert.equal(model.assetDigest(), before);
  model.audit();
});
await test('pause and close expire locks and refuse new fills; no-fill markets cancel', () => {
  const model = new Economy(candidate, profile, scenario);
  const m = model.markets[0]!;
  model.execute({ id: 'pause', kind: 'pause', market: 0, at: 1000 }, new Map());
  assert.equal(m.book.length, 0);
  assert.equal(model.order(m, 'H0', 'blocked', terms('YES', 'buy', 1)).reason, 'paused');
  model.execute({ id: 'close', kind: 'close', market: 0, at: HORIZON_MS }, new Map());
  assert.equal(m.status, 'cancelled');
  assert.equal(model.order(m, 'H0', 'late', terms('YES', 'buy', 1)).reason, 'closed');
  model.audit();
});
await test('paired MM holdings burn immediately and preserve every result PnL', () => {
  const model = new Economy(candidate, profile, scenario);
  const m = model.markets[0]!;
  model.order(m, 'H0', 'yes', terms('YES', 'buy', 2, 99, 'ioc'));
  model.order(m, 'H1', 'no', terms('NO', 'buy', 2, 99, 'ioc'));
  model.audit();
  assert.ok(m.stats.burnedQty > 0);
  assert.equal(Math.min(model.botBook(m).yesQty, model.botBook(m).noQty), 0);
});
await test('model invariant instrumentation detects corrupted Coin, collateral, and reservations', () => {
  const a = humanMarket();
  a.wallets[0]!++;
  assert.throws(() => a.audit(), /Issued Coin/);
  const b = humanMarket();
  b.markets[0]!.collateral++;
  assert.throws(() => b.audit(), /Collateral/);
  const c = humanMarket();
  c.order(c.markets[0]!, 'H0', 'post', terms('YES', 'buy', 2));
  c.wallets[0] = 0n;
  assert.throws(() => c.audit(), /Nonnegative human available/);
});
await test('fixed seeds reproduce traces, and refresh latency has an observable effect', () => {
  const fast = CASES.find((c) => c.id === 'stale-0')!,
    slow = CASES.find((c) => c.id === 'stale-5000')!;
  const a = simulate(candidate, profile, fast, 71);
  const b = simulate(candidate, profile, fast, 71);
  const c = simulate(candidate, profile, slow, 71);
  assert.equal(a.summary.traceDigest, b.summary.traceDigest);
  assert.equal(a.summary.inputDigest, c.summary.inputDigest);
  assert.notEqual(a.summary.traceDigest, c.summary.traceDigest);
  assert.ok(a.summary.replayChecks > 0);
  assert.equal(a.summary.invariantViolations, 0);
});
await test('all eight candidates run every scenario family through real matcher/accounting functions', () => {
  const cases = [...new Map(CASES.map((c) => [c.scenario, c])).values()];
  for (const c of CANDIDATES)
    for (const scenario of cases) {
      const result = simulate(c, profile, scenario, 71);
      assert.equal(result.summary.invariantViolations, 0);
      assert.equal(result.summary.settlements.length, 3);
    }
});
