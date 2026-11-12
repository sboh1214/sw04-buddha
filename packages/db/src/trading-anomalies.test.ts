import { TRADING_ANOMALY_SETTINGS, tradingAnomalyReportSchema } from '@buddha/shared';
import type * as Shared from '@buddha/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTradingAnomalies } from './trading-anomalies.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  closeAccount,
  createMarket,
  createMarketMakerAccount,
  createUser,
  setReleaseSetting,
} from './test/factories.js';
import { createFillRecord, type CreateFillRecordInput } from './test/orders.js';
import { adminActions, balances, fills, ledgerEntries, orders } from './schema/index.js';

// Exercise production LIMIT+1/truncation paths with small technical bounds, never fake fills.
vi.mock('@buddha/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof Shared>()),
  TRADING_ANOMALY_SCAN_LIMIT: 10,
  TRADING_ANOMALY_CANDIDATE_LIMIT: 2,
  TRADING_ANOMALY_EVIDENCE_LIMIT: 2,
}));
const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;
describe.skipIf(!hasTestDb())('private trading anomaly report (#98)', () => {
  let t: TestDb;
  let adminId: string;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    adminId = (await createUser(t.db, { role: 'admin' })).user.id;
  });
  const read = (marketId?: string) =>
    t.db.transaction((tx) => readTradingAnomalies(tx, { marketId }), READ_ONLY);
  async function settings(
    overrides: Partial<Record<keyof typeof TRADING_ANOMALY_SETTINGS, number>> = {},
  ) {
    for (const [key, def] of Object.entries(TRADING_ANOMALY_SETTINGS))
      await setReleaseSetting(t.db, {
        adminId,
        key: def.key,
        status: 'test',
        value:
          overrides[key as keyof typeof overrides] ??
          (key.endsWith('Count') ? 2 : key.endsWith('Window') ? 10 : 60),
      });
  }
  async function people() {
    return [(await createUser(t.db)).user.id, (await createUser(t.db)).user.id] as const;
  }
  const fill = (input: CreateFillRecordInput) => createFillRecord(t.db, input);
  async function facts() {
    return {
      audit: await t.db.select().from(adminActions),
      balances: await t.db.select().from(balances),
      ledger: await t.db.select().from(ledgerEntries),
      orders: await t.db.select().from(orders),
      fills: await t.db.select().from(fills),
    };
  }

  it('keeps missing settings different from a configured empty result, without writes', async () => {
    const before = await facts();
    const result = await read();
    expect(result.signals.map((row) => row.status)).toEqual(['undecided', 'undecided']);
    expect(result.source.complete).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(tradingAnomalyReportSchema.parse(result)).toEqual(result);
    expect(await facts()).toEqual(before);
    await settings();
    const ready = await read();
    expect(ready.signals.map((row) => row.status)).toEqual(['ready', 'ready']);
    expect(ready.source.complete).toBe(true);
    expect(ready.candidates).toEqual([]);
  });
  it('marks inconsistent duration settings invalid and still computes the other ready signal', async () => {
    await settings({ pairWindow: 61, pairLookback: 60 });
    const result = await read();
    expect(result.signals.map((row) => row.status)).toEqual(['invalid', 'ready']);
    expect(result.source.complete).toBe(false);
  });
  it('canonicalizes a human pair across incoming directions and uses inclusive window boundaries', async () => {
    await settings({ pairWindow: 1 });
    const market = await createMarket(t.db);
    const [a, b] = await people();
    const at = Date.now() - 3000;
    await fill({
      marketId: market.id,
      incomingOwnerId: a,
      restingOwnerId: b,
      createdAt: new Date(at),
    });
    await fill({
      marketId: market.id,
      incomingOwnerId: b,
      restingOwnerId: a,
      outcome: 'NO',
      priceCoin: 63,
      createdAt: new Date(at + 1000),
    });
    await fill({
      marketId: market.id,
      incomingOwnerId: a,
      restingOwnerId: b,
      createdAt: new Date(at + 2001),
    });
    const before = await facts();
    const report = await read(market.id);
    const candidate = report.candidates.find((row) => row.kind === 'human_pair')!;
    expect(candidate.count).toBe('2');
    expect(candidate.actors.map((row) => row.userId)).toEqual([a, b].sort());
    expect(candidate.evidence[1]?.second).toMatchObject({
      side: 'buy',
      outcome: 'YES',
      priceCoin: 37,
    });
    expect(report.candidates.some((row) => row.kind === 'round_trip')).toBe(false);
    expect(await facts()).toEqual(before);
  });
  it('excludes MM-only repetition but includes the human’s round trips against the MM', async () => {
    await settings();
    const market = await createMarket(t.db);
    const [human] = await people();
    const mm = await createMarketMakerAccount(t.db);
    const at = Date.now() - 4000;
    for (let i = 0; i < 4; i++)
      await fill({
        marketId: market.id,
        incomingOwnerId: human,
        restingOwnerId: mm,
        side: i % 2 === 0 ? 'buy' : 'sell',
        kind: 'trade',
        createdAt: new Date(at + i * 500),
      });
    const report = await read();
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({
      kind: 'round_trip',
      count: '2',
      quantity: '2',
      outcome: 'YES',
      actors: [{ userId: human }],
    });
    expect(JSON.stringify(report)).not.toContain(mm);
  });
  it('interprets pair-mint resting as an opposite-outcome buy before a later sale', async () => {
    await settings({ roundTripCount: 1, pairCount: 9 });
    const market = await createMarket(t.db);
    const [a, b] = await people();
    const at = Date.now() - 2000;
    const bought = await fill({
      marketId: market.id,
      incomingOwnerId: a,
      restingOwnerId: b,
      outcome: 'NO',
      kind: 'pair_mint',
      priceCoin: 63,
      qty: 4,
      createdAt: new Date(at),
    });
    const sold = await fill({
      marketId: market.id,
      incomingOwnerId: b,
      restingOwnerId: a,
      outcome: 'YES',
      side: 'sell',
      kind: 'trade',
      priceCoin: 44,
      qty: 2,
      createdAt: new Date(at + 500),
    });
    const report = await read();
    const candidate = report.candidates.find((row) => row.actors[0]?.userId === b)!;
    expect(candidate).toMatchObject({ count: '1', quantity: '2', outcome: 'YES' });
    expect(candidate.evidence[0]).toMatchObject({
      first: { fillId: String(bought.fill.id), side: 'buy', priceCoin: 37, qty: '4' },
      second: { fillId: String(sold.fill.id), side: 'sell', priceCoin: 44, qty: '2' },
      matchedQty: '2',
    });
  });
  it('matches FIFO quantities once per distinct fill pair, and permits sell then buy too', async () => {
    await settings({ pairCount: 99, roundTripCount: 2 });
    const market = await createMarket(t.db);
    const [a, b] = await people();
    const at = Date.now() - 4000;
    for (const [i, side, qty] of [
      [0, 'sell', 4],
      [1, 'buy', 1],
      [2, 'buy', 2],
    ] as const)
      await fill({
        marketId: market.id,
        incomingOwnerId: a,
        restingOwnerId: b,
        side,
        kind: 'trade',
        qty,
        createdAt: new Date(at + i * 500),
      });
    const report = await read();
    const candidate = report.candidates.find((row) => row.actors[0]?.userId === a)!;
    expect(candidate).toMatchObject({ count: '2', quantity: '3' });
    expect(
      new Set(candidate.evidence.map((row) => `${row.first.fillId}/${row.second.fillId}`)).size,
    ).toBe(2);
  });
  it('separates market/outcome, excludes old and future fills, and keeps closed people’s history', async () => {
    await settings({ pairCount: 99, roundTripCount: 1, roundTripWindow: 1 });
    const market = await createMarket(t.db),
      other = await createMarket(t.db);
    const [a, b] = await people();
    const at = Date.now() - 4000;
    await fill({
      marketId: market.id,
      incomingOwnerId: a,
      restingOwnerId: b,
      side: 'buy',
      kind: 'trade',
      createdAt: new Date(at),
    });
    await fill({
      marketId: other.id,
      incomingOwnerId: a,
      restingOwnerId: b,
      side: 'sell',
      kind: 'trade',
      createdAt: new Date(at + 500),
    });
    await fill({
      marketId: market.id,
      incomingOwnerId: a,
      restingOwnerId: b,
      side: 'sell',
      outcome: 'NO',
      kind: 'trade',
      createdAt: new Date(at + 500),
    });
    await fill({
      marketId: market.id,
      incomingOwnerId: a,
      restingOwnerId: b,
      side: 'sell',
      kind: 'trade',
      createdAt: new Date(at + 1001),
    });
    expect((await read(market.id)).candidates).toEqual([]);
    await fill({
      marketId: market.id,
      incomingOwnerId: a,
      restingOwnerId: b,
      side: 'buy',
      kind: 'trade',
      createdAt: new Date(at + 1500),
    });
    await closeAccount(t.db, a);
    const report = await read(market.id);
    expect(report.candidates.find((row) => row.actors[0]?.userId === a)?.actors).toEqual([
      { userId: a, nickname: null },
    ]);
    const old = await fill({
      marketId: other.id,
      incomingOwnerId: b,
      restingOwnerId: (await createUser(t.db)).user.id,
      createdAt: new Date(Date.now() - 120_000),
    });
    const future = await fill({
      marketId: other.id,
      incomingOwnerId: b,
      restingOwnerId: (await createUser(t.db)).user.id,
      createdAt: new Date(Date.now() + 60_000),
    });
    expect(JSON.stringify(await read())).not.toContain(`"fillId":"${old.fill.id}"`);
    expect(JSON.stringify(await read())).not.toContain(`"fillId":"${future.fill.id}"`);
  });
  it('reports source, candidate and evidence truncation without claiming all evidence or zero candidates', async () => {
    await settings({ pairCount: 2, roundTripCount: 99 });
    const market = await createMarket(t.db);
    const at = Date.now() - 4000;
    for (let group = 0; group < 3; group++) {
      const [a, b] = await people();
      for (let i = 0; i < 3; i++)
        await fill({
          marketId: market.id,
          incomingOwnerId: a,
          restingOwnerId: b,
          createdAt: new Date(at + group * 500 + i),
        });
    }
    const report = await read();
    expect(report.source.complete).toBe(true);
    expect(report.signals[0]).toMatchObject({ observedCandidates: '3', candidatesTruncated: true });
    expect(report.candidates).toHaveLength(2);
    expect(
      report.candidates.every(
        (row) => row.evidenceTruncated && row.evidenceTotal === '3' && row.evidence.length === 2,
      ),
    ).toBe(true);
    const [a, b] = await people();
    for (let i = 0; i < 3; i++)
      await fill({ marketId: market.id, incomingOwnerId: a, restingOwnerId: b });
    await settings({ pairCount: 100 });
    const partial = await read();
    expect(partial.source).toMatchObject({ scannedFills: 10, truncated: true, complete: false });
    expect(partial.candidates).toEqual([]);
  });
  it('keeps a report snapshot fixed while another transaction adds fills and changes settings', async () => {
    await settings();
    const market = await createMarket(t.db);
    const [a, b] = await people();
    await fill({ marketId: market.id, incomingOwnerId: a, restingOwnerId: b });
    await t.db.transaction(async (tx) => {
      const first = await readTradingAnomalies(tx, {});
      await fill({ marketId: market.id, incomingOwnerId: b, restingOwnerId: a });
      await setReleaseSetting(t.db, {
        adminId,
        key: TRADING_ANOMALY_SETTINGS.pairCount.key,
        status: 'test',
        value: 3,
      });
      const second = await readTradingAnomalies(tx, {});
      expect(second.source.scannedFills).toBe(first.source.scannedFills);
      expect(second.signals[0]?.settings.count.value).toBe(2);
    }, READ_ONLY);
    const next = await read();
    expect(next.source.scannedFills).toBe(2);
    expect(next.signals[0]?.settings.count.value).toBe(3);
  });
});
