import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { REGRANT_REFUSALS } from '../../packages/shared/dist/index.js';
import {
  DAY_MS,
  HOUR_MS,
  RegrantAccount,
  decide,
  readHistory,
  type RegrantFacts,
  type RegrantRow,
  type RegrantValues,
} from './rule.ts';

/*
 * rule.ts against #74 (packages/db/src/regrants.ts, ADR-0155): the mirrored source is pinned, and
 * the boundary cases of packages/db/src/regrants.test.ts are replayed as a table on the pure rule.
 */

const source = readFileSync(new URL('../../packages/db/src/regrants.ts', import.meta.url), 'utf8');
const block = (start: string) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `${start} is in #74`);
  const to = source.indexOf('\n}\n', from);
  return source.slice(from, to + 2);
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

await test('#74 decide(), readHistory() and applyRegrant()’s request-id handling are the source rule.ts mirrors (re-check rule.ts if this fails)', () => {
  assert.equal(
    sha(block('function decide(')),
    '4d464447b00dbddba6f51bb60c3fc27d2fef43f4581989ae44d9cabc49a8d138',
  );
  assert.equal(
    sha(block('async function readHistory(')),
    '0b7ac41a679348dc6fe645a6ff85e010cd836b368565b20a5b481884b6fdaab3',
  );
  // RegrantAccount.apply: the id's parse and RangeError, the per-account replay before any
  // condition, a refusal writing nothing — applyRegrant() up to its mint, and regrantByRequest().
  const from = source.indexOf('export async function applyRegrant(');
  const to = source.indexOf('  const id = randomUUID();', from);
  assert.ok(from >= 0 && to > from, 'applyRegrant() and its mint are in #74');
  assert.equal(
    sha(source.slice(from, to)),
    '7eed3c6f717a19fa645e9251454338a238f46d5758b36fb733b50049b757a376',
  );
  assert.equal(
    sha(block('async function regrantByRequest(')),
    'b719b85382f58f68698ea11a7c9118ba30788f632048e7a17bd2563b3334419f',
  );
});

/** #74's test defaults: a fresh 100-Coin member is exhausted; no wait; room to spare. */
const DEFAULTS: RegrantValues = {
  thresholdCoin: 100n,
  amountCoin: 500n,
  waitHours: 0,
  periodDays: 30,
  periodLimit: 3,
  totalCapCoin: 10_000n,
};
const START = Date.UTC(2026, 10, 1);
const member = (availableCoin = 100n): RegrantFacts => ({
  restricted: false,
  admin: false,
  held: false,
  startGrantedAt: START,
  availableCoin,
  liveOrders: false,
  unsettledPositions: false,
});
let ids = 0;
const fresh = () => `request-${String(++ids).padStart(6, '0')}`;
const values = (changes: Partial<RegrantValues> = {}) => ({ ...DEFAULTS, ...changes });
const status = (
  v: RegrantValues | null,
  facts: RegrantFacts,
  now: number,
  rows: readonly RegrantRow[] = [],
) => decide(v, facts, readHistory(rows, now, v), now);

await test('counts available Coin at the threshold as exhausted, and one Coin more as not', () => {
  const now = START + HOUR_MS;
  assert.deepEqual(status(values({ thresholdCoin: 100n }), member(100n), now).refusals, []);
  const above = status(values({ thresholdCoin: 100n }), member(101n), now);
  assert.deepEqual(above.refusals, ['not_exhausted']);
  assert.equal(above.thresholdCoin, 100n);
  assert.deepEqual(status(values({ thresholdCoin: 0n }), member(1n), now).refusals, [
    'not_exhausted',
  ]);
  assert.deepEqual(status(values({ thresholdCoin: 0n }), member(0n), now).refusals, []);
});

await test('replays a granted request id before any condition; refused ids leave nothing', () => {
  const account = new RegrantAccount();
  const id = fresh();
  const first = account.apply(id, values(), member(), START);
  assert.equal(first.outcome, 'granted');
  // Not exhausted any more, and even with the settings undecided: the same id reads it back.
  assert.deepEqual(account.apply(id, values(), member(600n), START), {
    outcome: 'replayed',
    regrant: account.rows[0],
  });
  assert.equal(account.apply(id, null, member(600n), START).outcome, 'replayed');
  assert.equal(account.rows.length, 1);
  // Another account's same id grants its own.
  const other = new RegrantAccount();
  assert.equal(other.apply(id, values(), member(), START).outcome, 'granted');
  // A refused id records nothing and applies afresh later.
  const refusedId = fresh();
  const refused = account.apply(refusedId, values(), member(600n), START);
  assert.equal(refused.outcome, 'refused');
  assert.equal(account.rows.length, 1);
  assert.equal(account.apply(refusedId, values(), member(100n), START).outcome, 'granted');
});

await test('takes only a request id as the header carries it', () => {
  const account = new RegrantAccount();
  for (const id of ['', 'short', ' padded-request-id ', 'has space in it', 'é'.repeat(9)])
    assert.throws(() => account.apply(id, values(), member(), START), RangeError, id);
  assert.equal(account.rows.length, 0);
  assert.equal(account.apply('r-0003-000001', values(), member(), START).outcome, 'granted');
  assert.equal(account.apply('a'.repeat(128), values(), member(), START).outcome, 'granted');
  assert.throws(() => account.apply('a'.repeat(129), values(), member(), START), RangeError);
  // IDEMPOTENCY_KEY_MIN_LENGTH: 7 characters throw, 8 pass (a fresh id, not a replay).
  assert.throws(() => account.apply('c'.repeat(7), values(), member(), START), RangeError);
  assert.equal(account.apply('b'.repeat(8), values(), member(), START).outcome, 'granted');
  assert.equal(account.rows.length, 3);
});

await test('refuses everything while any setting is undecided (준비 중), with no numbers', () => {
  const closed = status(null, member(), START);
  assert.deepEqual(closed, {
    open: false,
    eligible: false,
    refusals: ['not_ready'],
    amountCoin: null,
    thresholdCoin: null,
    waitHours: null,
    waitUntil: null,
    periodDays: null,
    periodLimit: null,
    periodUsed: null,
    nextPeriodAt: null,
    totalCapCoin: null,
    totalGrantedCoin: null,
    remainingCapCoin: null,
  });
  assert.deepEqual(status(null, { ...member(), startGrantedAt: null }, START).refusals, [
    'not_ready',
    'no_start_grant',
  ]);
  assert.deepEqual(status(null, { ...member(), admin: true }, START).refusals, [
    'not_ready',
    'admin',
  ]);
  assert.equal(readHistory([], START, null), null);
});

await test('refuses an account whose start grant was not paid, with the numbers', () => {
  assert.deepEqual(status(values(), { ...member(), startGrantedAt: null }, START), {
    open: true,
    eligible: false,
    refusals: ['no_start_grant'],
    amountCoin: 500n,
    thresholdCoin: 100n,
    waitHours: 0,
    waitUntil: null,
    periodDays: 30,
    periodLimit: 3,
    periodUsed: 0,
    nextPeriodAt: null,
    totalCapCoin: 10_000n,
    totalGrantedCoin: 0n,
    remainingCapCoin: 10_000n,
  });
});

await test('refuses with a waiting order, and with a contract of a market not settled', () => {
  assert.deepEqual(status(values(), { ...member(), liveOrders: true }, START).refusals, [
    'live_orders',
  ]);
  assert.deepEqual(status(values(), { ...member(), unsettledPositions: true }, START).refusals, [
    'unsettled_positions',
  ]);
});

await test('refuses under a restriction, for the admin role, and under a reconciliation hold', () => {
  assert.deepEqual(status(values(), { ...member(), restricted: true }, START).refusals, [
    'restricted',
  ]);
  assert.deepEqual(status(values(), { ...member(), admin: true }, START).refusals, ['admin']);
  assert.deepEqual(status(values(), { ...member(), held: true }, START).refusals, ['held']);
});

await test('counts the wait from the start grant, then from the last re-grant; the boundary passes', () => {
  const v = values({ waitHours: 1 });
  const early = status(v, member(), START + HOUR_MS - 1);
  assert.deepEqual(early.refusals, ['waiting']);
  assert.equal(early.waitUntil, START + HOUR_MS);
  assert.deepEqual(status(v, member(), START + HOUR_MS).refusals, []);
  const account = new RegrantAccount();
  const at = START + 5 * HOUR_MS;
  assert.equal(account.apply(fresh(), v, member(), at).outcome, 'granted');
  const two = values({ waitHours: 2 });
  const waiting = status(two, member(), at + HOUR_MS, account.rows);
  assert.deepEqual(waiting.refusals, ['waiting']);
  assert.equal(waiting.waitUntil, at + 2 * HOUR_MS);
  assert.equal(
    account.apply(fresh(), two, member(), at + 2 * HOUR_MS).outcome,
    'granted',
    'exactly at waitUntil',
  );
});

await test('allows the period’s limit, says when the oldest frees one, and the window is strict', () => {
  const v = values({ thresholdCoin: 10_000n, periodLimit: 2, periodDays: 30 });
  const account = new RegrantAccount();
  const first = START + DAY_MS;
  assert.equal(account.apply(fresh(), v, member(), first).outcome, 'granted');
  assert.equal(account.apply(fresh(), v, member(), first + DAY_MS).outcome, 'granted');
  const now = first + 2 * DAY_MS;
  const full = status(v, member(), now, account.rows);
  assert.deepEqual(full.refusals, ['period_limit']);
  assert.equal(full.periodUsed, 2);
  assert.equal(full.nextPeriodAt, first + 30 * DAY_MS);
  // The limit lowered to 1: the second-oldest has to leave too.
  const lowered = status({ ...v, periodLimit: 1 }, member(), now, account.rows);
  assert.equal(lowered.nextPeriodAt, first + DAY_MS + 30 * DAY_MS);
  // A higher limit frees it; nextPeriodAt says nothing while one is free.
  const higher = status({ ...v, periodLimit: 3 }, member(), now, account.rows);
  assert.equal(higher.eligible, true);
  assert.equal(higher.nextPeriodAt, null);
  // created_at > now − period: one exactly a period old has left (RG readHistory).
  assert.equal(readHistory(account.rows, first + 30 * DAY_MS, v)!.periodUsed, 1);
  assert.equal(readHistory(account.rows, first + 30 * DAY_MS - 1, v)!.periodUsed, 2);
  assert.equal(account.apply(fresh(), v, member(), first + 30 * DAY_MS).outcome, 'granted');
});

await test('never grants past the lifetime cap, nor the part that would fit; exactly the cap passes', () => {
  const v = values({ thresholdCoin: 10_000n, totalCapCoin: 1_200n, periodLimit: 10 });
  const account = new RegrantAccount();
  account.apply(fresh(), v, member(), START);
  account.apply(fresh(), v, member(), START);
  const capped = account.apply(fresh(), v, member(), START);
  assert.equal(capped.outcome, 'refused');
  assert.ok(capped.outcome === 'refused');
  assert.deepEqual(capped.status.refusals, ['total_cap']);
  assert.equal(capped.status.totalGrantedCoin, 1_000n);
  assert.equal(capped.status.remainingCapCoin, 200n);
  const lowered = status({ ...v, totalCapCoin: 600n }, member(), START, account.rows);
  assert.deepEqual(lowered.refusals, ['total_cap']);
  assert.equal(lowered.remainingCapCoin, 0n);
  const exact = { ...v, totalCapCoin: 1_500n };
  assert.equal(account.apply(fresh(), exact, member(), START).outcome, 'granted');
  assert.deepEqual(status(exact, member(), START, account.rows).refusals, ['total_cap']);
});

await test('names every reason that applies, in REGRANT_REFUSALS’ order', () => {
  const v = values({ thresholdCoin: 10_000n, periodLimit: 2, totalCapCoin: 1_000n });
  const account = new RegrantAccount();
  account.apply(fresh(), v, member(), START);
  account.apply(fresh(), v, member(), START);
  const all = status(
    values({ thresholdCoin: 100n, periodLimit: 2, totalCapCoin: 1_000n, waitHours: 1 }),
    {
      restricted: true,
      admin: true,
      held: true,
      startGrantedAt: START,
      availableCoin: 101n,
      liveOrders: true,
      unsettledPositions: true,
    },
    START,
    account.rows,
  );
  assert.deepEqual(all.refusals, [
    'restricted',
    'admin',
    'held',
    'not_exhausted',
    'live_orders',
    'unsettled_positions',
    'waiting',
    'period_limit',
    'total_cap',
  ]);
  assert.deepEqual(
    all.refusals,
    REGRANT_REFUSALS.filter((reason) => all.refusals.includes(reason)),
  );
  assert.equal(all.periodUsed, 2);
  // An account with no ledger account (available null) is not refused for exhaustion.
  assert.deepEqual(status(values(), { ...member(), availableCoin: null }, START).refusals, []);
});
