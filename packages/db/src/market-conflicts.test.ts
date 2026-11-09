import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  marketConflictOf,
  declareMarketConflict,
  hasUnconflictedMarketAdmin,
  countFilledMarkets,
  assertNoMarketConflict,
} from './market-conflicts.js';
import { settleMarketPositions } from './market-settlement.js';
import {
  adminRoleChangeTimestamp,
  marketCreationTimestamp,
  latestAdminRevocation,
} from './role-boundary.js';
import { lockAdminRoles, lockMarket } from './tx-helpers.js';
import {
  adminActions,
  markets,
  marketConflictDeclarations,
  profiles,
  orders,
} from './schema/index.js';
import { createMarket, createUser } from './test/factories.js';
import { balanceOf, mintTestPairs, withLedgerGuardsOff } from './test/ledger.js';
import { createOrder, openOrderIntake, placeTestOrder } from './test/orders.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { waitForLockWaiter } from './test/wait.js';

describe.skipIf(!hasTestDb())('market conflicts and revocation boundaries (#143)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  it('keeps automatic fill conflicts after positions retire and excludes interested approvers', async () => {
    const market = await createMarket(t.db);
    const first = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    const other = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: first,
      noHolderId: other,
      qty: 1,
    });
    await t.db.update(profiles).set({ role: 'admin' }).where(eq(profiles.userId, first));
    await t.db
      .update(markets)
      .set({ status: 'settling', resolvedResult: 'YES' })
      .where(eq(markets.id, market.id));
    await t.db.transaction((tx) => settleMarketPositions(tx, market.id));
    expect(await marketConflictOf(t.db, market.id, first)).toMatchObject({
      hasFill: true,
      conflicted: true,
      declaration: null,
    });
    expect(await countFilledMarkets(t.db, first)).toBe(1);
    await expect(assertNoMarketConflict(t.db, market.id, [first])).rejects.toThrow(
      'interested administrator',
    );
    expect(await hasUnconflictedMarketAdmin(t.db, market.id, [market.createdBy])).toBe(false);
    const eligible = (await createUser(t.db, { role: 'admin' })).user.id;
    expect(await hasUnconflictedMarketAdmin(t.db, market.id, [market.createdBy])).toBe(true);
    expect((await marketConflictOf(t.db, market.id, eligible)).conflicted).toBe(false);
  });

  it('records a declaration and its audit once, keeps the original reason and forbids mutation', async () => {
    const market = await createMarket(t.db);
    const admin = market.createdBy;
    const declare = (reason: string) =>
      t.db.transaction(async (tx) => {
        await lockMarket(tx, market.id);
        await lockAdminRoles(tx, 'shared');
        const existing = (await marketConflictOf(tx, market.id, admin)).declaration;
        if (existing) return { declaration: existing, created: false };
        const at = new Date();
        const [action] = await tx
          .insert(adminActions)
          .values({
            adminId: admin,
            type: 'market_conflict_declare',
            targetType: 'market',
            targetId: market.id,
            payload: { reason },
            createdAt: at,
          })
          .returning();
        return declareMarketConflict(tx, {
          marketId: market.id,
          userId: admin,
          reason,
          adminActionId: action!.id,
          at,
        });
      });
    const first = await declare('가족이 사건 당사자입니다');
    expect(first.created).toBe(true);
    expect(await declare('사유를 바꾸지 않습니다')).toEqual({
      declaration: first.declaration,
      created: false,
    });
    expect((await marketConflictOf(t.db, market.id, admin)).conflicted).toBe(true);
    await expect(
      t.db
        .update(marketConflictDeclarations)
        .set({ reason: '변경' })
        .where(eq(marketConflictDeclarations.id, first.declaration.id)),
    ).rejects.toThrow();
    await expect(
      withLedgerGuardsOff((c) =>
        c.query('DELETE FROM market_conflict_declarations WHERE id=$1', [first.declaration.id]),
      ),
    ).rejects.toThrow('permanent');
  });

  it('uses historical revoke records, rejects timestamp equality and both IOC forms without changing assets', async () => {
    const admin = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId: admin });
    const person = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    const market = await createMarket(t.db);
    const boundary = market.createdAt;
    await t.db.insert(adminActions).values({
      adminId: admin,
      type: 'admin_revoke',
      targetType: 'user',
      targetId: person,
      payload: { reason: '옛 기록' },
      createdAt: boundary,
    });
    expect(await latestAdminRevocation(t.db, person)).toEqual(boundary);
    const before = await balanceOf(t.db, person);
    for (const input of [{}, { timeInForce: 'ioc' as const }, { qty: null, budgetCoin: 100n }]) {
      const result = await placeTestOrder(t.db, { marketId: market.id, ownerId: person, ...input });
      expect(result).toMatchObject({
        kind: 'placed',
        order: { status: 'rejected', rejectReason: 'admin_role_revoked', filledQty: 0 },
      });
    }
    expect(await balanceOf(t.db, person)).toEqual(before);
    await expect(createOrder(t.db, { marketId: market.id, userId: person })).rejects.toThrow();
    await t.db
      .update(markets)
      .set({ createdAt: new Date(boundary.getTime() + 1) })
      .where(eq(markets.id, market.id));
    expect(await placeTestOrder(t.db, { marketId: market.id, ownerId: person })).toMatchObject({
      kind: 'placed',
      order: { status: 'open' },
    });
  });

  it('makes new creation and revoke instants strictly ordered despite an earlier clock', async () => {
    const market = await createMarket(t.db);
    const ahead = new Date(Date.now() + 60000);
    await t.db.update(markets).set({ createdAt: ahead }).where(eq(markets.id, market.id));
    const earlier = new Date(0);
    const revokedAt = await t.db.transaction(async (tx) => {
      await lockAdminRoles(tx, 'exclusive');
      const at = await adminRoleChangeTimestamp(tx, 'admin_revoke', earlier);
      await tx.insert(adminActions).values({
        adminId: market.createdBy,
        type: 'admin_revoke',
        targetType: 'user',
        targetId: market.createdBy,
        payload: { reason: '경계' },
        createdAt: at,
      });
      return at;
    });
    expect(revokedAt.getTime()).toBe(ahead.getTime() + 1);
    const createdAt = await t.db.transaction((tx) => marketCreationTimestamp(tx, earlier));
    expect(createdAt.getTime()).toBe(revokedAt.getTime() + 1);
  });

  it('refuses a direct insert after it waits for an uncommitted admin grant (#143)', async () => {
    const market = await createMarket(t.db);
    const person = (await createUser(t.db)).user.id;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const granting = t.db.transaction(async (tx) => {
      await lockAdminRoles(tx, 'exclusive');
      await tx.update(profiles).set({ role: 'admin' }).where(eq(profiles.userId, person));
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    // The older admin guard reads the committed 'user' before this INSERT waits on the
    // profile. After the wait, the new guard must re-check the actual committed role.
    const inserting = createOrder(t.db, { marketId: market.id, userId: person }).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await waitForLockWaiter(t.db.$client, 'the raw order waits for the granting profile');
    } finally {
      release.resolve();
    }
    await granting;
    expect(await inserting).toBeInstanceOf(Error);
    expect(await t.db.select().from(orders).where(eq(orders.userId, person))).toEqual([]);
  });
});
