import {
  findLedgerAccount,
  RECONCILIATION_NOTICES_FAILED_LOG,
  schema,
  setNotificationCategory,
  type Db,
} from '@buddha/db';
import {
  connectTestDb,
  createMarket,
  createUser,
  createWatch,
  fundMarketMakerFunds,
  hasTestDb,
  mintTestPairs,
  openOrderIntake,
  placeTestOrder,
  withLedgerGuardsOff,
  type TestDb,
} from '@buddha/db/test';
import {
  marketChannel,
  userChannel,
  type MarketRealtimeEvent,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { pino, type Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Publish } from '../realtime.js';
import {
  reconcileDueMarkets,
  reconcileLedger,
  reconcileTarget,
  reconciliationBatchSummary,
} from './reconciliation.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

describe.skipIf(!hasTestDb())('reconciliation jobs (#93, integration)', () => {
  let t: TestDb;
  let published: { channel: string; event: MarketRealtimeEvent | UserRealtimeEvent }[];
  let publish: Publish;
  let logs: Record<string, unknown>[];
  /** Every level: a run logs nothing but #54's fixed line when its notices fail (54-6). */
  let logger: Logger;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    published = [];
    publish = (channel, event) => {
      published.push({ channel, event });
      return Promise.resolve();
    };
    logs = [];
    logger = pino(
      { level: 'debug' },
      { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
    );
  });

  async function damagedMarket() {
    const market = await createMarket(t.db, { status: 'open' });
    const yes = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const no = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: yes,
      noHolderId: no,
      qty: 2,
      yesPriceCoin: 60,
    });
    const collateral = await findLedgerAccount(t.db, {
      kind: 'market_collateral',
      marketId: market.id,
    });
    await withLedgerGuardsOff((client) =>
      client.query(
        'UPDATE balances SET available_coin = available_coin + 1 WHERE account_id = $1',
        [collateral!.id],
      ),
    );
    return { market, yes, no, collateralId: collateral!.id };
  }

  it('checks every unexamined market, skips unchanged clean markets and follows new ledger events', async () => {
    const first = await createMarket(t.db, { status: 'open' });
    await createMarket(t.db, { status: 'draft' });
    expect(await reconcileDueMarkets(t.db, publish, logger)).toMatchObject({
      checked: 2,
      passed: 2,
      mismatched: 0,
      failed: 0,
      scopes: { market: 2, account: 0, supply: 0 },
    });
    expect((await reconcileDueMarkets(t.db, publish, logger)).checked).toBe(0);
    await fundMarketMakerFunds(t.db, first.id, 100n);
    expect(await reconcileDueMarkets(t.db, publish, logger)).toMatchObject({
      checked: 1,
      passed: 1,
      failed: 0,
    });
    expect(published).toEqual([]);
  });

  it('commits a system pause before publishing, preserves orders and retries failed facts without new events', async () => {
    const { market, yes, no } = await damagedMarket();
    const adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
    const placed = await placeTestOrder(t.db, {
      ownerId: yes,
      marketId: market.id,
      outcome: 'YES',
      side: 'buy',
      qty: 1,
      limitPriceCoin: 30,
    });
    if (placed.kind !== 'placed') throw new Error('resting order required');
    const beforeOrder = placed.order;
    const [beforeBalance] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, yes));
    const afterCommit: Publish = async (channel, event) => {
      const [stored] = await t.db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, market.id));
      expect(stored?.status).toBe('paused');
      expect(await t.db.select().from(schema.reconciliationHolds)).toHaveLength(1);
      await publish(channel, event);
    };
    const first = await reconcileDueMarkets(t.db, afterCommit, logger);
    expect(first).toMatchObject({ checked: 1, mismatched: 1, held: 1, paused: 1, failed: 0 });
    expect(published[0]).toEqual({
      channel: marketChannel(market.id),
      event: expect.objectContaining({
        type: 'market:status',
        marketId: market.id,
        status: 'paused',
      }) as unknown,
    });
    // Then the inbox signal of its two holders' `market_paused` (#54 B′; the tests below).
    expect(
      published
        .slice(1)
        .map(({ channel }) => channel)
        .sort(),
    ).toEqual([yes, no].map((id) => userChannel(id)).sort());
    expect((await t.db.select().from(schema.marketPauses))[0]).toMatchObject({
      pausedBy: null,
      reason: 'ledger_failure',
    });
    expect(
      (await t.db.select().from(schema.orders).where(eq(schema.orders.id, beforeOrder.id)))[0],
    ).toEqual(beforeOrder);
    expect(
      (await t.db.select().from(schema.balances).where(eq(schema.balances.userId, yes)))[0],
    ).toEqual(beforeBalance);
    const again = await reconcileDueMarkets(t.db, publish, logger);
    expect(again).toMatchObject({ checked: 1, mismatched: 1, held: 1, paused: 0, failed: 0 });
    expect(await t.db.select().from(schema.reconciliationResults)).toHaveLength(2);
    expect(await t.db.select().from(schema.reconciliationHolds)).toHaveLength(1);
    expect(published).toHaveLength(3);
  });

  it('a clean manual recheck records success without releasing the hold or resuming the market', async () => {
    const { market, collateralId } = await damagedMarket();
    await reconcileTarget(t.db, { scope: 'market', marketId: market.id }, publish, logger);
    await withLedgerGuardsOff((client) =>
      client.query(
        'UPDATE balances SET available_coin = available_coin - 1 WHERE account_id = $1',
        [collateralId],
      ),
    );
    const done = await reconcileTarget(
      t.db,
      { scope: 'market', marketId: market.id },
      publish,
      logger,
      'manual',
    );
    expect(done).toMatchObject({ passed: true, held: true, paused: false });
    expect(
      (await t.db.select().from(schema.markets).where(eq(schema.markets.id, market.id)))[0]?.status,
    ).toBe('paused');
    // The first run's status and its two holders' signals (#54 B′); the clean recheck adds none.
    expect(published.map(({ event }) => event.type)).toEqual([
      'market:status',
      'user:notification',
      'user:notification',
    ]);
    expect(await t.db.select().from(schema.notifications)).toHaveLength(2);
  });

  it('daily checks accounts and supply, records both failures and never makes a global hold', async () => {
    const { user } = await createUser(t.db, { balanceCoin: 100n });
    await createUser(t.db);
    await withLedgerGuardsOff((client) =>
      client.query('UPDATE balances SET available_coin = available_coin + 7 WHERE user_id = $1', [
        user.id,
      ]),
    );
    const result = await reconcileLedger(t.db, publish, logger);
    expect(result).toMatchObject({
      checked: 3,
      passed: 1,
      mismatched: 2,
      held: 1,
      paused: 0,
      failed: 0,
      scopes: { account: 2, market: 0, supply: 1 },
    });
    expect(result.mismatches.map((row) => row.scope).sort()).toEqual(['account', 'supply']);
    expect(await t.db.select().from(schema.reconciliationHolds)).toHaveLength(1);
    expect(published).toEqual([]);
    expect(() => JSON.stringify(reconciliationBatchSummary(result))).not.toThrow();
  });

  it('manual all includes markets without ledger accounts and checks a market with funds once', async () => {
    await createMarket(t.db, { status: 'draft' });
    const funded = await createMarket(t.db, { status: 'open' });
    await fundMarketMakerFunds(t.db, funded.id, 100n);
    const result = await reconcileLedger(t.db, publish, logger, {
      source: 'manual',
      allMarkets: true,
    });
    expect(result).toMatchObject({ mismatched: 0, failed: 0, scopes: { market: 2, supply: 1 } });
    const records = await t.db.select().from(schema.reconciliationResults);
    expect(
      records.filter((row) => row.scope === 'market' && row.marketId === funded.id),
    ).toHaveLength(1);
    expect(records.every((row) => row.source === 'manual')).toBe(true);
  });

  it('publishes nothing from a rolled-back audit and continues the scan after that target fails', async () => {
    const { market } = await damagedMarket();
    await createMarket(t.db, { status: 'open' });
    const failing = new Proxy(t.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (run: (tx: Tx) => Promise<{ result: { marketId: string | null } }>) =>
            target.transaction(async (tx) => {
              const done = await run(tx);
              if (done.result.marketId === market.id) throw new Error('injected before commit');
              return done;
            });
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const result = await reconcileDueMarkets(failing, publish, logger);
    expect(result).toMatchObject({ checked: 1, passed: 1, failed: 1, paused: 0 });
    expect(result.failures[0]).toMatchObject({
      target: `market:${market.id}`,
      message: 'injected before commit',
    });
    expect(await t.db.select().from(schema.reconciliationHolds)).toEqual([]);
    expect(await t.db.select().from(schema.reconciliationResults)).toHaveLength(1);
    expect(
      (await t.db.select().from(schema.markets).where(eq(schema.markets.id, market.id)))[0]?.status,
    ).toBe('open');
    // Its pause's notices rolled back with it (#54 B′: written in the same transaction).
    expect(await t.db.select().from(schema.notifications)).toEqual([]);
    expect(published).toEqual([]);
  });

  /**
   * #54 B′ (ADR-0159; 54-5, 54-6): the automatic ledger-failure pause tells the market's watchers
   * and holders `market_paused`, reason `ledger_failure`, through every worker path
   * (`reconcileTarget`: the minute scan, `market.audit` with a target, the daily audit and the
   * manual script). Who was told is in the inbox alone: never in a check, a batch or a log. A
   * member whose 시장 is off is not told (#56, ADR-0162).
   */
  describe('the automatic pause’s notices (#54 B′)', () => {
    /** The damaged market's holders (`yes`, `no`), a watcher, and another market's watcher. */
    async function watchedDamagedMarket() {
      const damaged = await damagedMarket();
      const watcher = (await createUser(t.db)).user.id;
      const elsewhere = (await createUser(t.db)).user.id;
      await createWatch(t.db, { userId: watcher, marketId: damaged.market.id });
      // A holder who also watches is told once (one key per member, type and event).
      await createWatch(t.db, { userId: damaged.yes, marketId: damaged.market.id });
      const other = await createMarket(t.db, { status: 'open' });
      await createWatch(t.db, { userId: elsewhere, marketId: other.id });
      return { ...damaged, watcher, elsewhere, told: [damaged.yes, damaged.no, watcher].sort() };
    }
    /** Sorted by room, as `told` is. */
    const byChannel = <T extends { channel: string }>(rows: T[]) =>
      [...rows].sort((x, y) => (x.channel < y.channel ? -1 : x.channel > y.channel ? 1 : 0));
    const noticesOf = (userId: string) =>
      t.db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
    const marketRow = async (id: string) =>
      (await t.db.select().from(schema.markets).where(eq(schema.markets.id, id)))[0]!;

    it('tells its watchers and holders after COMMIT: market:status first, then one user:notification each, naming nobody in the check', async () => {
      const { market, watcher, elsewhere, told } = await watchedDamagedMarket();
      // Read from another connection the moment each signal arrives: the notice is committed.
      const seen: Promise<{ channel: string; notices: number }>[] = [];
      const afterCommit: Publish = async (channel, event) => {
        if (event.type === 'user:notification') {
          const userId = channel.slice('user:'.length);
          seen.push(noticesOf(userId).then((rows) => ({ channel, notices: rows.length })));
        }
        await publish(channel, event);
      };
      const batch = await reconcileDueMarkets(t.db, afterCommit, logger);
      // The other market passes and tells nobody.
      expect(batch).toMatchObject({
        checked: 2,
        passed: 1,
        mismatched: 1,
        held: 1,
        paused: 1,
        failed: 0,
      });
      const [check] = batch.mismatches;
      const row = await marketRow(market.id);
      expect(row.status).toBe('paused');

      expect(published[0]).toEqual({
        channel: marketChannel(market.id),
        event: expect.objectContaining({
          type: 'market:status',
          status: 'paused',
          statusEventId: String(row.statusEventId),
          ts: check!.checkedAt,
        }) as unknown,
      });
      // The members' signals at the run's instant (the order among members is not a contract).
      const signal = { type: 'user:notification', ts: check!.checkedAt };
      expect(byChannel(published.slice(1))).toEqual(
        told.map((id) => ({ channel: userChannel(id), event: signal })),
      );
      expect(byChannel(await Promise.all(seen))).toEqual(
        told.map((id) => ({ channel: userChannel(id), notices: 1 })),
      );
      // One `market_paused` each, the public reason label's key, the market's detail (52-9, 54-4).
      for (const id of told) {
        expect(await noticesOf(id)).toEqual([
          expect.objectContaining({
            type: 'market_paused',
            category: 'market',
            params: { marketTitle: market.title, reason: 'ledger_failure' },
            target: { kind: 'market', slug: market.slug },
            mergeKey: null,
            eventCount: 1,
            occurredAt: new Date(check!.checkedAt),
            readAt: null,
          }),
        ]);
      }
      expect(await noticesOf(elsewhere)).toEqual([]);
      // Keyed by the pause's own event (`market_event:<id>`).
      expect(
        (await t.db.select().from(schema.notificationKeys)).map((key) => ({
          userId: key.userId,
          type: key.type,
          eventKey: key.eventKey,
        })),
      ).toEqual(
        expect.arrayContaining(
          told.map((userId) => ({
            userId,
            type: 'market_paused',
            eventKey: `market_event:${String(row.statusEventId)}`,
          })),
        ),
      );
      expect(await t.db.select().from(schema.notificationKeys)).toHaveLength(told.length);

      // Nobody told is named or counted where an operator reads (ADR-0064): the check, the
      // job's summary and the log carry no recipient.
      expect(Object.keys(check!).sort()).toEqual(
        [
          'accountId',
          'checkedAt',
          'findings',
          'held',
          'marketId',
          'passed',
          'paused',
          'resultId',
          'scope',
          'targetKey',
          'userId',
        ].sort(),
      );
      const written = JSON.stringify([check, reconciliationBatchSummary(batch), logs]);
      expect(written).not.toContain(watcher);
      for (const id of told) expect(written).not.toContain(id);
      expect(logs).toEqual([]);

      // The next run finds it PAUSED: it pauses nothing and tells nobody again.
      const before = await t.db.select().from(schema.notifications);
      expect(await reconcileDueMarkets(t.db, publish, logger)).toMatchObject({
        checked: 1,
        paused: 0,
      });
      expect(await t.db.select().from(schema.notifications)).toEqual(before);
      expect(published).toHaveLength(1 + told.length);
    });

    it('tells them from the daily audit too: a market account’s check pauses its market', async () => {
      const { market, told } = await watchedDamagedMarket();
      const result = await reconcileLedger(t.db, publish, logger);
      expect(result).toMatchObject({ paused: 1, failed: 0 });
      expect(published.filter(({ channel }) => channel === marketChannel(market.id))).toHaveLength(
        1,
      );
      expect(
        published
          .filter(({ event }) => event.type === 'user:notification')
          .map(({ channel }) => channel)
          .sort(),
      ).toEqual(told.map((id) => userChannel(id)).sort());
      for (const id of told) {
        expect((await noticesOf(id)).map((notice) => notice.type)).toEqual(['market_paused']);
      }
    });

    it('tells nobody whose 시장 is off — the pause commits, the others are told (#56, ADR-0162; 52-22)', async () => {
      const { market, watcher, told } = await watchedDamagedMarket();
      expect(await setNotificationCategory(t.db, watcher, 'market', false)).toEqual(['market']);
      const batch = await reconcileDueMarkets(t.db, publish, logger);
      expect(batch).toMatchObject({ mismatched: 1, paused: 1, failed: 0 });
      expect((await marketRow(market.id)).status).toBe('paused');
      const reached = told.filter((id) => id !== watcher);
      for (const id of reached) {
        expect((await noticesOf(id)).map((notice) => notice.type)).toEqual(['market_paused']);
      }
      expect(await noticesOf(watcher)).toEqual([]);
      expect(
        (await t.db.select().from(schema.notificationKeys)).map((key) => key.userId).sort(),
      ).toEqual(reached);
      expect(
        published
          .filter(({ event }) => event.type === 'user:notification')
          .map(({ channel }) => channel)
          .sort(),
      ).toEqual(reached.map((id) => userChannel(id)).sort());
      // The savepoint's failure line is not written: a skipped member is no write failure.
      expect(logs).toEqual([]);
    });

    it('keeps the pause when its notices cannot be written: the fixed line alone, no notice, no signal (54-6)', async () => {
      const { market, told } = await watchedDamagedMarket();
      // A slug the write path refuses (no DB CHECK holds `markets.slug`): its notices throw.
      await t.db
        .update(schema.markets)
        .set({ slug: 'Not A Slug' })
        .where(eq(schema.markets.id, market.id));
      const check = await reconcileTarget(
        t.db,
        { scope: 'market', marketId: market.id },
        publish,
        logger,
      );
      // The pause and the hold stand: the savepoint took only the notices back.
      expect(check).toMatchObject({ passed: false, held: true, paused: true });
      expect((await marketRow(market.id)).status).toBe('paused');
      expect(await t.db.select().from(schema.marketPauses)).toMatchObject([
        { pausedBy: null, reason: 'ledger_failure' },
      ]);
      expect(await t.db.select().from(schema.reconciliationHolds)).toHaveLength(1);
      expect(await t.db.select().from(schema.notifications)).toEqual([]);
      expect(await t.db.select().from(schema.notificationKeys)).toEqual([]);
      expect(published.map(({ event }) => event.type)).toEqual(['market:status']);
      // One warning, the fixed sentence and nothing else: no error, id or count.
      expect(logs).toEqual([
        expect.objectContaining({ level: 40, msg: RECONCILIATION_NOTICES_FAILED_LOG }),
      ]);
      expect(Object.keys(logs[0]!).sort()).toEqual(['hostname', 'level', 'msg', 'pid', 'time']);
      for (const id of told) expect(JSON.stringify(logs)).not.toContain(id);
    });
  });
});
