import { readFileSync, readdirSync } from 'node:fs';
import { NOTIFICATION_PARAM_STRING_MAX, type MarketStatus } from '@buddha/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  marketAudience,
  marketNotificationInputs,
  type MarketNotice,
  type MarketNoticeEvent,
} from './market-notifications.js';
import { pauseMarket } from './market-pause.js';
import { createNotifications, notifiedUserIds, type NotificationOutcome } from './notifications.js';
import { lockMarketOrders } from './order-cancel.js';
import { marketEventKey, orderEndNotificationInputs } from './order-notifications.js';
import {
  marketWatchEvents,
  marketWatches,
  markets,
  notificationKeys,
  notifications,
} from './schema/index.js';
import {
  closeAccount,
  createMarket,
  createMarketMakerAccount,
  createPosition,
  createUser,
  createWatch,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  closeTestMarket,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  tradeOnce,
  type PlaceTestOrderInput,
} from './test/orders.js';
import { waitForLockWaiter } from './test/wait.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

/*
 * 시장 상태 알림 (#54, ADR-0159): who hears of a market's state (`marketAudience`, 52-1), the
 * builder of the five 시장 types (`marketNotificationInputs`) through the real write path, how the
 * audience read stays exact under the event's market-row lock (§2: a watch or an unwatch waits for
 * the event), and the static pin of which status changes notify.
 */

const EVENT_AT = new Date('2026-11-22T01:00:00.000Z');
const event = (id = 7): MarketNoticeEvent => ({
  eventKey: marketEventKey(id),
  occurredAt: EVENT_AT,
});

/** A gate one transaction waits at until the test opens it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe('marketNotificationInputs (pure, #54)', () => {
  const market = (status: MarketStatus) => ({ slug: 'first-snow', title: '첫눈이 올까', status });
  const audience = ['user-b', 'user-a'];
  const cases: [MarketNotice, MarketStatus, string, Record<string, unknown>][] = [
    [{ kind: 'closed', early: false }, 'closed', 'market_closed', { early: false }],
    [{ kind: 'closed', early: true }, 'closed', 'market_closed', { early: true }],
    [{ kind: 'cancelled' }, 'cancelled', 'market_cancelled', {}],
    [
      { kind: 'paused', reason: 'early_result' },
      'paused',
      'market_paused',
      { reason: 'early_result' },
    ],
    [
      { kind: 'resumed', reason: 'ledger_failure' },
      'open',
      'market_resumed',
      { reason: 'ledger_failure' },
    ],
    [
      { kind: 'rules_supplemented', ruleVersion: 3, reason: '대체 출처를 더합니다.' },
      'open',
      'market_rules_supplemented',
      { ruleVersion: 3, reason: '대체 출처를 더합니다.' },
    ],
    [
      { kind: 'rules_supplemented', ruleVersion: 2, reason: '사건 기한을 고칩니다.' },
      'paused',
      'market_rules_supplemented',
      { ruleVersion: 2, reason: '사건 기한을 고칩니다.' },
    ],
  ];

  it('makes one input per member, keyed by the event, at its instant, leading to the market', () => {
    for (const [notice, status, type, params] of cases) {
      expect(
        marketNotificationInputs(audience, market(status), { ...notice, ...event(42) }),
        type,
      ).toEqual(
        audience.map((userId) => ({
          userId,
          type,
          eventKey: 'market_event:42',
          occurredAt: EVENT_AT,
          target: { kind: 'market', slug: 'first-snow' },
          params: { marketTitle: '첫눈이 올까', ...params },
        })),
      );
    }
  });

  it('gives nothing for nobody, but still refuses a caller bug', () => {
    expect(
      marketNotificationInputs([], market('cancelled'), { kind: 'cancelled', ...event() }),
    ).toEqual([]);
    // A mismatch throws even when nobody listens: the status is checked first.
    expect(() =>
      marketNotificationInputs([], market('closed'), { kind: 'cancelled', ...event() }),
    ).toThrow(/cancelled notice of a market that is closed/);
    expect(() =>
      marketNotificationInputs([], market('open'), {
        kind: 'rules_supplemented',
        ruleVersion: 1,
        reason: '사유',
        ...event(),
      }),
    ).toThrow();
  });

  it('throws on a status the notice’s event does not leave (a caller bug: the event rolls back)', () => {
    const statuses: MarketStatus[] = [
      'draft',
      'review',
      'scheduled',
      'open',
      'paused',
      'closed',
      'cancelled',
      'provisional',
      'resolved',
      'settling',
      'settled',
    ];
    const allowed: Record<MarketNotice['kind'], MarketStatus[]> = {
      closed: ['closed'],
      cancelled: ['cancelled'],
      paused: ['paused'],
      resumed: ['open'],
      rules_supplemented: ['open', 'paused'],
    };
    for (const [notice] of cases) {
      for (const status of statuses) {
        const build = () =>
          marketNotificationInputs(audience, market(status), { ...notice, ...event() });
        if (allowed[notice.kind].includes(status))
          expect(build, `${notice.kind}/${status}`).not.toThrow();
        else expect(build, `${notice.kind}/${status}`).toThrow();
      }
    }
  });

  it('throws on a supplement’s version below 2, a fraction, or an empty reason', () => {
    for (const notice of [
      { kind: 'rules_supplemented', ruleVersion: 1, reason: '사유' },
      { kind: 'rules_supplemented', ruleVersion: 0, reason: '사유' },
      { kind: 'rules_supplemented', ruleVersion: 2.5, reason: '사유' },
      { kind: 'rules_supplemented', ruleVersion: 2, reason: '' },
    ] as const) {
      expect(
        () => marketNotificationInputs(audience, market('open'), { ...notice, ...event() }),
        JSON.stringify(notice),
      ).toThrow();
    }
  });
});

describe.skipIf(!hasTestDb())('시장 상태 알림 against the test database (#54)', () => {
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
    await openOrderIntake(t.db, { adminId });
  });

  const member = async (coin = 1_000n) => (await createUser(t.db, { balanceCoin: coin })).user.id;
  const market = async (input: { title?: string } = {}) =>
    createMarket(t.db, { createdBy: adminId, ...input });
  const audienceOf = (marketId: string) => t.db.transaction((tx) => marketAudience(tx, marketId));
  async function placed(input: PlaceTestOrderInput) {
    const result = await placeTestOrder(t.db, input);
    if (result.kind !== 'placed') throw new Error(`expected a placed order, got ${result.kind}`);
    return result;
  }
  /** The API's unwatch (WatchlistService `set`): the row gone, and its `unwatch` event. */
  const unwatch = (userId: string, marketId: string) =>
    t.db.transaction(async (tx) => {
      const gone = await tx
        .delete(marketWatches)
        .where(and(eq(marketWatches.userId, userId), eq(marketWatches.marketId, marketId)))
        .returning();
      if (gone.length > 0) {
        await tx.insert(marketWatchEvents).values({ userId, marketId, action: 'unwatch' });
      }
    });
  const rowsOf = (userId: string) =>
    t.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(asc(notifications.type), asc(notifications.id));
  const kinds = (outcomes: readonly NotificationOutcome[]) => outcomes.map((o) => o.kind);

  /** Holds a pool connection inside an open transaction, for lock tests. */
  async function holder() {
    const client = await t.db.$client.connect();
    await client.query('BEGIN');
    return {
      client,
      waitFor: (what: string, n = 1) => waitForLockWaiter(client, what, n),
      async end(how: 'COMMIT' | 'ROLLBACK' = 'ROLLBACK') {
        await client.query(how);
        client.release();
      },
    };
  }

  describe('marketAudience (52-1, 53-5, 53-6, #54 AC 5)', () => {
    it('reads the watchers and the holders of one contract or more, each once, sorted', async () => {
      const m = (await market()).id;
      const other = (await market()).id;
      const [watcher, yes, no, both, buyer, seller, resting, gone, elsewhere] = [
        await member(),
        await member(),
        await member(),
        await member(),
        await member(),
        await member(),
        await member(),
        await member(),
        await member(),
      ];
      await createWatch(t.db, { userId: watcher, marketId: m });
      // An admin who watches is told like anyone, the acting one included (53-5, 54-8).
      await createWatch(t.db, { userId: adminId, marketId: m });
      // A pair mint: YES to `yes`, NO to `no` (a NO that would pay 0 is a holding all the same).
      await tradeOnce(t.db, m, { yesOwner: yes, noOwner: no });
      // A watcher who also holds: one id.
      await createWatch(t.db, { userId: both, marketId: m });
      await tradeOnce(t.db, m, { yesOwner: both, noOwner: no });
      // `seller` buys one YES, then sells it to `buyer`: a qty-0 row is no holding.
      await tradeOnce(t.db, m, { yesOwner: seller, noOwner: no });
      await placed({ ownerId: buyer, marketId: m, outcome: 'YES', limitPriceCoin: 50 });
      await placed({
        ownerId: seller,
        marketId: m,
        outcome: 'YES',
        side: 'sell',
        timeInForce: 'ioc',
        limitPriceCoin: 50,
      });
      // Resting orders only: no holding, no notice (their own order notices tell them, 52-1).
      await placed({ ownerId: resting, marketId: m, outcome: 'NO', limitPriceCoin: 10 });
      // A member who unwatched before the event; another market's watcher.
      await createWatch(t.db, { userId: gone, marketId: m });
      await unwatch(gone, m);
      await createWatch(t.db, { userId: elsewhere, marketId: other });
      // The 운영 마켓메이커 holds: in the read, and the write path's gate skips it (53-5).
      const bot = await createMarketMakerAccount(t.db);
      await createPosition(t.db, { userId: bot, marketId: m, outcome: 'NO', qty: 2 });

      const audience = await audienceOf(m);
      expect(audience).toEqual([watcher, adminId, yes, no, both, buyer, bot].sort());
      expect(audience).not.toContain(seller);
      expect(audience).not.toContain(resting);
      expect(audience).not.toContain(gone);
      expect(audience).not.toContain(elsewhere);
      expect(await audienceOf(other)).toEqual([elsewhere]);
      expect(await audienceOf((await market()).id)).toEqual([]);
    });

    it('takes no row lock: holdings, profiles and inboxes stay free while it is held open', async () => {
      const m = (await market()).id;
      const [watcher, yes, no] = [await member(), await member(), await member()];
      await createWatch(t.db, { userId: watcher, marketId: m });
      await tradeOnce(t.db, m, { yesOwner: yes, noOwner: no });
      const read = gate();
      const release = gate();
      const reading = t.db.transaction(async (tx) => {
        const audience = await marketAudience(tx, m);
        read.open();
        await release.opened;
        return audience;
      });
      await read.opened;
      const other = await holder();
      try {
        for (const [what, query, value] of [
          ['positions', 'SELECT 1 FROM positions WHERE market_id = $1 FOR UPDATE NOWAIT', m],
          ['profile', 'SELECT 1 FROM profiles WHERE user_id = $1 FOR UPDATE NOWAIT', watcher],
          ['inbox', 'SELECT 1 FROM notification_inboxes WHERE user_id = $1 FOR UPDATE NOWAIT', yes],
        ] as const) {
          await expect(other.client.query(query, [value]), what).resolves.toBeDefined();
        }
      } finally {
        await other.end();
        release.open();
      }
      expect(await reading).toEqual([watcher, yes, no].sort());
    });
  });

  describe('the inputs through the write path (ADR-0157 결정 4의 7: never refused)', () => {
    it('delivers each type with its params, its key, its instant and the market’s detail', async () => {
      // A 120-code-point title of astral characters: 240 UTF-16 units, still stored and told.
      const title = '𝔸'.repeat(120);
      const row = await market({ title });
      const [watcher, holder2] = [await member(), await member()];
      await createWatch(t.db, { userId: watcher, marketId: row.id });
      await createPosition(t.db, { userId: holder2, marketId: row.id, outcome: 'YES', qty: 1 });
      const bot = await createMarketMakerAccount(t.db);
      await createPosition(t.db, { userId: bot, marketId: row.id, outcome: 'NO', qty: 1 });
      const closed = await member();
      await createWatch(t.db, { userId: closed, marketId: row.id });
      const audience = [...(await audienceOf(row.id)), closed].sort();
      await closeAccount(t.db, closed);
      const reason = '가'.repeat(NOTIFICATION_PARAM_STRING_MAX);
      const notices: [MarketNotice, MarketStatus][] = [
        [{ kind: 'closed', early: false }, 'closed'],
        [{ kind: 'closed', early: true }, 'closed'],
        [{ kind: 'cancelled' }, 'cancelled'],
        [{ kind: 'paused', reason: 'basis_change' }, 'paused'],
        [{ kind: 'resumed', reason: 'basis_change' }, 'open'],
        [{ kind: 'rules_supplemented', ruleVersion: 4, reason }, 'paused'],
      ];
      for (const [index, [notice, status]] of notices.entries()) {
        const inputs = marketNotificationInputs(
          audience,
          { slug: row.slug, title, status },
          { ...notice, ...event(100 + index) },
        );
        const outcomes = await t.db.transaction((tx) => createNotifications(tx, inputs));
        // The bot has no inbox (53-5) and a closed account none either (53-5, 53-8).
        expect(
          outcomes.map((o) => [o.userId, o.kind]),
          notice.kind,
        ).toEqual(
          audience.map((userId) => [
            userId,
            userId === bot || userId === closed ? 'skipped' : 'created',
          ]),
        );
        expect(notifiedUserIds(outcomes).sort(), notice.kind).toEqual([watcher, holder2].sort());
      }
      const rows = await rowsOf(watcher);
      expect(rows).toHaveLength(notices.length);
      for (const stored of rows) {
        expect(stored).toMatchObject({
          category: 'market',
          target: { kind: 'market', slug: row.slug },
          mergeKey: null,
          eventCount: 1,
          occurredAt: EVENT_AT,
          readAt: null,
        });
        expect(stored.params.marketTitle).toBe(title);
      }
      expect(rows.find((r) => r.type === 'market_rules_supplemented')!.params).toEqual({
        marketTitle: title,
        ruleVersion: 4,
        reason,
      });
      expect(
        (
          await t.db
            .select({ eventKey: notificationKeys.eventKey })
            .from(notificationKeys)
            .where(eq(notificationKeys.userId, watcher))
            .orderBy(asc(notificationKeys.eventKey))
        ).map((key) => key.eventKey),
      ).toEqual(notices.map((_, index) => marketEventKey(100 + index)).sort());
    });

    it('tells a member once per event and type, whether watcher, holder or both; a reprocess is a duplicate (53-4)', async () => {
      const row = await market();
      const [both, a] = [await member(), await member()];
      await createWatch(t.db, { userId: both, marketId: row.id });
      await tradeOnce(t.db, row.id, { yesOwner: both, noOwner: a });
      const audience = await audienceOf(row.id);
      expect(audience).toEqual([both, a].sort());
      const inputs = marketNotificationInputs(
        audience,
        { slug: row.slug, title: row.title, status: 'paused' },
        { kind: 'paused', reason: 'early_result', ...event(9) },
      );
      expect(inputs).toHaveLength(2);
      expect(kinds(await t.db.transaction((tx) => createNotifications(tx, inputs)))).toEqual([
        'created',
        'created',
      ]);
      expect(kinds(await t.db.transaction((tx) => createNotifications(tx, inputs)))).toEqual([
        'duplicate',
        'duplicate',
      ]);
      expect((await rowsOf(both)).filter((r) => r.type === 'market_paused')).toHaveLength(1);
    });
  });

  describe('the audience under the event’s market-row lock (§2: no race)', () => {
    it('makes a watch or an unwatch sent during an event wait for it: the event tells the unwatcher, the next event the new watcher', async () => {
      const row = await market();
      const m = row.id;
      const [stays, leaving, coming] = [await member(), await member(), await member()];
      await createWatch(t.db, { userId: stays, marketId: m });
      await createWatch(t.db, { userId: leaving, marketId: m });
      // Event 1: an admin's pause as the API's transaction runs it (B), held after its row lock.
      const locked = gate();
      const proceed = gate();
      const pause = t.db.transaction(async (tx) => {
        await lockMarket(tx, m);
        const [current] = await tx.select().from(markets).where(eq(markets.id, m)).for('update');
        locked.open();
        await proceed.opened;
        const orders = await lockMarketOrders(tx, m);
        const now = await clockTimestamp(tx);
        const result = await pauseMarket(tx, {
          market: current!,
          orders,
          now,
          actorId: adminId,
          reason: 'basis_change',
          note: '기준이 바뀌었습니다.',
          resultPublishedAt: null,
        });
        if (!result.paused) throw new Error(`not paused: ${result.reason}`);
        const eventKey = marketEventKey(result.eventId);
        const outcomes = await createNotifications(tx, [
          ...orderEndNotificationInputs(result.cancelled.cancelled, {
            kind: 'cancelled',
            reason: 'paused',
            market: { id: m, title: result.market.title },
            eventKey,
            occurredAt: now,
          }),
          ...marketNotificationInputs(await marketAudience(tx, m), result.market, {
            kind: 'paused',
            reason: result.pause.reason,
            eventKey,
            occurredAt: now,
          }),
        ]);
        return notifiedUserIds(outcomes);
      });
      await locked.opened;
      // The unwatch deletes its row, then waits to insert its `unwatch` event (its foreign key
      // takes the market row FOR KEY SHARE); the watch waits on its own row's foreign key.
      const unwatching = unwatch(leaving, m);
      const watching = createWatch(t.db, { userId: coming, marketId: m });
      const lock = await holder();
      try {
        await lock.waitFor('the watch and the unwatch wait on the market row', 2);
      } finally {
        await lock.end();
      }
      proceed.open();
      // The unwatch had not happened when the event read: the unwatcher is told, the newcomer not.
      expect((await pause).sort()).toEqual([stays, leaving].sort());
      await Promise.all([unwatching, watching]);
      expect((await rowsOf(leaving)).map((r) => r.type)).toEqual(['market_paused']);
      expect(await rowsOf(coming)).toEqual([]);
      // Event 2: the close of the PAUSED market at its close_at (G) — after both committed.
      await passMarketClose(t.db, m);
      const done = await closeTestMarket(t.db, m);
      if (!done.closed) throw new Error('expected a close');
      expect(done.status).toBe('cancelled');
      expect([...done.notified].sort()).toEqual([stays, coming].sort());
      expect((await rowsOf(leaving)).map((r) => r.type)).toEqual(['market_paused']);
      expect((await rowsOf(coming)).map((r) => r.type)).toEqual(['market_cancelled']);
      expect((await rowsOf(stays)).map((r) => r.type)).toEqual([
        'market_cancelled',
        'market_paused',
      ]);
    });
  });
});

// ---- static -------------------------------------------------------------------------------------

const ROOT = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

/**
 * Every production source of every app and package (order-notifications.test.ts's scan), relative
 * to the repository root: no test, and no fixture under `packages/db/src/test/`.
 */
function sourceFiles(): string[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(new URL(`${group}/`, ROOT), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const src = `${group}/${entry.name}/src`;
        let files: string[];
        try {
          files = readdirSync(new URL(`${src}/`, ROOT), { recursive: true, encoding: 'utf8' });
        } catch {
          return [];
        }
        return files
          .map((file) => file.replaceAll('\\', '/'))
          .filter((file) => /\.(ts|tsx|mts)$/.test(file) && !/\.test\.tsx?$/.test(file))
          .map((file) => `${src}/${file}`)
          .filter((file) => !file.startsWith('packages/db/src/test/'));
      }),
  );
}

/** A CALL of the status change (it takes the transaction first), not its definition. */
const TRANSITION_CALL = /\btransitionMarket\(\s*tx\s*[,)]/;
/** A CALL of a reconciliation run that may pause a market (B′). */
const RECONCILIATION_CALL = /\b(runMarketReconciliation|runAccountReconciliation)\(\s*tx\s*[,)]/;
/** The builder's call, the B′ delivery's call, the write path's call. */
const BUILDS = /\bmarketNotificationInputs\(/;
const DELIVERS_B_PRIME = /\bdeliverReconciliationNotices\(/;
const WRITES = /\bcreateNotifications\(/;
/** #188's builders (judgement-notifications.ts, ADR-0160): J1/J2/J4, J5, J3, J2's closures. */
const BUILDS_JUDGEMENT = /\bjudgementNotificationInputs\(/;
const BUILDS_SETTLEMENT = /\bsettlementNotificationInputs\(/;
/** Every market-notice builder or delivery (#54's and #188's) and both audience reads. */
const MARKET_NOTICE_CALLS = [
  'marketNotificationInputs',
  'deliverReconciliationNotices',
  'judgementNotificationInputs',
  'settlementNotificationInputs',
  'disputeDecisionNotificationInput',
  'disputeClosureNotificationInputs',
  'marketAudience',
  'settlementAudience',
];
const ANY_MARKET_NOTICE = new RegExp(`\\b(${MARKET_NOTICE_CALLS.join('|')})\\(`);
/** A caller that cannot pause asserts the run paused nothing. */
const ASSERTS_NO_PAUSE = /\.systemPause\s*[!=]==\s*null/;

type StatusChanger =
  /** Its file holds the event's one call with its builder's inputs (`builds`, default #54's). */
  | { class: 'notifies'; event: string; builds?: RegExp }
  /** A core whose transaction owners (`by`, each) build its inputs (`builds`, default #54's). */
  | { class: 'core'; by: readonly string[]; event: string; builds?: RegExp }
  /** It changes a status no market notice covers. */
  | { class: 'excluded'; reason: string };

/**
 * Every production file that changes a market's status (`transitionMarket(tx`), classified
 * (ADR-0159; #188's two reclassified by ADR-0160). A new caller fails the pin until it is
 * classified here; a stale entry fails too. #188's correction (J2), dispute decision (J3) and
 * delay record (J4) change no status: judgement-notifications.test.ts pins their callers.
 */
const STATUS_CHANGERS: Record<string, StatusChanger> = {
  'packages/db/src/market-close.ts': { class: 'notifies', event: 'G the close at close_at' },
  'packages/db/src/market-pause.ts': {
    class: 'core',
    by: ['apps/api/src/markets/market-pause.service.ts'],
    event: 'B the admin’s pause, C its approved resume or early close',
  },
  'packages/db/src/market-cancel.ts': {
    class: 'core',
    by: ['apps/api/src/markets/market-cancel.service.ts'],
    event: 'E the SCHEDULED market’s cancel (52-5)',
  },
  'packages/db/src/reconciliation-audit.ts': {
    class: 'core',
    by: [
      'apps/worker/src/jobs/reconciliation.ts',
      'apps/api/src/admin/reconciliation.service.ts',
      'apps/api/src/admin/reconciliation-corrections.service.ts',
    ],
    event: 'B′ the automatic ledger-failure pause (54-5)',
    builds: DELIVERS_B_PRIME,
  },
  'packages/db/src/market-open.ts': { class: 'excluded', reason: '개장 (52-20)' },
  'apps/api/src/markets/market-admin.service.ts': {
    class: 'excluded',
    reason: '검수 제출·승인·반려·되돌리기 — before the open (52-20)',
  },
  'packages/db/src/market-judgement.ts': {
    class: 'core',
    by: ['apps/api/src/markets/market-judgement.service.ts'],
    event:
      'J1 provisional, J2 correction (#188, ADR-0160); its `resolved` transition is the worker’s and silent (52-12)',
    builds: BUILDS_JUDGEMENT,
  },
  'apps/worker/src/jobs/market-finalize.ts': {
    class: 'notifies',
    event:
      'J5 지급 완료 (#188, ADR-0160; 188-2: all or nothing with the payout); its `settling` is silent',
    builds: BUILDS_SETTLEMENT,
  },
};

/** The reconciliation runs' callers: the B′ owners, the callers that cannot pause, the core. */
const RECONCILIATION_CALLERS: Record<string, 'owner' | 'never_pauses' | 'core'> = {
  'apps/worker/src/jobs/reconciliation.ts': 'owner',
  'apps/api/src/admin/reconciliation.service.ts': 'owner',
  'apps/api/src/admin/reconciliation-corrections.service.ts': 'owner',
  'packages/db/src/reconciliation-recovery.ts': 'never_pauses',
  'apps/api/src/markets/market-pause.service.ts': 'never_pauses',
  // Its account run hands a market account's run — `systemPause` included — to the owner.
  'packages/db/src/reconciliation-audit.ts': 'core',
};

describe('who tells of a market’s state (#54, static)', () => {
  const files = sourceFiles();
  const changers = files.filter((file) => TRANSITION_CALL.test(read(file))).sort();

  it('reads the source tree and matches call sites only', () => {
    expect(files).toEqual(expect.arrayContaining(['packages/db/src/market-transitions.ts']));
    expect(files.some((file) => file.startsWith('packages/db/src/test/'))).toBe(false);
    for (const text of [
      'await transitionMarket(tx, {',
      'const id = await transitionMarket(\n    tx,\n    traded',
      'runMarketReconciliation(tx, id, options)',
      'runAccountReconciliation(\n        tx,\n        {',
    ]) {
      expect(TRANSITION_CALL.test(text) || RECONCILIATION_CALL.test(text), text).toBe(true);
    }
    for (const text of [
      'export async function transitionMarket(\n  tx: Executor,',
      'transitionMarket(trx, transition)',
      'export async function runMarketReconciliation(\n  tx: Tx,',
    ]) {
      expect(TRANSITION_CALL.test(text) || RECONCILIATION_CALL.test(text), text).toBe(false);
    }
    // The definition's own file does not change a status by itself.
    expect(changers).not.toContain('packages/db/src/market-transitions.ts');
  });

  it('classifies every status change: the pinned map is the matched set exactly', () => {
    expect(changers).toEqual(Object.keys(STATUS_CHANGERS).sort());
  });

  it('builds and delivers the notices where a status change notifies (G; #188’s J5)', () => {
    const missing: string[] = [];
    for (const [file, changer] of Object.entries(STATUS_CHANGERS)) {
      if (changer.class !== 'notifies') continue;
      if (!(changer.builds ?? BUILDS).test(read(file))) missing.push(`${file}: no builder`);
      if (!WRITES.test(read(file))) missing.push(`${file}: no write`);
    }
    expect(missing).toEqual([]);
  });

  it('builds the notices in every transaction owner of a core (B, C, E; B′ through its delivery; #188’s J1, J2)', () => {
    const missing: string[] = [];
    for (const [file, changer] of Object.entries(STATUS_CHANGERS)) {
      if (changer.class !== 'core') continue;
      for (const owner of changer.by) {
        if (!(changer.builds ?? BUILDS).test(read(owner))) missing.push(`${owner} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('builds no market notice where a change is excluded (#54’s builders, #188’s, either audience)', () => {
    expect(
      Object.entries(STATUS_CHANGERS)
        .filter(([, changer]) => changer.class === 'excluded')
        .map(([file]) => file)
        .sort(),
    ).toEqual(['apps/api/src/markets/market-admin.service.ts', 'packages/db/src/market-open.ts']);
    for (const [file, changer] of Object.entries(STATUS_CHANGERS)) {
      if (changer.class !== 'excluded') continue;
      expect(read(file), file).not.toMatch(ANY_MARKET_NOTICE);
    }
    // The pattern matches each builder's and audience read's call, and no definition.
    for (const text of [
      'marketNotificationInputs(audience',
      'judgementNotificationInputs(await',
      'settlementNotificationInputs(recipients',
      'disputeDecisionNotificationInput(result.dispute',
      'disputeClosureNotificationInputs(closed',
      'settlementAudience(tx',
      'marketAudience(tx',
      'deliverReconciliationNotices(tx',
    ]) {
      expect(ANY_MARKET_NOTICE.test(text), text).toBe(true);
    }
    expect(ANY_MARKET_NOTICE.test('type JudgementNotice =')).toBe(false);
  });

  it('tells of a supplement only where it is approved, and only one that changed a notified item (D, 52-10)', () => {
    const producers = files
      .filter((file) => /\btype:\s*'rules_supplemented'/.test(read(file)))
      .sort();
    expect(producers).toEqual(['apps/api/src/markets/market-supplement.service.ts']);
    for (const file of producers) {
      expect(read(file), file).toMatch(/\bisNotifiedSupplement\(/);
      expect(read(file), file).toMatch(BUILDS);
    }
  });

  it('classifies every reconciliation run’s caller: owners deliver B′, the rest assert no pause', () => {
    const callers = files.filter((file) => RECONCILIATION_CALL.test(read(file))).sort();
    expect(callers).toEqual(Object.keys(RECONCILIATION_CALLERS).sort());
    const broken: string[] = [];
    for (const [file, role] of Object.entries(RECONCILIATION_CALLERS)) {
      const source = read(file);
      if (role === 'owner' && !DELIVERS_B_PRIME.test(source)) broken.push(`${file}: no delivery`);
      if (role === 'never_pauses' && !ASSERTS_NO_PAUSE.test(source)) {
        broken.push(`${file}: no systemPause assert`);
      }
    }
    expect(broken).toEqual([]);
    // The core reads no audience and builds no input (no import of market-notifications.ts).
    const core = read('packages/db/src/reconciliation-audit.ts');
    expect(core).not.toMatch(BUILDS);
    expect(core).not.toMatch(/market-notifications\.js/);
  });

  it('never tells of the bot-only stop: it changes no status and builds no market notice (AC 3)', () => {
    for (const file of [
      'packages/db/src/market-maker-control.ts',
      'apps/api/src/admin/market-maker-control.service.ts',
      'packages/db/src/market-maker-cycle.ts',
    ]) {
      const source = read(file);
      expect(source, file).not.toMatch(/\btransitionMarket\(/);
      expect(source, file).not.toMatch(ANY_MARKET_NOTICE);
    }
    // The control's own file writes no notification at all (the cycle's are its fills', F2).
    for (const file of [
      'packages/db/src/market-maker-control.ts',
      'apps/api/src/admin/market-maker-control.service.ts',
    ]) {
      expect(read(file), file).not.toMatch(WRITES);
    }
  });
});
