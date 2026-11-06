/**
 * The market times (#22, ADR-0098; ADR-0093 decision 2 #172 items 11–14, owner answers 2026-10-31
 * A1 and A2) through the admin routes against the docker `test` profile: every time written as
 * entered and read back, the zone as given; the order rules refused on entry naming both ends in
 * whole minutes, the sent end first; the lead close never refused on a draft, named by the
 * open-items check at the gap in force (the release setting `market.lead_close_gap`, undecided
 * until a test enters it through /admin/release-settings) and stored by the review submission (the
 * open keeps it, #21); an open market's times refused on the PATCH, its rule version's items, and
 * the scheduled open and judgement taken by no supplement (#80: the close moved later only and up
 * to the scheduled judgement, and the lead close checked again, are the supplement's —
 * admin-markets-supplement.controller.test.ts); `rules_edited` for the announcement and the zone
 * alone. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createMarket,
  setReleaseSetting,
  TEST_PRICE_PROTECTION_TICKS,
} from '@buddha/db/test';
import {
  PRICE_PROTECTION_TICKS_SETTING,
  STORABLE_INSTANT_TOO_EARLY,
  floorToMinute,
  type AdminMarket,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type ErrorBody = {
  error: { code: string; message: string; details?: { path: (string | number)[] }[] };
};

/** An ISO instant, `ms` from the epoch. */
const iso = (ms: number) => new Date(ms).toISOString();
/** A whole minute a week ahead: the close the tests' markets start from. */
const week = () => floorToMinute(Date.now()) + 7 * DAY_MS;
/** A whole minute already passed: a scheduled open an approval would take at once (#21). */
const passed = () => iso(floorToMinute(Date.now()) - MINUTE_MS);

describe.skipIf(!hasTestInfra)('admin market times (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let category: { id: number; slug: string };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    admin = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    // An admin finishes the onboarding like any account before /admin answers it (ADR-0072).
    await completeOnboarding(t.db, { userId: admin.id });
    await t.app.get(AdminGuard).invalidate(admin.id);
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    // The 가격 보호 폭 default the test environment enters (#119, ADR-0107 결과 3): a market copies
    // it at creation and its review submission needs one (OPEN_ITEMS_MISSING priceProtection).
    await setReleaseSetting(t.db, {
      adminId: admin.id,
      key: PRICE_PROTECTION_TICKS_SETTING.key,
      status: 'test',
      value: TEST_PRICE_PROTECTION_TICKS,
    });
  });

  const post = (url: string, payload: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { expectedAccountId: admin.id, ...payload },
    });
  const patch = (url: string, payload: Record<string, unknown>) =>
    t.app.inject({
      method: 'PATCH',
      url,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { expectedAccountId: admin.id, ...payload },
    });
  const get = (url: string) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } });

  const marketUrl = (id: string) => `/api/v1/admin/markets/${id}`;

  /**
   * A complete draft closing at `closeMs` (a whole minute): every rule item, the scheduled open
   * passed, 사건 기한 a day after the close and the judgement a day after that, the zone the form
   * pre-fills, no announcement ('없음') and a tag — it can be submitted for review at once unless
   * the overrides say not.
   */
  const draftBody = (closeMs: number, overrides: Record<string, unknown> = {}) => ({
    title: '기준금리 3% 이하로 인하?',
    description: '한국은행 금융통화위원회는 해마다 여덟 번 기준금리를 정한다.',
    yesCondition: '사건 기한까지 한국은행이 기준금리를 3% 이하로 내리면 YES.',
    noCondition: '사건 기한까지 3% 이하로 내리지 않으면 NO.',
    eventDeadline: iso(closeMs + DAY_MS),
    primarySource: { name: '한국은행 보도자료', url: 'https://www.bok.or.kr' },
    longDelayDays: 14,
    delayHandling: '장기 지연 기한까지 발표가 없으면 무효로 판정한다.',
    categoryId: category.id,
    scheduledOpenAt: passed(),
    closeAt: iso(closeMs),
    scheduledJudgementAt: iso(closeMs + 2 * DAY_MS),
    judgementTimeZone: 'Asia/Seoul',
    tags: ['시간'],
    ...overrides,
  });
  const create = (closeMs: number, overrides: Record<string, unknown> = {}) =>
    post('/api/v1/admin/markets', draftBody(closeMs, overrides));
  /** 검수 제출 (#78): the open-items check at the gap in force, which the market then keeps. */
  const submit = (id: string) => post(`/api/v1/admin/markets/${id}/submit`);

  /**
   * An open market written by the factory closing at `closeMs`, 사건 기한 a day later and the
   * judgement a day after that, unless `input` says otherwise.
   */
  const openMarket = (closeMs: number, input: Parameters<typeof createMarket>[1] = {}) =>
    createMarket(t.db, {
      createdBy: admin.id,
      categoryId: category.id,
      tags: ['시간'],
      status: 'open',
      closeAt: new Date(closeMs),
      eventDeadline: new Date(closeMs + DAY_MS),
      scheduledJudgementAt: new Date(closeMs + 2 * DAY_MS),
      ...input,
    });

  /** The release setting `market.lead_close_gap` as an admin enters it (a test value). */
  async function setGap(value: number) {
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/release-settings/market.lead_close_gap',
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { status: 'test', value, reason: '선행 마감 시험값', expectedAccountId: admin.id },
    });
    expect(res.statusCode).toBe(200);
  }

  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const detail = (res: { json: <U>() => U }) => data<AdminMarket>(res);
  const errorOf = (res: { json: <U>() => U }) => res.json<ErrorBody>().error;
  const detailPath = (res: { json: <U>() => U }) => errorOf(res).details?.[0]?.path;

  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }
  async function actionsFor(targetId: string) {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, targetId))
      .orderBy(asc(schema.adminActions.createdAt));
  }

  /** The refusal of times out of order: the broken rules, then each end with its message. */
  function expectOutOfOrder(
    res: { statusCode: number; json: <U>() => U },
    rules: string[],
    details: [string, string][],
  ) {
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toEqual({
      code: 'VALIDATION_ERROR',
      message: `The market times are out of order: ${rules.join(', ')}`,
      details: details.map(([field, message]) => ({ path: [field], message })),
    });
  }

  const BEFORE_CLOSE = 'must be before closeAt';
  const AFTER_OPEN = 'must be after scheduledOpenAt';
  const CLOSE_BY_JUDGEMENT = 'must be at or before scheduledJudgementAt';
  const JUDGEMENT_AFTER_CLOSE = 'must be at or after closeAt';
  const JUDGEMENT_AFTER_DEADLINE = 'must be at or after eventDeadline';

  // --- entry ------------------------------------------------------------------------------
  it('writes every time as entered and reads it back; null clears one on a draft; the zone as given', async () => {
    const c = week();
    const sent = {
      scheduledOpenAt: passed(),
      // Seconds and milliseconds are kept: only the order compares whole minutes (#172 item 12).
      closeAt: iso(c + 30_250),
      scheduledAnnouncementAt: iso(c + 3 * HOUR_MS + 59_999),
      scheduledJudgementAt: iso(c + 2 * DAY_MS),
    };
    const res = await create(c, { ...sent, judgementTimeZone: '  America/New_York ' });
    expect(res.statusCode).toBe(201);
    const created = detail(res);
    // Trimmed, and checked as an IANA name (#172 item 11); the gap is undecided, so a market with
    // an announcement time is named by the lead close and nothing else.
    expect(created).toMatchObject({
      ...sent,
      judgementTimeZone: 'America/New_York',
      judgementDelayed: false,
      leadCloseGapMinutes: null,
      missingOpenItems: ['leadClose'],
    });
    const row = await marketRow(created.id);
    expect({
      scheduledOpenAt: row.scheduledOpenAt?.toISOString(),
      closeAt: row.closeAt.toISOString(),
      scheduledAnnouncementAt: row.scheduledAnnouncementAt?.toISOString(),
      scheduledJudgementAt: row.scheduledJudgementAt?.toISOString(),
      judgementTimeZone: row.judgementTimeZone,
      leadCloseGapMinutes: row.leadCloseGapMinutes,
    }).toEqual({ ...sent, judgementTimeZone: 'America/New_York', leadCloseGapMinutes: null });
    // The `created` event keeps the body as sent, the times with it.
    expect(created.events[0]!.payload).toMatchObject(sent);

    // An alias is a name the engine knows and is kept as given (ADR-0063).
    const url = marketUrl(created.id);
    expect(detail(await patch(url, { judgementTimeZone: 'ROK' })).judgementTimeZone).toBe('ROK');
    // On a draft null clears each, the announcement to '없음'; the check names what is required.
    const cleared = await patch(url, {
      scheduledOpenAt: null,
      scheduledAnnouncementAt: null,
      scheduledJudgementAt: null,
      judgementTimeZone: null,
    });
    expect(cleared.statusCode).toBe(200);
    expect(detail(cleared)).toMatchObject({
      scheduledOpenAt: null,
      closeAt: sent.closeAt,
      scheduledAnnouncementAt: null,
      scheduledJudgementAt: null,
      judgementTimeZone: null,
      missingOpenItems: ['scheduledOpenAt', 'scheduledJudgementAt', 'judgementTimeZone'],
    });

    // A close edit leaves the scheduled judgement as it was, and the reverse (#22 AC 2).
    const other = detail(await create(c));
    const otherUrl = marketUrl(other.id);
    expect(detail(await patch(otherUrl, { closeAt: iso(c + HOUR_MS) }))).toMatchObject({
      closeAt: iso(c + HOUR_MS),
      scheduledJudgementAt: other.scheduledJudgementAt,
      scheduledOpenAt: other.scheduledOpenAt,
    });
    expect(
      detail(await patch(otherUrl, { scheduledJudgementAt: iso(c + 3 * DAY_MS) })),
    ).toMatchObject({ closeAt: iso(c + HOUR_MS), scheduledJudgementAt: iso(c + 3 * DAY_MS) });

    // The body schema's own refusals, on a create and on an edit: an unknown zone, an offset or a
    // case-only spelling, a malformed instant, one before the storage bound — the close included.
    for (const [bad, path, message] of [
      [{ judgementTimeZone: 'Mars/Olympus_Mons' }, 'judgementTimeZone', 'IANA'],
      [{ judgementTimeZone: '+09:00' }, 'judgementTimeZone', 'IANA'],
      [{ judgementTimeZone: 'asia/seoul' }, 'judgementTimeZone', 'IANA'],
      [{ scheduledJudgementAt: 'next week' }, 'scheduledJudgementAt', undefined],
      [{ scheduledAnnouncementAt: '2026-11-01 10:00' }, 'scheduledAnnouncementAt', undefined],
      [{ scheduledOpenAt: '0099-12-31T23:59:59.999Z' }, 'scheduledOpenAt', 'TOO_EARLY'],
      [{ closeAt: '0050-01-01T00:00:00.000Z' }, 'closeAt', 'TOO_EARLY'],
    ] as const) {
      for (const [what, res] of [
        ['create', await create(c, bad)],
        ['edit', await patch(otherUrl, bad)],
      ] as const) {
        expect({ what, path, status: res.statusCode }).toEqual({ what, path, status: 400 });
        const issue = errorOf(res).details?.[0];
        expect(issue?.path).toEqual([path]);
        if (message === 'IANA') {
          expect(issue).toMatchObject({ message: 'must be an IANA time zone name' });
        } else if (message === 'TOO_EARLY') {
          expect(issue).toMatchObject({ message: STORABLE_INSTANT_TOO_EARLY });
        }
      }
    }
    expect(await t.db.select().from(schema.markets)).toHaveLength(2);
  });

  it('refuses times out of order on a create and an edit, naming both ends in whole minutes, the sent one first (#172 12, A1)', async () => {
    const c = week();
    // Scheduled open < close: the same minute is refused, the minute before is fine.
    expectOutOfOrder(
      await create(c, { scheduledOpenAt: iso(c), closeAt: iso(c + 59_999) }),
      ['openBeforeClose'],
      [
        ['scheduledOpenAt', BEFORE_CLOSE],
        ['closeAt', AFTER_OPEN],
      ],
    );
    expect(
      (await create(c, { scheduledOpenAt: iso(c - MINUTE_MS), closeAt: iso(c + 59_999) }))
        .statusCode,
    ).toBe(201);
    // Close ≤ scheduled judgement: the close may equal it, and fall in its minute after it.
    const early = { eventDeadline: iso(c - HOUR_MS), scheduledJudgementAt: iso(c) };
    expectOutOfOrder(
      await create(c, { ...early, closeAt: iso(c + MINUTE_MS) }),
      ['closeByJudgement'],
      [
        ['closeAt', CLOSE_BY_JUDGEMENT],
        ['scheduledJudgementAt', JUDGEMENT_AFTER_CLOSE],
      ],
    );
    expect((await create(c, { ...early, closeAt: iso(c) })).statusCode).toBe(201);
    expect((await create(c, { ...early, closeAt: iso(c + 30_000) })).statusCode).toBe(201);
    // 사건 기한 ≤ scheduled judgement (owner answer 2026-10-31 A1), by the minute too.
    const judgement = c + 2 * DAY_MS;
    expectOutOfOrder(
      await create(c, { eventDeadline: iso(judgement + MINUTE_MS) }),
      ['deadlineByJudgement'],
      [
        ['eventDeadline', CLOSE_BY_JUDGEMENT],
        ['scheduledJudgementAt', JUDGEMENT_AFTER_DEADLINE],
      ],
    );
    expect((await create(c, { eventDeadline: iso(judgement + 59_999) })).statusCode).toBe(201);
    // Every broken rule at once, in the rules' order.
    expectOutOfOrder(
      await create(c, {
        closeAt: iso(judgement + MINUTE_MS),
        eventDeadline: iso(judgement + MINUTE_MS),
      }),
      ['closeByJudgement', 'deadlineByJudgement'],
      [
        ['closeAt', CLOSE_BY_JUDGEMENT],
        ['scheduledJudgementAt', JUDGEMENT_AFTER_CLOSE],
        ['eventDeadline', CLOSE_BY_JUDGEMENT],
        ['scheduledJudgementAt', JUDGEMENT_AFTER_DEADLINE],
      ],
    );
    // No order between the close and 사건 기한 (ADR-0097 result 4 (a)), nor between the
    // announcement and the judgement or the open (#78's reviewer looks).
    const loose = await create(c, {
      eventDeadline: iso(c - DAY_MS),
      scheduledAnnouncementAt: iso(judgement + 3 * DAY_MS),
    });
    expect(loose.statusCode).toBe(201);
    // Precedence (ADR-0097 decision 4): a past close, then the category, then the order.
    const outOfOrder = { scheduledOpenAt: iso(c + DAY_MS) };
    const stale = await create(c, { ...outOfOrder, closeAt: iso(Date.now() - 1_000) });
    expect(errorOf(stale).details).toEqual([
      { path: ['closeAt'], message: 'must be in the future' },
    ]);
    const hidden = await createCategory(t.db, { slug: 'hidden', nameKo: '숨김', isActive: false });
    const filed = await create(c, { ...outOfOrder, categoryId: hidden.id });
    expect(errorOf(filed).details).toEqual([{ path: ['categoryId'], message: 'inactive' }]);
    const created = await t.db.select().from(schema.markets);
    expect(created).toHaveLength(5);

    // An edit is checked on the stored times with the body over them; the end it moved is named
    // first, so the screen shows the refusal under the input the admin changed.
    const draft = detail(await create(c));
    const url = marketUrl(draft.id);
    expectOutOfOrder(
      await patch(url, { scheduledJudgementAt: iso(c - MINUTE_MS) }),
      ['closeByJudgement', 'deadlineByJudgement'],
      [
        ['scheduledJudgementAt', JUDGEMENT_AFTER_CLOSE],
        ['scheduledJudgementAt', JUDGEMENT_AFTER_DEADLINE],
        ['closeAt', CLOSE_BY_JUDGEMENT],
        ['eventDeadline', CLOSE_BY_JUDGEMENT],
      ],
    );
    expectOutOfOrder(
      await patch(url, { closeAt: iso(judgement + MINUTE_MS) }),
      ['closeByJudgement'],
      [
        ['closeAt', CLOSE_BY_JUDGEMENT],
        ['scheduledJudgementAt', JUDGEMENT_AFTER_CLOSE],
      ],
    );
    expectOutOfOrder(
      await patch(url, { eventDeadline: iso(judgement + MINUTE_MS) }),
      ['deadlineByJudgement'],
      [
        ['eventDeadline', CLOSE_BY_JUDGEMENT],
        ['scheduledJudgementAt', JUDGEMENT_AFTER_DEADLINE],
      ],
    );
    expectOutOfOrder(
      await patch(url, { scheduledOpenAt: iso(c) }),
      ['openBeforeClose'],
      [
        ['scheduledOpenAt', BEFORE_CLOSE],
        ['closeAt', AFTER_OPEN],
      ],
    );
    // Nothing of the refused edits was written.
    expect((await actionsFor(draft.id)).map((row) => row.type)).toEqual(['market_create']);
    expect((await marketRow(draft.id)).scheduledJudgementAt?.toISOString()).toBe(iso(judgement));
    // An edit of something else on a consistent market passes, and both ends moved together.
    expect((await patch(url, { title: '시각과 상관없는 수정' })).statusCode).toBe(200);
    const moved = await patch(url, {
      closeAt: iso(c + 3 * DAY_MS),
      scheduledJudgementAt: iso(c + 4 * DAY_MS),
    });
    expect(moved.statusCode).toBe(200);
    expect(detail(moved).missingOpenItems).toEqual([]);
  });

  it('never refuses the lead close on a draft: the open-items check names it at the gap in force, and the submission stores that gap', async () => {
    const c = week();
    // Undecided: a market with an announcement time fails `leadClose` ('gap undecided') and
    // cannot be submitted; one with '없음' is not concerned (ADR-0098).
    const missing = detail(
      await create(c, {
        scheduledJudgementAt: null,
        judgementTimeZone: null,
        scheduledAnnouncementAt: iso(c + 2 * HOUR_MS),
        tags: [],
      }),
    );
    expect(missing).toMatchObject({
      leadCloseGapMinutes: null,
      missingOpenItems: ['scheduledJudgementAt', 'judgementTimeZone', 'leadClose', 'tags'],
    });
    const refused = await submit(missing.id);
    expect(refused.statusCode).toBe(422);
    expect(errorOf(refused)).toEqual({
      code: 'OPEN_ITEMS_MISSING',
      message:
        'The market misses what it needs to open: scheduledJudgementAt, judgementTimeZone, ' +
        'leadClose, tags',
      details: [
        { path: ['scheduledJudgementAt'], message: 'required' },
        { path: ['judgementTimeZone'], message: 'required' },
        { path: ['leadClose'], message: 'gap undecided' },
        { path: ['tags'], message: 'required' },
      ],
    });
    const announced = detail(await create(c, { scheduledAnnouncementAt: iso(c + 2 * HOUR_MS) }));
    expect(announced.missingOpenItems).toEqual(['leadClose']);
    const none = detail(await create(c));
    expect(none).toMatchObject({ missingOpenItems: [], leadCloseGapMinutes: null });
    const submittedNone = await submit(none.id);
    expect(submittedNone.statusCode).toBe(200);
    // Submitted while undecided, it has no gap of its own.
    expect(detail(submittedNone).leadCloseGapMinutes).toBeNull();
    expect((await marketRow(none.id)).leadCloseGapMinutes).toBeNull();

    // Decided, in any status: close ≤ announcement − 60 minutes, whole minutes.
    await setGap(60);
    expect(detail(await get(marketUrl(announced.id)))).toMatchObject({
      leadCloseGapMinutes: 60,
      missingOpenItems: [],
    });
    // Entry is still never refused for it (C8): the check names it.
    const tight = await create(c, { scheduledAnnouncementAt: iso(c + 59 * MINUTE_MS + 59_999) });
    expect(tight.statusCode).toBe(201);
    expect(detail(tight).missingOpenItems).toEqual(['leadClose']);
    expect(errorOf(await submit(detail(tight).id))).toEqual({
      code: 'OPEN_ITEMS_MISSING',
      message: 'The market misses what it needs to open: leadClose',
      details: [{ path: ['leadClose'], message: 'leadClose' }],
    });
    const tightUrl = marketUrl(detail(tight).id);
    const edited = await patch(tightUrl, { scheduledAnnouncementAt: iso(c + 10 * MINUTE_MS) });
    expect(edited.statusCode).toBe(200);
    expect(detail(edited).missingOpenItems).toEqual(['leadClose']);
    // At the gap to the minute it passes.
    const atGap = await patch(tightUrl, { scheduledAnnouncementAt: iso(c + 60 * MINUTE_MS) });
    expect(detail(atGap).missingOpenItems).toEqual([]);
    const submitted = await submit(detail(tight).id);
    expect(submitted.statusCode).toBe(200);
    // The submission stores the gap it checked against (docs/SETTINGS.md: work under way keeps the
    // value it started with) — the approval checks with it and the open keeps it (#21, ADR-0098
    // 7-6) — and its record carries the times and the gap.
    expect(detail(submitted)).toMatchObject({ status: 'review', leadCloseGapMinutes: 60 });
    expect((await marketRow(detail(tight).id)).leadCloseGapMinutes).toBe(60);
    const submitAction = (await actionsFor(detail(tight).id)).find(
      (row) => row.type === 'market_submit',
    )!;
    const times = {
      scheduledOpenAt: detail(atGap).scheduledOpenAt,
      closeAt: iso(c),
      scheduledAnnouncementAt: iso(c + HOUR_MS),
      scheduledJudgementAt: iso(c + 2 * DAY_MS),
      judgementTimeZone: 'Asia/Seoul',
    };
    expect(submitAction.payload).toMatchObject({
      after: { status: 'review', ...times, leadCloseGapMinutes: 60 },
    });
    expect(submitAction.payload).not.toHaveProperty('before');

    // A changed setting: the market in review keeps the gap it was submitted under, a draft takes
    // the new one.
    await setGap(120);
    expect(detail(await get(marketUrl(detail(tight).id))).leadCloseGapMinutes).toBe(60);
    expect(detail(await get(marketUrl(announced.id)))).toMatchObject({
      leadCloseGapMinutes: 120,
      missingOpenItems: [],
    });
    await setGap(121);
    expect(detail(await get(marketUrl(announced.id))).missingOpenItems).toEqual(['leadClose']);
  });

  // --- an open market (#80: its times are its rule version's) --------------------------------
  it('keeps an open market’s times: the PATCH refuses each one changed (on a market opened before rule versions, until the close), and no supplement moves the scheduled open or judgement', async () => {
    const c = week();
    const live = await openMarket(c);
    const url = marketUrl(live.id);
    const stored = {
      scheduledOpenAt: live.scheduledOpenAt!.toISOString(),
      scheduledJudgementAt: live.scheduledJudgementAt!.toISOString(),
    };
    // #172 item 14: after the open the times change by a supplement alone; a millisecond is a
    // change (an instant, as stored), and so is a time cleared. This market was made open with no
    // rule version (`createMarket`, as one opened before #80 — D4), which takes no supplement
    // either: the same details, and a message that says the items hold until the close.
    for (const [body, items] of [
      [{ scheduledJudgementAt: iso(c + 3 * DAY_MS) }, ['scheduledJudgementAt']],
      [{ scheduledJudgementAt: iso(c + 2 * DAY_MS + 1) }, ['scheduledJudgementAt']],
      [{ scheduledJudgementAt: null }, ['scheduledJudgementAt']],
      [{ scheduledOpenAt: null }, ['scheduledOpenAt']],
      [{ closeAt: iso(c + HOUR_MS) }, ['closeAt']],
      [{ scheduledAnnouncementAt: iso(c + 3 * HOUR_MS) }, ['scheduledAnnouncementAt']],
      [{ judgementTimeZone: null }, ['judgementTimeZone']],
      [
        { judgementTimeZone: 'America/New_York', scheduledOpenAt: iso(c - DAY_MS) },
        ['scheduledOpenAt', 'judgementTimeZone'],
      ],
    ] as const) {
      const res = await patch(url, body);
      expect({ body, status: res.statusCode }).toEqual({ body, status: 400 });
      expect(errorOf(res)).toEqual({
        code: 'VALIDATION_ERROR',
        message: `${items.join(', ')} cannot change until the close: the market opened before rule versions`,
        details: items.map((item) => ({ path: [item], message: 'supplement only while open' })),
      });
    }
    // After the slug.
    const slugged = await patch(url, { slug: 'new-slug', scheduledJudgementAt: iso(c) });
    expect(detailPath(slugged)).toEqual(['slug']);
    expect(await actionsFor(live.id)).toHaveLength(0);
    // The stored instant again, however spelled, is no change.
    const resent = await patch(url, {
      scheduledOpenAt: stored.scheduledOpenAt.replace('.000Z', 'Z'),
      scheduledJudgementAt: stored.scheduledJudgementAt,
      closeAt: iso(c),
      judgementTimeZone: 'Asia/Seoul',
      tags: ['같은 시각을 다시 보낸 수정'],
    });
    expect(resent.statusCode).toBe(200);
    expect(detail(resent)).toMatchObject(stored);

    // Nor does a supplement move the scheduled open or judgement: its body takes neither.
    const supplement = await post(`${url}/supplements`, {
      baseVersion: 1,
      changes: { scheduledJudgementAt: iso(c + 3 * DAY_MS), scheduledOpenAt: null },
      reason: '판정 일정을 미룬다',
      settlementImpact: '없음',
    });
    expect(supplement.statusCode).toBe(400);
    expect(errorOf(supplement).details).toEqual([
      {
        path: ['changes'],
        message: 'not a supplement item: scheduledJudgementAt, scheduledOpenAt',
      },
    ]);

    // A market opened before #22 keeps its blank times (D4): none may be filled in, and a null
    // sent again is no change.
    const legacy = await openMarket(c, { blankTimes: true, scheduledJudgementAt: null });
    const legacyUrl = marketUrl(legacy.id);
    const blank = ['scheduledOpenAt', 'scheduledJudgementAt', 'judgementTimeZone'];
    expect(detail(await get(legacyUrl)).missingOpenItems).toEqual(blank);
    for (const item of ['scheduledOpenAt', 'scheduledJudgementAt', 'judgementTimeZone'] as const) {
      const value =
        item === 'scheduledOpenAt'
          ? passed()
          : item === 'judgementTimeZone'
            ? 'Asia/Seoul'
            : iso(c + 2 * DAY_MS);
      const res = await patch(legacyUrl, { [item]: value });
      expect({ item, status: res.statusCode }).toEqual({ item, status: 400 });
      expect(errorOf(res).details).toEqual([
        { path: [item], message: 'supplement only while open' },
      ]);
    }
    const nothing = await patch(legacyUrl, {
      scheduledOpenAt: null,
      scheduledJudgementAt: null,
      judgementTimeZone: null,
      tags: ['옛 시장의 새 태그'],
    });
    expect(nothing.statusCode).toBe(200);
    expect(detail(nothing).missingOpenItems).toEqual(blank);

    // A paused market is after the open as an open one is (#114, ADR-0102): its times are refused
    // the same way, and its tags change (admin-market-pauses.controller.test.ts has the rest).
    const paused = await openMarket(c, { status: 'paused' });
    const refused = await patch(marketUrl(paused.id), { closeAt: iso(c + DAY_MS) });
    expect(errorOf(refused)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'closeAt cannot change until the close: the market opened before rule versions',
      details: [{ path: ['closeAt'], message: 'supplement only while open' }],
    });
    const retagged = await patch(marketUrl(paused.id), { tags: ['일시 중단 중의 태그'] });
    expect(retagged.statusCode).toBe(200);
    expect(detail(retagged)).toMatchObject({ status: 'paused', closeAt: iso(c) });
    // Any other status refuses everything naming `status`.
    const closed = await openMarket(c, { status: 'closed' });
    const late = await patch(marketUrl(closed.id), { tags: ['마감 뒤의 태그'] });
    expect(late.statusCode).toBe(400);
    expect(errorOf(late)).toMatchObject({ message: 'Market is closed' });
    expect(detailPath(late)).toEqual(['status']);
  });

  // --- records ----------------------------------------------------------------------------
  it('records a draft’s announcement and zone as rules_edited and the other times in market_update only', async () => {
    const c = week();
    const draft = detail(await create(c));
    const url = marketUrl(draft.id);
    // The announcement time and the zone are 판정 항목 (#172 item 7): an item each.
    const edited = detail(
      await patch(url, { scheduledAnnouncementAt: iso(c + 3 * HOUR_MS), judgementTimeZone: 'ROK' }),
    );
    expect(edited.events.map((event) => event.type)).toEqual(['rules_edited', 'created']);
    expect(edited.events[0]!.payload).toEqual({
      items: ['scheduledAnnouncementAt', 'judgementTimeZone'],
      before: { scheduledAnnouncementAt: null, judgementTimeZone: 'Asia/Seoul' },
      after: { scheduledAnnouncementAt: iso(c + 3 * HOUR_MS), judgementTimeZone: 'ROK' },
    });
    // With a rule item, in RULES_EDITED_ITEMS order.
    const mixed = detail(
      await patch(url, { judgementTimeZone: 'Asia/Seoul', yesCondition: '고친 YES 조건' }),
    );
    expect(mixed.events[0]!.payload).toMatchObject({
      items: ['yesCondition', 'judgementTimeZone'],
    });
    // The scheduled open, the close and the judgement are times of the market, as its title is:
    // the `market_update` record shows them, `rules_edited` does not.
    const openAt = iso(floorToMinute(Date.now()) - 2 * MINUTE_MS);
    const timed = detail(
      await patch(url, {
        scheduledOpenAt: openAt,
        closeAt: iso(c + HOUR_MS),
        scheduledJudgementAt: iso(c + 3 * DAY_MS),
      }),
    );
    expect(timed.events.filter((event) => event.type === 'rules_edited')).toHaveLength(2);
    expect((await actionsFor(draft.id)).at(-1)!.payload).toMatchObject({
      before: {
        scheduledOpenAt: draft.scheduledOpenAt,
        closeAt: iso(c),
        scheduledJudgementAt: iso(c + 2 * DAY_MS),
      },
      after: {
        scheduledOpenAt: openAt,
        closeAt: iso(c + HOUR_MS),
        scheduledJudgementAt: iso(c + 3 * DAY_MS),
      },
    });
    // The same instant however spelled, and the same zone, are no edit.
    const resaved = detail(
      await patch(url, {
        scheduledAnnouncementAt: iso(c + 3 * HOUR_MS).replace('.000Z', 'Z'),
        judgementTimeZone: 'Asia/Seoul',
      }),
    );
    expect(resaved.events.filter((event) => event.type === 'rules_edited')).toHaveLength(2);
    // An open market's times are its rule version's: a supplement's approval moves them and
    // republishes its status (#80, admin-markets-supplement.controller.test.ts).
  });
});
