import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { NOTIFICATION_PARAM_STRING_MAX, type MarketStatus } from '@buddha/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  disputeClosureNotificationInputs,
  disputeDecisionNotificationInput,
  judgementNotificationInputs,
  settlementAudience,
  settlementNotificationInputs,
  type JudgementNotice,
  type SettlementRecipient,
} from './judgement-notifications.js';
import { marketAudience } from './market-notifications.js';
import { settleMarketPositions } from './market-settlement.js';
import { createNotifications, notifiedUserIds, type NotificationOutcome } from './notifications.js';
import { adminActionEventKey, marketEventKey } from './order-notifications.js';
import { marketWatches, markets, notificationKeys, notifications } from './schema/index.js';
import {
  closeAccount,
  createCorrectedMarket,
  createDispute,
  createJudgementDelay,
  createMarket,
  createPosition,
  createProvisionalMarket,
  createUser,
  createWatch,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { fundMarketMakerFunds, mintTestPairs } from './test/ledger.js';
import { createOrder } from './test/orders.js';

/*
 * 판정·정산 알림 (#188, ADR-0160): the four builders (pure), the settlement's own audience
 * (`settlementAudience`, 52-1 at the payout), the inputs through the real write path with real
 * rows, and the static pins of who notifies of a judgement or a payout and who never does
 * (52-11~52-14, 188-2, 188-6).
 */

const EVENT_AT = new Date('2026-11-22T04:00:00.000Z');
const DEADLINE = new Date('2026-11-23T04:00:00.000Z');
const STATUSES: MarketStatus[] = [
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
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('the builders (pure, #188)', () => {
  const audience = ['user-b', 'user-a'];
  const market = (status: MarketStatus, judgementTimeZone: string | null = 'America/New_York') => ({
    slug: 'first-snow',
    title: '첫눈이 올까',
    status,
    judgementTimeZone,
  });
  const event = { eventKey: marketEventKey(42), occurredAt: EVENT_AT };
  const target = { kind: 'market', slug: 'first-snow' };
  /** Each judgement notice, the statuses its event leaves, its type and its own params. */
  const judgements: [JudgementNotice, MarketStatus[], string, Record<string, unknown>][] = [
    [
      { kind: 'delayed', reason: '기상청 발표가 늦어지고 있습니다.', nextReviewAt: DEADLINE },
      ['closed', 'provisional'],
      'market_judgement_delayed',
      { reason: '기상청 발표가 늦어지고 있습니다.', nextReviewAt: DEADLINE.toISOString() },
    ],
    [
      { kind: 'provisional', result: 'VOID', disputeDeadline: DEADLINE },
      ['provisional'],
      'market_provisional_result',
      { result: 'VOID', disputeDeadline: DEADLINE.toISOString() },
    ],
    [
      { kind: 'corrected', result: 'NO', disputeDeadline: DEADLINE },
      ['provisional'],
      'market_judgement_corrected',
      { result: 'NO', disputeDeadline: DEADLINE.toISOString() },
    ],
  ];

  it('judgementNotificationInputs: one input per member, keyed by the event, at its instant, to the market (J1, J2, J4)', () => {
    for (const [notice, statuses, type, params] of judgements) {
      for (const [status, zone] of statuses.flatMap((s) =>
        ['America/New_York', null].map((z) => [s, z] as const),
      )) {
        expect(
          judgementNotificationInputs(audience, market(status, zone), { ...notice, ...event }),
          `${type} ${status} ${String(zone)}`,
        ).toEqual(
          audience.map((userId) => ({
            userId,
            type,
            eventKey: 'market_event:42',
            occurredAt: EVENT_AT,
            target,
            // The market's zone as the row holds it; null stays null (a market before #22).
            params: { marketTitle: '첫눈이 올까', ...params, judgementTimeZone: zone },
          })),
        );
      }
    }
  });

  it('judgementNotificationInputs: checks the status even for nobody; throws on a blank reason, naming no account', () => {
    for (const [notice, allowed, type] of judgements) {
      expect(judgementNotificationInputs([], market(allowed[0]!), { ...notice, ...event })).toEqual(
        [],
      );
      for (const status of STATUSES) {
        for (const who of [[], audience]) {
          const build = () =>
            judgementNotificationInputs(who, market(status), { ...notice, ...event });
          if (allowed.includes(status)) expect(build, `${type}/${status}`).not.toThrow();
          else {
            expect(build, `${type}/${status}`).toThrow(/^judgement notice: /);
            expect(build).not.toThrow(/user-/);
          }
        }
      }
    }
    for (const reason of ['', '   ']) {
      const build = () =>
        judgementNotificationInputs(audience, market('closed'), {
          kind: 'delayed',
          reason,
          nextReviewAt: DEADLINE,
          ...event,
        });
      expect(build, JSON.stringify(reason)).toThrow(/public reason/);
      expect(build).not.toThrow(/user-/);
    }
  });

  it('settlementNotificationInputs: the confirmed result and each recipient’s own payout, 0 included, null for a watcher (J5)', () => {
    const recipients: SettlementRecipient[] = [
      { userId: 'user-a', payoutCoin: 200n },
      { userId: 'user-b', payoutCoin: 0n },
      { userId: 'user-c', payoutCoin: null },
      { userId: 'user-d', payoutCoin: 9_007_199_254_740_993n },
    ];
    const settled = { slug: 'first-snow', title: '첫눈이 올까', status: 'settled' as const };
    const finalized = { eventKey: marketEventKey(77), occurredAt: EVENT_AT };
    expect(
      settlementNotificationInputs(recipients, settled, { result: 'YES', ...finalized }),
    ).toEqual(
      [
        ['user-a', '200'],
        ['user-b', '0'],
        ['user-c', null],
        ['user-d', '9007199254740993'],
      ].map(([userId, payoutCoin]) => ({
        userId,
        type: 'market_settled',
        eventKey: 'market_event:77',
        occurredAt: EVENT_AT,
        target,
        params: { marketTitle: '첫눈이 올까', result: 'YES', payoutCoin },
      })),
    );
    expect(settlementNotificationInputs([], settled, { result: 'VOID', ...finalized })).toEqual([]);
    for (const status of STATUSES.filter((s) => s !== 'settled')) {
      for (const who of [[], recipients]) {
        const build = () =>
          settlementNotificationInputs(who, { ...settled, status }, { result: 'NO', ...finalized });
        expect(build, status).toThrow(/settled notice of a market that is/);
        expect(build).not.toThrow(/user-/);
      }
    }
  });

  it('disputeDecisionNotificationInput: to the submitter, 기각 or 수용 with the public reason, keyed by the admin action (J3)', () => {
    const actionId = randomUUID();
    const occurredAt = EVENT_AT;
    for (const status of ['dismissed', 'accepted'] as const) {
      expect(
        disputeDecisionNotificationInput(
          { userId: 'user-a', status, decisionReason: '1차 출처의 발표가 같습니다.' },
          { slug: 'first-snow', title: '첫눈이 올까' },
          { eventKey: adminActionEventKey(actionId), occurredAt },
        ),
      ).toEqual({
        userId: 'user-a',
        type: 'market_dispute_decided',
        eventKey: `admin_action:${actionId}`,
        occurredAt,
        target,
        params: {
          marketTitle: '첫눈이 올까',
          decision: status,
          reason: '1차 출처의 발표가 같습니다.',
        },
      });
    }
    for (const [status, decisionReason] of [
      ['pending', null],
      ['retracted', null],
      ['closed_by_correction', null],
      ['pending', '사유'],
      ['dismissed', null],
      ['accepted', null],
      ['dismissed', ''],
      ['accepted', '  '],
    ] as const) {
      const build = () =>
        disputeDecisionNotificationInput(
          { userId: 'user-a', status, decisionReason },
          { slug: 'first-snow', title: '첫눈이 올까' },
          { eventKey: adminActionEventKey(actionId), occurredAt },
        );
      expect(build, `${status} ${String(decisionReason)}`).toThrow(/^judgement notice: /);
      expect(build).not.toThrow(/user-a/);
    }
  });

  it('disputeClosureNotificationInputs: each closed dispute’s submitter, the new deadline only (J2, 188-1)', () => {
    const closed = [
      { userId: 'user-a', status: 'closed_by_correction' as const },
      { userId: 'user-b', status: 'closed_by_correction' as const },
    ];
    expect(
      disputeClosureNotificationInputs(closed, market('provisional', null), {
        disputeDeadline: DEADLINE,
        ...event,
      }),
    ).toEqual(
      ['user-a', 'user-b'].map((userId) => ({
        userId,
        type: 'market_dispute_closed_by_correction',
        eventKey: 'market_event:42',
        occurredAt: EVENT_AT,
        target,
        params: {
          marketTitle: '첫눈이 올까',
          disputeDeadline: DEADLINE.toISOString(),
          judgementTimeZone: null,
        },
      })),
    );
    expect(
      disputeClosureNotificationInputs([], market('provisional'), {
        disputeDeadline: DEADLINE,
        ...event,
      }),
    ).toEqual([]);
    for (const status of STATUSES.filter((s) => s !== 'provisional')) {
      expect(
        () =>
          disputeClosureNotificationInputs([], market(status), {
            disputeDeadline: DEADLINE,
            ...event,
          }),
        status,
      ).toThrow(/closure notice of a market that is/);
    }
    for (const status of ['pending', 'dismissed', 'accepted', 'retracted'] as const) {
      const build = () =>
        disputeClosureNotificationInputs(
          [...closed, { userId: 'user-c', status }],
          market('provisional'),
          { disputeDeadline: DEADLINE, ...event },
        );
      expect(build, status).toThrow(/closure notice of a dispute that is/);
      expect(build).not.toThrow(/user-/);
    }
  });
});

describe.skipIf(!hasTestDb())('판정·정산 알림 against the test database (#188)', () => {
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

  const member = async (coin = 1_000n) => (await createUser(t.db, { balanceCoin: coin })).user.id;
  const rowsOf = (userId: string) =>
    t.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(asc(notifications.type), asc(notifications.id));
  const keysOf = async (userId: string) =>
    (
      await t.db
        .select({ type: notificationKeys.type, eventKey: notificationKeys.eventKey })
        .from(notificationKeys)
        .where(eq(notificationKeys.userId, userId))
        .orderBy(asc(notificationKeys.type))
    ).map((key) => `${key.type} ${key.eventKey}`);
  const deliver = (inputs: Parameters<typeof createNotifications>[1]) =>
    t.db.transaction((tx) => createNotifications(tx, inputs));
  const kinds = (outcomes: readonly NotificationOutcome[]) =>
    outcomes.map((outcome) => [outcome.userId, outcome.kind]);
  const audienceOf = (marketId: string) => t.db.transaction((tx) => marketAudience(tx, marketId));
  const settlementOf = (marketId: string) =>
    t.db.transaction((tx) => settlementAudience(tx, marketId));
  const pay = (marketId: string) => t.db.transaction((tx) => settleMarketPositions(tx, marketId));
  const marketRow = async (id: string) =>
    (await t.db.select().from(markets).where(eq(markets.id, id)))[0]!;

  /** A SETTLING market with its result, no judgement version (the payout's own fixture). */
  const settling = (result: 'YES' | 'NO' | 'VOID', title?: string) =>
    createMarket(t.db, {
      status: 'settling',
      resolvedResult: result,
      judgementVersion: null,
      ...(title === undefined ? {} : { title }),
    });

  /** Holds a pool connection inside an open transaction, for lock tests. */
  async function holder() {
    const client = await t.db.$client.connect();
    await client.query('BEGIN');
    return {
      client,
      async end() {
        await client.query('ROLLBACK');
        client.release();
      },
    };
  }

  describe('settlementAudience (52-1 at the payout, ADR-0159 결과 6)', () => {
    it('reads a watcher who held nothing with no payout, before any payout too', async () => {
      const m = await settling('YES');
      const watcher = await member();
      await createWatch(t.db, { userId: watcher, marketId: m.id });
      expect(await settlementOf(m.id)).toEqual([{ userId: watcher, payoutCoin: null }]);
      expect(await settlementOf((await settling('NO')).id)).toEqual([]);
    });

    it('reads the holders the payout recorded with their payouts, 0 included, each once and sorted', async () => {
      const m = await settling('YES');
      const other = await settling('YES');
      const [yes, no, watcher, both, seller, resting, gone, elsewhere] = [
        await member(),
        await member(),
        await member(),
        await member(),
        await member(),
        await member(),
        await member(),
        await member(),
      ];
      // A pair mint of 2: YES to `yes` (paid 200), NO to `no` (a loser: paid 0, still a holder).
      await mintTestPairs(t.db, { marketId: m.id, yesHolderId: yes, noHolderId: no, qty: 2 });
      // A watcher who also holds: one recipient with the payout.
      await createWatch(t.db, { userId: both, marketId: m.id });
      await mintTestPairs(t.db, { marketId: m.id, yesHolderId: both, noHolderId: no, qty: 1 });
      await createWatch(t.db, { userId: watcher, marketId: m.id });
      // Sold out before the close: a qty-0 row the payout retires without a record.
      await createPosition(t.db, { userId: seller, marketId: m.id, outcome: 'YES', qty: 0 });
      // Resting orders only, expired at the close: no holding, no record.
      await createOrder(t.db, { marketId: m.id, userId: resting, status: 'expired' });
      // Watched and unwatched; another market's watcher and holder.
      await createWatch(t.db, { userId: gone, marketId: m.id });
      await t.db
        .delete(marketWatches)
        .where(and(eq(marketWatches.userId, gone), eq(marketWatches.marketId, m.id)));
      await createWatch(t.db, { userId: elsewhere, marketId: other.id });
      await mintTestPairs(t.db, {
        marketId: other.id,
        yesHolderId: elsewhere,
        noHolderId: no,
        qty: 1,
      });
      // The 운영 마켓메이커's holding is recorded too: in the read, skipped by the gate (53-5).
      const bot = await fundMarketMakerFunds(t.db, m.id, 1_000n);
      await mintTestPairs(t.db, { marketId: m.id, yesHolderId: bot, noHolderId: no, qty: 1 });

      // Before the payout: the watchers only (no record yet).
      expect(await settlementOf(m.id)).toEqual(
        [watcher, both].sort().map((userId) => ({ userId, payoutCoin: null })),
      );
      await pay(m.id);
      const audience = await settlementOf(m.id);
      const expected: SettlementRecipient[] = [
        { userId: yes, payoutCoin: 200n },
        { userId: no, payoutCoin: 0n },
        { userId: both, payoutCoin: 100n },
        { userId: watcher, payoutCoin: null },
        { userId: bot, payoutCoin: 100n },
      ].sort((a, b) => (a.userId < b.userId ? -1 : 1));
      expect(audience).toEqual(expected);
      for (const recipient of audience) {
        expect(recipient.payoutCoin === null || typeof recipient.payoutCoin === 'bigint').toBe(
          true,
        );
      }
      for (const out of [seller, resting, gone, elsewhere]) {
        expect(audience.map((r) => r.userId)).not.toContain(out);
      }
      // Byte order, as marketAudience's COLLATE "C".
      expect(audience.map((r) => r.userId)).toEqual(audience.map((r) => r.userId).sort());
    });

    it('sums a VOID holder of both outcomes into ONE recipient, exactly, as a bigint', async () => {
      const m = await settling('VOID');
      const [both, a, b] = [await member(10_000n), await member(10_000n), await member(10_000n)];
      await mintTestPairs(t.db, { marketId: m.id, yesHolderId: both, noHolderId: a, qty: 3 });
      await mintTestPairs(t.db, { marketId: m.id, yesHolderId: b, noHolderId: both, qty: 2 });
      await pay(m.id);
      const audience = await settlementOf(m.id);
      expect(audience.filter((r) => r.userId === both)).toEqual([
        // 50 × 3 YES + 50 × 2 NO: one notice, the sum (52-15 '지급액').
        { userId: both, payoutCoin: 250n },
      ]);
      expect(typeof audience.find((r) => r.userId === both)!.payoutCoin).toBe('bigint');
      expect(audience).toEqual(
        [
          { userId: both, payoutCoin: 250n },
          { userId: a, payoutCoin: 150n },
          { userId: b, payoutCoin: 100n },
        ].sort((x, y) => (x.userId < y.userId ? -1 : 1)),
      );
    });

    it('sees the payout’s own records inside the payout’s transaction', async () => {
      const m = await settling('NO');
      const [yes, no] = [await member(), await member()];
      await mintTestPairs(t.db, { marketId: m.id, yesHolderId: yes, noHolderId: no, qty: 1 });
      const inside = await t.db.transaction(async (tx) => {
        await settleMarketPositions(tx, m.id);
        return settlementAudience(tx, m.id);
      });
      expect(inside).toEqual(
        [
          { userId: yes, payoutCoin: 0n },
          { userId: no, payoutCoin: 100n },
        ].sort((a, b) => (a.userId < b.userId ? -1 : 1)),
      );
      // A rolled-back payout leaves nothing for the next read: no record, no holder.
      const m2 = await settling('NO');
      const [y2, n2] = [await member(), await member()];
      await mintTestPairs(t.db, { marketId: m2.id, yesHolderId: y2, noHolderId: n2, qty: 1 });
      await expect(
        t.db.transaction(async (tx) => {
          await settleMarketPositions(tx, m2.id);
          expect(await settlementAudience(tx, m2.id)).toHaveLength(2);
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      expect(await settlementOf(m2.id)).toEqual([]);
    });

    it('takes no row lock: watches, records, profiles and inboxes stay free while it is held open', async () => {
      const m = await settling('YES');
      const [watcher, yes, no] = [await member(), await member(), await member()];
      await createWatch(t.db, { userId: watcher, marketId: m.id });
      await mintTestPairs(t.db, { marketId: m.id, yesHolderId: yes, noHolderId: no, qty: 1 });
      await pay(m.id);
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let readDone!: () => void;
      const read = new Promise<void>((resolve) => (readDone = resolve));
      const reading = t.db.transaction(async (tx) => {
        const audience = await settlementAudience(tx, m.id);
        readDone();
        await released;
        return audience;
      });
      await read;
      const other = await holder();
      try {
        for (const [what, query, value] of [
          ['watches', 'SELECT 1 FROM market_watches WHERE market_id = $1 FOR UPDATE NOWAIT', m.id],
          ['profile', 'SELECT 1 FROM profiles WHERE user_id = $1 FOR UPDATE NOWAIT', watcher],
          ['inbox', 'SELECT 1 FROM notification_inboxes WHERE user_id = $1 FOR UPDATE NOWAIT', yes],
        ] as const) {
          await expect(other.client.query(query, [value]), what).resolves.toBeDefined();
        }
        // The records are append-only (INSERT/SELECT, ADR-0118): no app connection can row-lock
        // one at all, the read included (last: the refusal aborts this transaction).
        await expect(
          other.client.query(
            'SELECT 1 FROM position_settlements WHERE market_id = $1 FOR KEY SHARE NOWAIT',
            [m.id],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await other.end();
        release();
      }
      expect((await reading).map((r) => r.userId).sort()).toEqual([watcher, yes, no].sort());
    });
  });

  describe('the inputs through the write path (ADR-0157 결정 4의 7: never refused)', () => {
    it('J5: each holder its own payout (0 included), a watcher none, the bot skipped, a closed account absent; a reprocess is a duplicate', async () => {
      // A 120-code-point title of astral characters: 240 UTF-16 units, still stored and told.
      const title = '𝔸'.repeat(120);
      const m = await settling('VOID', title);
      const [both, a, watcher, closed] = [
        await member(10_000n),
        await member(10_000n),
        await member(),
        await member(),
      ];
      await mintTestPairs(t.db, { marketId: m.id, yesHolderId: both, noHolderId: a, qty: 1 });
      await mintTestPairs(t.db, { marketId: m.id, yesHolderId: a, noHolderId: both, qty: 1 });
      const bot = await fundMarketMakerFunds(t.db, m.id, 1_000n);
      await mintTestPairs(t.db, { marketId: m.id, yesHolderId: bot, noHolderId: a, qty: 2 });
      await createWatch(t.db, { userId: watcher, marketId: m.id });
      await createWatch(t.db, { userId: closed, marketId: m.id });
      await closeAccount(t.db, closed);
      await pay(m.id);
      const recipients = await settlementOf(m.id);
      // The closure ended its watch (53-5, 53-8), and a closed account cannot hold at the payout.
      expect(recipients.map((r) => r.userId)).not.toContain(closed);
      const finalized = { eventKey: marketEventKey(901), occurredAt: EVENT_AT };
      const inputs = settlementNotificationInputs(
        recipients,
        { slug: m.slug, title, status: 'settled' },
        { result: 'VOID', ...finalized },
      );
      const outcomes = await deliver(inputs);
      // The 운영 마켓메이커's recorded holding is in the read; the gate skips it (53-5).
      expect(Object.fromEntries(kinds(outcomes))).toEqual({
        [both]: 'created',
        [a]: 'created',
        [watcher]: 'created',
        [bot]: 'skipped',
      });
      expect(notifiedUserIds(outcomes).sort()).toEqual([both, a, watcher].sort());
      const paramsOf = async (userId: string) =>
        (await rowsOf(userId)).map((row) => ({ type: row.type, params: row.params }));
      // VOID: 50 per contract on both sides — a 지급, summed per member (52-15).
      expect(await paramsOf(both)).toEqual([
        {
          type: 'market_settled',
          params: { marketTitle: title, result: 'VOID', payoutCoin: '100' },
        },
      ]);
      expect(await paramsOf(a)).toEqual([
        {
          type: 'market_settled',
          params: { marketTitle: title, result: 'VOID', payoutCoin: '200' },
        },
      ]);
      expect(await paramsOf(watcher)).toEqual([
        {
          type: 'market_settled',
          params: { marketTitle: title, result: 'VOID', payoutCoin: null },
        },
      ]);
      const [row] = await rowsOf(watcher);
      expect(row).toMatchObject({
        category: 'market',
        target: { kind: 'market', slug: m.slug },
        mergeKey: null,
        eventCount: 1,
        occurredAt: EVENT_AT,
        readAt: null,
      });
      // The same event again (a retried run that got this far): every one a duplicate (53-4).
      expect(kinds(await deliver(inputs))).toEqual(
        kinds(outcomes).map(([userId, kind]) => [userId, kind === 'created' ? 'duplicate' : kind]),
      );
      expect(await rowsOf(both)).toHaveLength(1);
    });

    it('J5: a loser’s payout of 0 is written, never refused (the pitfall that would roll a payout back)', async () => {
      const m = await settling('YES');
      const [yes, no] = [await member(), await member()];
      await mintTestPairs(t.db, { marketId: m.id, yesHolderId: yes, noHolderId: no, qty: 2 });
      await pay(m.id);
      const outcomes = await deliver(
        settlementNotificationInputs(
          await settlementOf(m.id),
          { slug: m.slug, title: m.title, status: 'settled' },
          { result: 'YES', eventKey: marketEventKey(902), occurredAt: EVENT_AT },
        ),
      );
      expect(outcomes.map((o) => o.kind)).toEqual(['created', 'created']);
      expect((await rowsOf(no))[0]!.params).toEqual({
        marketTitle: m.title,
        result: 'YES',
        payoutCoin: '0',
      });
      expect((await rowsOf(yes))[0]!.params).toEqual({
        marketTitle: m.title,
        result: 'YES',
        payoutCoin: '200',
      });
    });

    it('J1: the first judgement’s result and deadline to the audience, the zone null when the market has none', async () => {
      const title = '𝔸'.repeat(120);
      const provisional = await createProvisionalMarket(t.db, {
        market: { title, judgementTimeZone: null },
        result: 'NO',
      });
      const { market, judgement, eventId } = provisional;
      const [watcher, holder2] = [await member(), await member()];
      await createWatch(t.db, { userId: watcher, marketId: market.id });
      await createPosition(t.db, { userId: holder2, marketId: market.id, outcome: 'YES', qty: 1 });
      const inputs = judgementNotificationInputs(await audienceOf(market.id), market, {
        kind: 'provisional',
        result: judgement.result,
        disputeDeadline: judgement.disputeDeadline,
        eventKey: marketEventKey(eventId),
        occurredAt: judgement.publishedAt,
      });
      expect(kinds(await deliver(inputs)).map(([, kind]) => kind)).toEqual(['created', 'created']);
      for (const userId of [watcher, holder2]) {
        const rows = await rowsOf(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          type: 'market_provisional_result',
          category: 'market',
          target: { kind: 'market', slug: market.slug },
          occurredAt: judgement.publishedAt,
          params: {
            marketTitle: title,
            result: 'NO',
            disputeDeadline: judgement.disputeDeadline.toISOString(),
            judgementTimeZone: null,
          },
        });
      }
      expect(await keysOf(watcher)).toEqual([`market_provisional_result market_event:${eventId}`]);
      // A re-sent approval would find the market PROVISIONAL and write nothing; the same inputs
      // again are duplicates all the same (53-4).
      expect(kinds(await deliver(inputs)).map(([, kind]) => kind)).toEqual([
        'duplicate',
        'duplicate',
      ]);
    });

    it('J2: the correction to the audience and the closure to each closed dispute’s submitter, in one call under one key', async () => {
      const provisional = await createProvisionalMarket(t.db, {
        market: { judgementTimeZone: 'America/New_York' },
        result: 'YES',
      });
      const marketId = provisional.market.id;
      const [both, onlyDisputed, watcher, accepted] = [
        await member(),
        await member(),
        await member(),
        await member(),
      ];
      // `both` disputes and watches; `onlyDisputed` neither watches nor holds; `accepted`'s
      // dispute stays accepted (answered by the correction) and gets nothing of it (52-14).
      await createWatch(t.db, { userId: both, marketId });
      await createWatch(t.db, { userId: watcher, marketId });
      await createDispute(t.db, { marketId, userId: both });
      await createDispute(t.db, { marketId, userId: onlyDisputed });
      const kept = await createDispute(t.db, { marketId, userId: accepted, status: 'accepted' });
      const corrected = await createCorrectedMarket(t.db, {
        marketId,
        result: 'NO',
        disputeIds: [kept.dispute.id],
      });
      expect(corrected.closedDisputes.map((d) => d.userId).sort()).toEqual(
        [both, onlyDisputed].sort(),
      );
      const deadline = corrected.market.disputeDeadline!;
      const eventKey = marketEventKey(corrected.eventId);
      const occurredAt = corrected.judgement.publishedAt;
      const inputs = [
        ...judgementNotificationInputs(await audienceOf(marketId), corrected.market, {
          kind: 'corrected',
          result: corrected.judgement.result,
          disputeDeadline: deadline,
          eventKey,
          occurredAt,
        }),
        ...disputeClosureNotificationInputs(corrected.closedDisputes, corrected.market, {
          disputeDeadline: deadline,
          eventKey,
          occurredAt,
        }),
      ];
      const outcomes = await deliver(inputs);
      expect(outcomes.every((o) => o.kind === 'created')).toBe(true);
      // One signal per member even when two types reached them.
      expect(notifiedUserIds(outcomes).sort()).toEqual([both, onlyDisputed, watcher].sort());
      const timed = {
        disputeDeadline: deadline.toISOString(),
        judgementTimeZone: 'America/New_York',
      };
      const corrected2 = { marketTitle: corrected.market.title, result: 'NO', ...timed };
      const closure = { marketTitle: corrected.market.title, ...timed };
      expect((await rowsOf(both)).map((r) => [r.type, r.params])).toEqual([
        ['market_dispute_closed_by_correction', closure],
        ['market_judgement_corrected', corrected2],
      ]);
      expect(await keysOf(both)).toEqual([
        `market_dispute_closed_by_correction ${eventKey}`,
        `market_judgement_corrected ${eventKey}`,
      ]);
      expect((await rowsOf(onlyDisputed)).map((r) => [r.type, r.params])).toEqual([
        ['market_dispute_closed_by_correction', closure],
      ]);
      expect((await rowsOf(watcher)).map((r) => [r.type, r.params])).toEqual([
        ['market_judgement_corrected', corrected2],
      ]);
      expect(await rowsOf(accepted)).toEqual([]);
      // Reprocessing the event: duplicates only.
      expect((await deliver(inputs)).every((o) => o.kind === 'duplicate')).toBe(true);
    });

    it('J3: each decision is its own notice — a re-decision after reopen is a new admin action, not a duplicate', async () => {
      const provisional = await createProvisionalMarket(t.db);
      const { market } = provisional;
      const submitter = await member();
      const reason = '가'.repeat(NOTIFICATION_PARAM_STRING_MAX);
      const { dispute } = await createDispute(t.db, {
        marketId: market.id,
        userId: submitter,
        status: 'accepted',
        decisionReason: reason,
      });
      const first = adminActionEventKey(randomUUID());
      const accepted = disputeDecisionNotificationInput(dispute, market, {
        eventKey: first,
        occurredAt: EVENT_AT,
      });
      expect(kinds(await deliver([accepted]))).toEqual([[submitter, 'created']]);
      // Sent back to pending by a correction's 반려·철회 (silent, 188-6), then dismissed again.
      const second = adminActionEventKey(randomUUID());
      const dismissed = disputeDecisionNotificationInput(
        { ...dispute, status: 'dismissed', decisionReason: '다시 검토했습니다.' },
        market,
        { eventKey: second, occurredAt: new Date(EVENT_AT.getTime() + 1000) },
      );
      expect(kinds(await deliver([dismissed]))).toEqual([[submitter, 'created']]);
      expect(kinds(await deliver([accepted, dismissed]))).toEqual([
        [submitter, 'duplicate'],
        [submitter, 'duplicate'],
      ]);
      expect((await rowsOf(submitter)).map((r) => r.params)).toEqual(
        expect.arrayContaining([
          { marketTitle: market.title, decision: 'accepted', reason },
          { marketTitle: market.title, decision: 'dismissed', reason: '다시 검토했습니다.' },
        ]),
      );
      expect(await rowsOf(submitter)).toHaveLength(2);
    });

    it('J4: a delay record’s public reason, next review time and the market’s zone', async () => {
      const now = Date.now();
      const closed = await createMarket(t.db, {
        status: 'closed',
        closeAt: new Date(now - 2 * DAY_MS),
        eventDeadline: new Date(now - 2 * DAY_MS),
        scheduledJudgementAt: new Date(now - HOUR_MS),
        judgementTimeZone: 'America/New_York',
      });
      const watcher = await member();
      await createWatch(t.db, { userId: watcher, marketId: closed.id });
      const reason = '가'.repeat(NOTIFICATION_PARAM_STRING_MAX);
      const { delay, eventId } = await createJudgementDelay(t.db, {
        marketId: closed.id,
        reason,
      });
      const row = await marketRow(closed.id);
      const inputs = judgementNotificationInputs(await audienceOf(closed.id), row, {
        kind: 'delayed',
        reason: delay.reason,
        nextReviewAt: delay.nextReviewAt,
        eventKey: marketEventKey(eventId),
        occurredAt: delay.recordedAt,
      });
      expect(kinds(await deliver(inputs))).toEqual([[watcher, 'created']]);
      expect((await rowsOf(watcher)).map((r) => [r.type, r.params, r.occurredAt])).toEqual([
        [
          'market_judgement_delayed',
          {
            marketTitle: row.title,
            reason,
            nextReviewAt: delay.nextReviewAt.toISOString(),
            judgementTimeZone: 'America/New_York',
          },
          delay.recordedAt,
        ],
      ]);
    });

    it('takes a zone the column may hold but the entry check would refuse: an empty and an unknown one', async () => {
      for (const judgementTimeZone of ['', 'Mars/Olympus_Mons']) {
        const provisional = await createProvisionalMarket(t.db);
        await t.db
          .update(markets)
          .set({ judgementTimeZone })
          .where(eq(markets.id, provisional.market.id));
        const market = await marketRow(provisional.market.id);
        const watcher = await member();
        const outcomes = await deliver(
          judgementNotificationInputs([watcher], market, {
            kind: 'provisional',
            result: provisional.judgement.result,
            disputeDeadline: provisional.judgement.disputeDeadline,
            eventKey: marketEventKey(provisional.eventId),
            occurredAt: EVENT_AT,
          }),
        );
        expect(
          outcomes.map((o) => o.kind),
          judgementTimeZone,
        ).toEqual(['created']);
        expect((await rowsOf(watcher))[0]!.params.judgementTimeZone).toBe(judgementTimeZone);
      }
    });
  });
});

// ---- static -------------------------------------------------------------------------------------

const ROOT = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

/**
 * Every production source of every app and package (market-notifications.test.ts's scan),
 * relative to the repository root: no test, and no fixture under `packages/db/src/test/`.
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

/** A CALL of a core (it takes the transaction first), not its definition. */
const callOf = (name: string) => new RegExp(`\\b${name}\\(\\s*tx\\s*[,)]`);

const WRITES = /\bcreateNotifications\(/;
const BUILDS_JUDGEMENT = /\bjudgementNotificationInputs\(/;
const BUILDS_CLOSURE = /\bdisputeClosureNotificationInputs\(/;
const BUILDS_DECISION = /\bdisputeDecisionNotificationInput\(/;
const BUILDS_SETTLEMENT = /\bsettlementNotificationInputs\(/;
const READS_SETTLEMENT = /\bsettlementAudience\(/;
/** Any of #188's four builders or the settlement's audience read. */
const ANY_188 =
  /\b(judgementNotificationInputs|disputeClosureNotificationInputs|disputeDecisionNotificationInput|settlementNotificationInputs|settlementAudience)\(/;

/**
 * The cores whose events notify (#188), each with its production callers and what every caller
 * holds: its builders and the event's one `createNotifications` call. A new caller fails the pin
 * until it is listed (and builds); a stale one fails too.
 */
const PRODUCERS: Record<
  string,
  { callers: readonly string[]; holds: readonly RegExp[]; event: string }
> = {
  approveMarketJudgement: {
    callers: ['apps/api/src/markets/market-judgement.service.ts'],
    holds: [BUILDS_JUDGEMENT, WRITES],
    event: 'J1 잠정 결과 (52-12)',
  },
  correctMarketJudgement: {
    callers: ['apps/api/src/markets/market-judgement.service.ts'],
    holds: [BUILDS_JUDGEMENT, BUILDS_CLOSURE, WRITES],
    event: 'J2 판정 정정 and 정정으로 종결, one call under one key (52-14, 188-1)',
  },
  decideMarketDispute: {
    callers: ['apps/api/src/markets/market-dispute.service.ts'],
    holds: [BUILDS_DECISION, /\badminActionEventKey\(/, WRITES],
    event: 'J3 기각·수용, keyed by the decision’s admin action (52-14, 188-3)',
  },
  recordJudgementDelay: {
    callers: ['apps/api/src/markets/market-judgement-delay.service.ts'],
    holds: [BUILDS_JUDGEMENT, /\breadPublicJudgementDelay\(/, WRITES],
    event: 'J4 판정 지연, only the first of its episode or a changed one (52-11, 188-5)',
  },
  settleMarketPositions: {
    // The payout core moved to @buddha/db for the operator retry (#145, ADR-0163).
    callers: ['packages/db/src/market-finalize.ts'],
    holds: [READS_SETTLEMENT, BUILDS_SETTLEMENT, WRITES],
    event: 'J5 지급 완료, all or nothing with the payout (52-12, 188-2)',
  },
};

/**
 * The payout core's production callers (#145, ADR-0163; 145-7 "같은 검사"): `settleSettlingMarket`
 * is run by the worker's finalize and by `retrySettlingMarket` (the operator's 정산 다시 시도, in
 * the same file), and `retrySettlingMarket` by the API's retry service alone. Neither caller
 * builds or writes a notice of its own: J5 stays inside the core, last in its transaction.
 */
const PAYOUT_CORE_CALLERS: Record<string, readonly string[]> = {
  settleSettlingMarket: [
    'apps/worker/src/jobs/market-finalize.ts',
    'packages/db/src/market-finalize.ts',
  ],
  retrySettlingMarket: ['apps/api/src/operations/settlement-retry.service.ts'],
};

/**
 * The cores whose events never notify, with their production callers and why. The pin is
 * file-level: a silent core in a file that also builds a #188 notice is proven silent by that
 * file's API tests (`provenBy: 'api tests'`); only a file that builds none is proven here.
 */
const SILENT: Record<
  string,
  { callers: readonly string[]; reason: string; provenBy: 'this pin' | 'api tests' }
> = {
  resolveProvisionalMarket: {
    callers: ['apps/worker/src/jobs/market-resolve.ts'],
    reason: '결과 확정 is silent (52-12): the final settlement tells at 지급 완료',
    provenBy: 'this pin',
  },
  reopenAcceptedDisputes: {
    callers: ['apps/api/src/markets/market-judgement.service.ts'],
    reason:
      'accepted → pending on a correction’s 반려·철회 and #143’s conflict retraction (188-6); the file builds J1/J2',
    provenBy: 'api tests',
  },
  setCorrectionPending: {
    callers: ['apps/api/src/markets/market-judgement.service.ts'],
    reason:
      'a correction’s registration, 반려 and 철회 (52-13: no 보류 notice; 188-6); the file builds J1/J2',
    provenBy: 'api tests',
  },
  submitMarketDispute: {
    callers: ['apps/api/src/markets/market-dispute.service.ts'],
    reason: 'the member’s own act; the file builds J3',
    provenBy: 'api tests',
  },
  retractMarketDispute: {
    callers: ['apps/api/src/markets/market-dispute.service.ts'],
    reason: 'the member’s own act; the file builds J3',
    provenBy: 'api tests',
  },
};

describe('who tells of a judgement or a payout (#188, static)', () => {
  const files = sourceFiles();
  const callersOf = (name: string) => files.filter((file) => callOf(name).test(read(file))).sort();

  it('reads the source tree and matches call sites only', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'packages/db/src/market-judgement.ts',
        'packages/db/src/judgement-notifications.ts',
      ]),
    );
    expect(files.some((file) => file.startsWith('packages/db/src/test/'))).toBe(false);
    for (const [name, text] of [
      ['approveMarketJudgement', 'await approveMarketJudgement(tx, {'],
      ['correctMarketJudgement', 'const result = await correctMarketJudgement(\n      tx,\n'],
      ['settleMarketPositions', 'settleMarketPositions(tx, marketId)'],
      ['resolveProvisionalMarket', 'resolveProvisionalMarket(tx)'],
    ] as const) {
      expect(callOf(name).test(text), text).toBe(true);
    }
    for (const [name, text] of [
      ['approveMarketJudgement', 'export async function approveMarketJudgement(\n  tx: Executor,'],
      ['recordJudgementDelay', 'recordJudgementDelay(trx, input)'],
      ['decideMarketDispute', 'type DecideMarketDisputeInput = { tx: 1 }'],
      ['settleMarketPositions', 'settleMarketPositionsLater(tx, id)'],
    ] as const) {
      expect(callOf(name).test(text), text).toBe(false);
    }
    expect(ANY_188.test('settlementAudience(tx, marketId)')).toBe(true);
    expect(ANY_188.test('export async function settlementAudience(\n  tx: Tx,')).toBe(true);
    expect(ANY_188.test('type SettlementRecipient')).toBe(false);
  });

  it('builds and writes the notice in every production caller of a notifying core (J1–J5)', () => {
    const problems: string[] = [];
    for (const [name, producer] of Object.entries(PRODUCERS)) {
      const callers = callersOf(name);
      if (JSON.stringify(callers) !== JSON.stringify([...producer.callers].sort())) {
        problems.push(`${name}: called by ${callers.join(', ')}`);
      }
      for (const file of callers) {
        for (const pattern of producer.holds) {
          if (!pattern.test(read(file))) problems.push(`${file} (${name}): no ${pattern.source}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('maps every silent core’s callers with a reason; the file that builds none is proven silent here', () => {
    const problems: string[] = [];
    for (const [name, silent] of Object.entries(SILENT)) {
      const callers = callersOf(name);
      if (JSON.stringify(callers) !== JSON.stringify([...silent.callers].sort())) {
        problems.push(`${name}: called by ${callers.join(', ')}`);
      }
      expect(silent.reason.trim(), name).not.toBe('');
      for (const file of callers) {
        const source = read(file);
        if (silent.provenBy === 'this pin') {
          if (ANY_188.test(source)) problems.push(`${file} (${name}): builds a #188 notice`);
          if (WRITES.test(source)) problems.push(`${file} (${name}): writes a notification`);
          if (/\bmarketAudience\(/.test(source)) problems.push(`${file} (${name}): reads one`);
        } else if (!ANY_188.test(source)) {
          // A file that builds nothing at all would be proven here instead: say so.
          problems.push(`${file} (${name}): builds no #188 notice — prove it by this pin`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('writes the correction and the delay events in their cores only (J2 and J4 change no status)', () => {
    // `correctMarketJudgement` writes its event without `transitionMarket`, so only this pin —
    // not #54's TRANSITION_CALL map — sees J2; a delay record changes no status either.
    for (const [type, writer] of [
      ['judgement_corrected', 'packages/db/src/market-judgement.ts'],
      ['judgement_delay_recorded', 'packages/db/src/market-judgement-delay.ts'],
    ] as const) {
      const writers = files.filter((file) => new RegExp(`\\btype:\\s*'${type}'`).test(read(file)));
      expect(writers, type).toEqual([writer]);
    }
  });

  it('notifies of the payout from the shared core only: no confirmation, deadline or time-driven notice (52-12, 52-13, AC 5)', () => {
    const worker = files.filter((file) => file.startsWith('apps/worker/src/'));
    expect(worker.length).toBeGreaterThan(0);
    // J5's builder is in packages/db/src/market-finalize.ts, run by the worker's finalize and
    // the API's retry only (#145, ADR-0163): the worker itself builds and writes no notice.
    expect(
      worker.filter((file) => ANY_188.test(read(file)) || WRITES.test(read(file))).sort(),
    ).toEqual([]);
    expect(
      files
        .filter((file) => file !== 'packages/db/src/judgement-notifications.ts')
        .filter((file) => BUILDS_SETTLEMENT.test(read(file)) || READS_SETTLEMENT.test(read(file))),
    ).toEqual(['packages/db/src/market-finalize.ts']);
    const problems: string[] = [];
    for (const [name, expected] of Object.entries(PAYOUT_CORE_CALLERS)) {
      const callers = callersOf(name);
      if (JSON.stringify(callers) !== JSON.stringify([...expected].sort())) {
        problems.push(`${name}: called by ${callers.join(', ')}`);
      }
      for (const file of callers) {
        if (file === 'packages/db/src/market-finalize.ts') continue;
        if (ANY_188.test(read(file)) || WRITES.test(read(file))) {
          problems.push(`${file} (${name}): builds or writes a notice beside the core's`);
        }
      }
    }
    expect(problems).toEqual([]);
    // #54's B′ delivery is the worker's one other notice path (its reconciliation run).
    expect(
      worker
        .filter((file) =>
          /\b(marketAudience|marketNotificationInputs|deliverReconciliationNotices)\(/.test(
            read(file),
          ),
        )
        .sort(),
    ).toEqual(['apps/worker/src/jobs/reconciliation.ts']);
  });

  it('settles a market in one place, after the reconciliation (#145, ADR-0163; ADR-0118 결정 6)', () => {
    // The one `to: 'settled'` transition is the shared core's, and it follows the final
    // reconciliation in the same function: no path (the operator retry included) reaches
    // SETTLED without the books checked.
    const SETTLED = /\bto:\s*'settled'\s*,/;
    expect(files.filter((file) => SETTLED.test(read(file)))).toEqual([
      'packages/db/src/market-finalize.ts',
    ]);
    const core = read('packages/db/src/market-finalize.ts');
    const start = core.indexOf('export async function settleSettlingMarket(');
    const end = core.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    const body = core.slice(start, end);
    const settledAt = body.search(SETTLED);
    expect(settledAt).toBeGreaterThan(-1);
    expect(body.lastIndexOf('reconcileMarketSettlement(', settledAt)).toBeGreaterThan(-1);
    expect(core.slice(end).search(SETTLED)).toBe(-1);
    expect(SETTLED.test("    to: 'settled',")).toBe(true);
    expect(SETTLED.test("the one `to: 'settled'` transition")).toBe(false);
  });

  it('keeps the final settlement’s notices in the payout’s transaction: no savepoint, no second delivery (188-2)', () => {
    const builders = read('packages/db/src/judgement-notifications.ts');
    expect(builders).not.toMatch(/\.transaction\(/);
    expect(builders).not.toMatch(/\bcreateNotifications\(/);
    expect(files.filter((file) => /\bdeliverSettlementNotices\b/.test(read(file)))).toEqual([]);
  });
});
