import {
  MARKET_SUPPLEMENT_APPROVAL_KIND,
  RULE_VERSION_ITEMS,
  marketRuleContentSchema,
} from '@buddha/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RULE_SUPPLEMENT_SETTING,
  allowRuleSupplement,
  insertRuleVersion,
  readRuleContent,
  readRuleSources,
  ruleContentOf,
} from './market-rules-content.js';
import {
  approvalRequests,
  marketEvents,
  marketRuleVersions,
  marketSources,
  markets,
} from './schema/index.js';
import {
  createMarket,
  createOpenedMarket,
  createRuleSupplement,
  createSupplementRequest,
  createSupplementedMarket,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { lockMarket } from './tx-helpers.js';

/** The node-postgres SQLSTATE of a refusal, wrapped by drizzle or bare. */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

const MINUTE_MS = 60_000;

describe.skipIf(!hasTestDb())('rule versions (#80, docker test profile)', () => {
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

  const rowOf = async (marketId: string) => {
    const [row] = await t.db.select().from(markets).where(eq(markets.id, marketId));
    return row!;
  };

  /** A market's rule versions, v1 first. */
  const versionsOf = (marketId: string) =>
    t.db
      .select()
      .from(marketRuleVersions)
      .where(eq(marketRuleVersions.marketId, marketId))
      .orderBy(asc(marketRuleVersions.version));

  const eventsOf = (marketId: string) =>
    t.db
      .select()
      .from(marketEvents)
      .where(eq(marketEvents.marketId, marketId))
      .orderBy(asc(marketEvents.id));

  describe('readRuleContent', () => {
    it('reads the version items from the row and the sources, in priority order', async () => {
      const market = await createMarket(t.db, {
        status: 'draft',
        primarySource: { name: '한국은행', url: 'https://www.bok.or.kr' },
        scheduledAnnouncementAt: new Date('2026-12-01T09:00:00.000Z'),
        closeAt: new Date('2026-12-01T08:00:00.000Z'),
      });
      // A gap at priority 1, as only a writer outside the API leaves: the fallbacks still read as
      // the ordered list.
      await t.db.insert(marketSources).values([
        { marketId: market.id, priority: 3, name: '셋째', url: 'https://example.org/3' },
        { marketId: market.id, priority: 2, name: '둘째', url: '' },
      ]);
      const content = await readRuleContent(t.db, market.id);
      expect(content).toEqual({
        title: market.title,
        description: market.description,
        yesCondition: market.yesCondition,
        noCondition: market.noCondition,
        eventDeadline: market.eventDeadline!.toISOString(),
        primarySource: { name: '한국은행', url: 'https://www.bok.or.kr' },
        fallbackSources: [
          { name: '둘째', url: '' },
          { name: '셋째', url: 'https://example.org/3' },
        ],
        fallbackCondition: '',
        longDelayDays: 14,
        delayHandling: market.delayHandling,
        scheduledOpenAt: market.scheduledOpenAt!.toISOString(),
        closeAt: '2026-12-01T08:00:00.000Z',
        scheduledAnnouncementAt: '2026-12-01T09:00:00.000Z',
        scheduledJudgementAt: market.scheduledJudgementAt!.toISOString(),
        judgementTimeZone: market.judgementTimeZone,
      });
      // In RULE_VERSION_ITEMS order, and the shared schema's shape.
      expect(Object.keys(content)).toEqual([...RULE_VERSION_ITEMS]);
      expect(marketRuleContentSchema.parse(content)).toEqual(content);
      expect(ruleContentOf(market, await readRuleSources(t.db, market.id))).toEqual(content);
    });

    it('keeps blank items blank, and throws for a market that does not exist', async () => {
      const market = await createMarket(t.db, { blankRuleItems: true, blankTimes: true });
      expect(await readRuleContent(t.db, market.id)).toEqual({
        title: market.title,
        description: null,
        yesCondition: '',
        noCondition: '',
        eventDeadline: null,
        primarySource: null,
        fallbackSources: [],
        fallbackCondition: '',
        longDelayDays: null,
        delayHandling: '',
        scheduledOpenAt: null,
        closeAt: market.closeAt.toISOString(),
        scheduledAnnouncementAt: null,
        scheduledJudgementAt: null,
        judgementTimeZone: null,
      });
      const unknown = '00000000-0000-4000-8000-000000000000';
      await expect(readRuleContent(t.db, unknown)).rejects.toThrow(`Market ${unknown} not found`);
    });
  });

  describe('allowRuleSupplement', () => {
    const setting = async (executor: Pick<TestDb['db'], 'execute'>) =>
      (
        await executor.execute<{ value: string | null }>(
          sql`SELECT current_setting(${RULE_SUPPLEMENT_SETTING}, true) AS value`,
        )
      ).rows[0]!.value;

    it('names the market in the transaction only, by the id’s canonical text', async () => {
      const market = await createMarket(t.db);
      await t.db.transaction(async (tx) => {
        await allowRuleSupplement(tx, market.id.toUpperCase());
        expect(await setting(tx)).toBe(market.id);
      });
      // Gone at COMMIT, on whichever pooled connection comes next ('' once the name was set).
      for (let index = 0; index < 5; index++) {
        expect([null, '']).toContain(await setting(t.db));
      }
      await expect(
        t.db.transaction((tx) => allowRuleSupplement(tx, 'not-a-uuid')),
      ).rejects.toSatisfy((error) => sqlState(error) === '22P02');
    });
  });

  describe('insertRuleVersion', () => {
    it('refuses a version the market is not at, and v1 and a supplement out of place', async () => {
      const { market } = await createOpenedMarket(t.db);
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: approver } = await createUser(t.db, { role: 'admin' });
      const request = await createSupplementRequest(t.db, {
        marketId: market.id,
        requestedBy: requester.id,
      });
      const supplement = {
        approvalId: request.id,
        requestedBy: requester.id,
        reason: '사유',
        settlementImpact: '검토',
      };
      const insert = (version: number, withSupplement: boolean) =>
        t.db.transaction((tx) =>
          insertRuleVersion(tx, {
            marketId: market.id,
            version,
            createdAt: new Date(),
            createdBy: approver.id,
            supplement: withSupplement ? supplement : null,
          }),
        );
      await expect(insert(1, true)).rejects.toThrow("is the open's: it has no supplement");
      await expect(insert(2, false)).rejects.toThrow('needs its supplement');
      // The market is at v1: a v2 comes after the market's write.
      await expect(insert(2, true)).rejects.toThrow(
        'is at rule version 1, not 2: write the market first',
      );
      await expect(insert(1, false)).rejects.toSatisfy((error) => sqlState(error) === '23505');
      expect(await versionsOf(market.id)).toHaveLength(1);

      // A market at v2 with no v1 (written outside the open): nothing to compare with.
      const bare = await createMarket(t.db);
      await t.db.update(markets).set({ ruleVersion: 2 }).where(eq(markets.id, bare.id));
      await expect(
        t.db.transaction((tx) =>
          insertRuleVersion(tx, {
            marketId: bare.id,
            version: 2,
            createdAt: new Date(),
            createdBy: approver.id,
            supplement,
          }),
        ),
      ).rejects.toThrow(`Market ${bare.id} has no rule version 1`);
    });

    it('records the full text read back and the items changed from the version before', async () => {
      const { market } = await createOpenedMarket(t.db);
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: approver } = await createUser(t.db, { role: 'admin' });
      const request = await createSupplementRequest(t.db, {
        marketId: market.id,
        requestedBy: requester.id,
      });
      const supplement = {
        approvalId: request.id,
        requestedBy: requester.id,
        reason: '오탈자 수정',
        settlementImpact: '정산 영향 없음',
      };
      const at = new Date(market.updatedAt.getTime() + MINUTE_MS);
      const closeAt = new Date(market.closeAt.getTime() + MINUTE_MS);
      const write = (set: Partial<typeof markets.$inferInsert>, sources: boolean) =>
        t.db.transaction(async (tx) => {
          await lockMarket(tx, market.id);
          await allowRuleSupplement(tx, market.id);
          await tx
            .update(markets)
            .set({ ...set, ruleVersion: 2 })
            .where(eq(markets.id, market.id));
          if (sources) {
            await tx.insert(marketSources).values({
              marketId: market.id,
              priority: 1,
              name: '대체',
              url: 'https://example.org',
            });
          }
          return insertRuleVersion(tx, {
            marketId: market.id,
            version: 2,
            createdAt: at,
            createdBy: approver.id,
            supplement,
          });
        });
      // The title with spaces around it is the same title: nothing changes, nothing is written.
      await expect(write({ title: ` ${market.title} ` }, false)).rejects.toThrow(
        `Rule version 2 of market ${market.id} changes nothing`,
      );
      expect(await rowOf(market.id)).toEqual(market);

      const row = await write({ title: '보충한 제목', closeAt }, true);
      const [v1, v2] = await versionsOf(market.id);
      expect(row).toEqual(v2);
      expect(v2).toEqual({
        marketId: market.id,
        version: 2,
        content: {
          ...v1!.content,
          title: '보충한 제목',
          fallbackSources: [{ name: '대체', url: 'https://example.org' }],
          closeAt: closeAt.toISOString(),
        },
        // RULE_VERSION_ITEMS order, whatever order they were written in.
        changedItems: ['title', 'fallbackSources', 'closeAt'],
        reason: '오탈자 수정',
        settlementImpact: '정산 영향 없음',
        approvalId: request.id,
        requestedBy: requester.id,
        createdBy: approver.id,
        createdAt: at,
      });
      expect(v2!.content).toEqual(await readRuleContent(t.db, market.id));
    });
  });

  describe('the supplement factories', () => {
    it('createSupplementRequest asks for a supplement and changes nothing', async () => {
      const { market } = await createOpenedMarket(t.db);
      const events = await eventsOf(market.id);
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const request = await createSupplementRequest(t.db, {
        marketId: market.id,
        requestedBy: requester.id,
        changes: { title: '  보충한 제목  ', scheduledAnnouncementAt: null },
        reason: '제목 보충',
        settlementImpact: '뜻이 같다',
      });
      // Pending, about the market, against its current version, the changes as the body parses
      // them (trimmed), the supplement's reason the request's.
      expect(request).toMatchObject({
        kind: MARKET_SUPPLEMENT_APPROVAL_KIND,
        targetType: 'market',
        targetId: market.id,
        payload: {
          baseVersion: 1,
          changes: { title: '보충한 제목', scheduledAnnouncementAt: null },
          settlementImpact: '뜻이 같다',
        },
        requestedBy: requester.id,
        requestReason: '제목 보충',
        status: 'pending',
        decidedBy: null,
      });
      expect(await rowOf(market.id)).toEqual(market);
      expect(await eventsOf(market.id)).toEqual(events);
      expect(await versionsOf(market.id)).toHaveLength(1);

      // By default a new 배경 by a fresh admin; a 반려 or a 철회 instead; a stale base as given.
      const plain = await createSupplementRequest(t.db, { marketId: market.id });
      expect(plain.payload).toMatchObject({
        baseVersion: 1,
        changes: { description: expect.stringContaining('보충한 배경') as unknown },
      });
      expect(plain.requestedBy).not.toBe(requester.id);
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      const rejected = await createSupplementRequest(t.db, {
        marketId: market.id,
        rejected: { by: decider.id, reason: '의미가 바뀐다' },
      });
      expect(rejected).toMatchObject({
        status: 'rejected',
        decidedBy: decider.id,
        decisionReason: '의미가 바뀐다',
      });
      const retracted = await createSupplementRequest(t.db, {
        marketId: market.id,
        retracted: {},
      });
      expect(retracted).toMatchObject({ status: 'retracted', decidedBy: null });
      const stale = await createSupplementRequest(t.db, { marketId: market.id, baseVersion: 7 });
      expect(stale.payload).toMatchObject({ baseVersion: 7 });

      // Not on a market with no version, and not with a change no supplement makes.
      const unversioned = await createMarket(t.db);
      await expect(createSupplementRequest(t.db, { marketId: unversioned.id })).rejects.toThrow(
        'the market has no rule version',
      );
      await expect(
        createSupplementRequest(t.db, {
          marketId: market.id,
          changes: { scheduledJudgementAt: null } as never,
        }),
      ).rejects.toThrow('not a supplement item: scheduledJudgementAt');
    });

    it('createRuleSupplement writes the approval as the route leaves it: text, sources, version, event', async () => {
      const { market } = await createOpenedMarket(t.db);
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: approver } = await createUser(t.db, { role: 'admin' });
      const closeAt = new Date(market.closeAt.getTime() + 60 * MINUTE_MS);
      const fallbackSources = [{ name: '대체 출처', url: 'https://example.org/fallback' }];
      const {
        market: after,
        request,
        version,
      } = await createRuleSupplement(t.db, {
        marketId: market.id,
        requestedBy: requester.id,
        approvedBy: approver.id,
        changes: {
          title: '보충한 제목',
          closeAt: closeAt.toISOString(),
          fallbackSources,
          fallbackCondition: '1차 출처가 발표하지 않으면 대체 출처를 본다.',
        },
        reason: '마감 연장과 대체 출처',
        settlementImpact: '판정 기준이 같다',
        approvalReason: '확인함',
      });
      // The request, approved by the other admin a millisecond after it was made.
      expect(request).toMatchObject({
        kind: MARKET_SUPPLEMENT_APPROVAL_KIND,
        targetId: market.id,
        payload: { baseVersion: 1, settlementImpact: '판정 기준이 같다' },
        requestedBy: requester.id,
        requestReason: '마감 연장과 대체 출처',
        status: 'approved',
        decidedBy: approver.id,
        decisionReason: '확인함',
      });
      const at = request.decidedAt!;
      expect(at.getTime() - request.requestedAt.getTime()).toBe(1);
      expect(request.requestedAt.getTime()).toBeGreaterThan(market.updatedAt.getTime());
      // The market's new text at version 2, its status and ordering key untouched.
      expect(after).toEqual({
        ...market,
        title: '보충한 제목',
        closeAt,
        fallbackCondition: '1차 출처가 발표하지 않으면 대체 출처를 본다.',
        ruleVersion: 2,
        updatedAt: at,
      });
      expect(await rowOf(market.id)).toEqual(after);
      expect((await readRuleSources(t.db, market.id)).fallbackSources).toEqual(fallbackSources);
      // The version: the text read back, what changed, the reason, the review, who and when.
      expect(version).toMatchObject({
        version: 2,
        content: await readRuleContent(t.db, market.id),
        changedItems: ['title', 'fallbackSources', 'fallbackCondition', 'closeAt'],
        reason: '마감 연장과 대체 출처',
        settlementImpact: '판정 기준이 같다',
        approvalId: request.id,
        requestedBy: requester.id,
        createdBy: approver.id,
        createdAt: at,
      });
      expect(await versionsOf(market.id)).toEqual([
        expect.objectContaining({ version: 1 }),
        version,
      ]);
      // One `rules_supplemented` event, by the approver, with no status.
      expect((await eventsOf(market.id)).at(-1)).toMatchObject({
        type: 'rules_supplemented',
        actorId: approver.id,
        fromStatus: null,
        toStatus: null,
        payload: {
          version: 2,
          approvalId: request.id,
          items: ['title', 'fallbackSources', 'fallbackCondition', 'closeAt'],
          reason: '마감 연장과 대체 출처',
          requestedBy: requester.id,
        },
        createdAt: at,
      });
      expect(after.statusEventId).toBe(market.statusEventId);
    });

    it('createRuleSupplement throws, writing nothing, where the route would refuse', async () => {
      const { market } = await createOpenedMarket(t.db);
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const count = async () => (await t.db.select().from(approvalRequests)).length;
      const requests = await count();
      await expect(
        createRuleSupplement(t.db, {
          marketId: market.id,
          requestedBy: admin.id,
          approvedBy: admin.id,
        }),
      ).rejects.toThrow('the requester never approves the supplement');
      // A change to what the market already says: no version, and the request is not left behind.
      await expect(
        createRuleSupplement(t.db, { marketId: market.id, changes: { title: market.title } }),
      ).rejects.toThrow('changes nothing');
      const unversioned = await createMarket(t.db);
      await expect(createRuleSupplement(t.db, { marketId: unversioned.id })).rejects.toThrow(
        'the market has no rule version',
      );
      expect(await count()).toBe(requests);
      expect(await rowOf(market.id)).toEqual(market);
      expect(await versionsOf(market.id)).toHaveLength(1);
    });

    it('createSupplementedMarket approves each supplement in turn: v1, v2, v3', async () => {
      const { market, request, supplements, versions } = await createSupplementedMarket(t.db, {
        supplements: [
          { changes: { description: '첫 보충' } },
          { changes: { description: '두 번째 보충', judgementTimeZone: 'UTC' } },
        ],
      });
      expect(request.status).toBe('approved');
      expect(market.ruleVersion).toBe(3);
      expect(market.description).toBe('두 번째 보충');
      expect(versions.map((row) => [row.version, row.changedItems])).toEqual([
        [1, []],
        [2, ['description']],
        [3, ['description', 'judgementTimeZone']],
      ]);
      expect(supplements.map((supplement) => supplement.version)).toEqual(versions.slice(1));
      // Each begins after the one before.
      expect(versions[1]!.createdAt.getTime()).toBeGreaterThan(versions[0]!.createdAt.getTime());
      expect(versions[2]!.createdAt.getTime()).toBeGreaterThan(versions[1]!.createdAt.getTime());
      expect(versions).toEqual(await versionsOf(market.id));
      expect((await eventsOf(market.id)).map((event) => event.type)).toEqual([
        'submitted',
        'approved',
        'opened',
        'rules_supplemented',
        'rules_supplemented',
      ]);

      // By default, one: a new 배경.
      const plain = await createSupplementedMarket(t.db);
      expect(plain.versions.map((row) => row.changedItems)).toEqual([[], ['description']]);
      expect(
        await t.db
          .select({ id: marketRuleVersions.version })
          .from(marketRuleVersions)
          .where(eq(marketRuleVersions.marketId, plain.market.id)),
      ).toHaveLength(2);
    });
  });
});
