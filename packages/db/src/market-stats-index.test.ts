import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, createDb } from './client.js';
import { newHumanParticipants } from './market-stats.js';
import { createMarket, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { createFillRecord, createFillSeries } from './test/orders.js';
import { lockMarket } from './tx-helpers.js';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}
const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];

describe.skipIf(!hasTestDb())('participant lookup indexes (#132)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('bounds both owner-side probes to this market despite substantial cross-market history', async () => {
    await t.reset();
    const local = await createMarket(t.db);
    const owners = await Promise.all(Array.from({ length: 4 }, () => createUser(t.db)));
    const [a, b, c, d] = owners.map((row) => row.user.id) as [string, string, string, string];
    const first = Date.now() - 60_000;
    const points = Array.from({ length: 2_000 }, (_, i) => ({
      at: new Date(first + i),
      yesPriceCoin: 50,
    }));
    // Real immutable fills/orders through the existing read fixture, without trigger bypass.
    // There are no a/b fills in local. Each owner has history on BOTH sides in other markets.
    // This exercises the expensive negative lookup while market/asset locks would be held.
    await createFillSeries(t.db, {
      marketId: local.id,
      incomingOwnerId: c,
      restingOwnerId: d,
      points,
    });
    for (let i = 0; i < 3; i += 1) {
      const other = await createMarket(t.db);
      for (const [incomingOwnerId, restingOwnerId] of [
        [a, b],
        [b, a],
      ] as const)
        await createFillSeries(t.db, {
          marketId: other.id,
          incomingOwnerId,
          restingOwnerId,
          points,
        });
    }
    const owner = createDb(testDbUrls()!.migrateUrl, { max: 1 });
    try {
      await owner.execute(sql`ANALYZE fills`);
    } finally {
      await closeDb(owner);
    }

    await t.db.transaction(async (tx) => {
      await lockMarket(tx, local.id);
      // Explain the production function's exact SQL, with normal planner settings; do not
      // duplicate its EXISTS/filter expression or force a particular scan on an empty table.
      const executed = vi.spyOn(tx, 'execute');
      let statement;
      try {
        expect(await newHumanParticipants(tx, local.id, [a, b])).toBe(2);
        statement = executed.mock.calls[0]![0];
      } finally {
        executed.mockRestore();
      }
      const { rows } = await tx.execute<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
      );
      const plan = rows[0]!['QUERY PLAN'][0]!.Plan;
      const scans = planNodes(plan).filter((node) => node['Relation Name'] === 'fills');
      for (const side of ['incoming', 'resting']) {
        const probe = scans.find(
          (node) => node['Index Name'] === `fills_market_id_${side}_owner_id_idx`,
        );
        expect(probe, JSON.stringify(plan)).toBeDefined();
        expect(probe!['Index Cond']).toContain('market_id');
        expect(probe!['Index Cond']).toContain(`${side}_owner_id`);
        expect(probe!['Rows Removed by Filter'] ?? 0).toBe(0);
      }
      expect(await newHumanParticipants(tx, local.id, [c, d, c])).toBe(0);
    });
    // A new normal local fill makes both owners participants, regardless of which side they
    // had used elsewhere. Classification/exclusion and re-entry remain covered separately.
    await createFillRecord(t.db, {
      marketId: local.id,
      incomingOwnerId: a,
      restingOwnerId: b,
    });
    await t.db.transaction(async (tx) => {
      await lockMarket(tx, local.id);
      expect(await newHumanParticipants(tx, local.id, [a, b])).toBe(0);
    });
  }, 60_000);
});
