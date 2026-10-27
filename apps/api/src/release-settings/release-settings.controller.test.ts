/**
 * Release settings (#170) against the docker `test` profile, with a registry of test items
 * injected through `createTestApp({ releaseSettings })` — the shipped one holds the items the
 * issues that use them registered (the start grant, #70), checked at the end. Covers
 * register → list → get → change → change log, the reason and value rules (text jsonb cannot hold
 * included), the refusal of a change to the current state, the undecided filter, the admin-only
 * surface and that a change and its record commit together. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  JSONB_LONE_SURROGATE_MESSAGE,
  JSONB_NUL_MESSAGE,
  RELEASE_SETTINGS,
  RELEASE_SETTING_UNCHANGED_MESSAGE,
  START_COIN_SETTING,
  defineReleaseSetting,
  defineReleaseSettings,
  type ReleaseSetting,
  type ReleaseSettingChange,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { AdminGuard } from '../auth/admin.guard.js';
import { NUL_MESSAGE } from '../common/pipes/validation.pipe.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { ReleaseSettingsService } from './release-settings.service.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const BASE = '/api/v1/admin/release-settings';

const hours = defineReleaseSetting({
  key: 'test.period_hours',
  label: '시험 기간',
  unit: '시간',
  description: '시험용 항목: 정수 시간',
  schema: z.number().int().min(1).max(720),
});
const window = defineReleaseSetting({
  key: 'test.window',
  label: '시험 구간',
  unit: null,
  description: '시험용 항목: 객체 값',
  schema: z.object({ from: z.number().int(), to: z.number().int() }).strict(),
});
/** A string value: one that reads as JSON text (`"24"`) must come back as that string. */
const code = defineReleaseSetting({
  key: 'test.code',
  label: '시험 코드',
  unit: null,
  description: '시험용 항목: 문자열 값',
  schema: z.string().min(1).max(20),
});
/** A value with keys of the admin's choosing: names to whole numbers. */
const limits = defineReleaseSetting({
  key: 'test.limits',
  label: '시험 한도',
  unit: null,
  description: '시험용 항목: 이름별 정수',
  schema: z.record(z.string(), z.number().int()),
});
/**
 * Broken on purpose: its schema answers JSON null, which the type of a definition forbids and the
 * CHECK of release_settings refuses — the write that fails AFTER the record was inserted.
 */
const broken = defineReleaseSetting({
  key: 'test.broken',
  label: '깨진 항목',
  unit: null,
  description: '시험용 항목: 기록 뒤 쓰기가 실패한다',
  schema: z.number().transform(() => null) as unknown as z.ZodType<number>,
});

/** U+0000: PostgreSQL's jsonb cannot hold it. */
const NUL = String.fromCharCode(0);

type ErrorBody = {
  error: { code: string; details?: { path: (string | number)[]; message: string }[] };
};
type ChangePage = { data: ReleaseSettingChange[]; meta: { nextCursor: string | null } };

describe.skipIf(!hasTestInfra)('release settings (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let member: TestUser;
  let adminNickname: string;

  beforeAll(async () => {
    t = await createTestApp({
      releaseSettings: defineReleaseSettings([hours, window, code, limits, broken]),
    });
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    admin = await signUpTestUser(t);
    member = await signUpTestUser(t);
    const [profile] = await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id))
      .returning();
    adminNickname = profile!.nickname;
    // The guard caches roles for 60 s (PLAN 10.5); the promotion above happened behind it.
    await t.app.get(AdminGuard).invalidate(admin.id);
  });

  const get = (url: string, cookie = admin.cookie) =>
    t.app.inject({ method: 'GET', url, headers: { cookie } });
  const patch = (key: string, payload: Record<string, unknown>, cookie = admin.cookie) =>
    t.app.inject({
      method: 'PATCH',
      url: `${BASE}/${key}`,
      headers: { ...jsonHeaders, cookie },
      payload,
    });

  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const errorOf = (res: { json: <U>() => U }) => res.json<ErrorBody>().error;
  const service = () => t.app.get(ReleaseSettingsService);

  async function settingRows() {
    return t.db.select().from(schema.releaseSettings).orderBy(asc(schema.releaseSettings.key));
  }
  async function records() {
    return t.db
      .select()
      .from(schema.adminActions)
      .orderBy(asc(schema.adminActions.createdAt), asc(schema.adminActions.id));
  }

  it('lists every registered item, in registry order, as undecided before any change', async () => {
    const res = await get(BASE);
    expect(res.statusCode).toBe(200);
    const items = data<ReleaseSetting[]>(res);
    expect(items.map((item) => [item.key, item.status, item.value])).toEqual([
      [hours.key, 'undecided', null],
      [window.key, 'undecided', null],
      [code.key, 'undecided', null],
      [limits.key, 'undecided', null],
      [broken.key, 'undecided', null],
    ]);
    const { valueSchema, ...first } = items[0]!;
    expect(first).toEqual({
      key: 'test.period_hours',
      label: '시험 기간',
      unit: '시간',
      description: '시험용 항목: 정수 시간',
      status: 'undecided',
      value: null,
      updatedAt: null,
      updatedBy: null,
    });
    // What the admin screen can tell the value's shape from.
    expect(valueSchema).toMatchObject({ type: 'integer', minimum: 1, maximum: 720 });
    expect(items[1]).toMatchObject({ unit: null, valueSchema: { type: 'object' } });
  });

  it('changes an item with a reason: the row, its record and the answer agree', async () => {
    const res = await patch(hours.key, { status: 'test', value: 48, reason: '  내부 시험  ' });
    expect(res.statusCode).toBe(200);
    const item = data<ReleaseSetting>(res);
    expect(item).toMatchObject({
      key: hours.key,
      status: 'test',
      value: 48,
      updatedBy: { id: admin.id, nickname: adminNickname },
    });

    const [row] = await settingRows();
    expect(row).toMatchObject({ key: hours.key, status: 'test', value: 48, updatedBy: admin.id });
    expect(item.updatedAt).toBe(row!.updatedAt.toISOString());
    const [record] = await records();
    expect(record).toMatchObject({
      adminId: admin.id,
      type: 'release_setting_change',
      targetType: 'release_setting',
      targetId: hours.key,
      payload: {
        key: hours.key,
        before: { status: 'undecided', value: null },
        after: { status: 'test', value: 48 },
        reason: '내부 시험',
      },
    });
    // One instant for both: the record says when the value it describes took effect.
    expect(record!.createdAt.getTime()).toBe(row!.updatedAt.getTime());

    // The next change records the previous state as its `before`, and back to undecided too.
    await patch(hours.key, { status: 'approved', value: 72, reason: '승인' });
    const back = await patch(hours.key, { status: 'undecided', reason: '재검토' });
    expect(data<ReleaseSetting>(back)).toMatchObject({ status: 'undecided', value: null });
    expect((await records()).map((r) => r.payload)).toEqual([
      expect.anything(),
      expect.objectContaining({
        before: { status: 'test', value: 48 },
        after: { status: 'approved', value: 72 },
      }),
      expect.objectContaining({
        before: { status: 'approved', value: 72 },
        after: { status: 'undecided', value: null },
      }),
    ]);
    expect(await settingRows()).toMatchObject([{ status: 'undecided', value: null }]);
  });

  it('hands server code a typed reading of registered items only', async () => {
    expect(await service().get(hours)).toEqual({
      key: hours.key,
      status: 'undecided',
      value: null,
    });
    await patch(window.key, { status: 'proposal', value: { from: 1, to: 3 }, reason: '설계 제안' });
    const reading = await service().get(window);
    expect(reading).toEqual({ key: window.key, status: 'proposal', value: { from: 1, to: 3 } });
    if (reading.status !== 'undecided') {
      const to: number = reading.value.to; // typed by the definition's schema
      expect(to).toBe(3);
    }
    // Inside a caller's transaction as well.
    await t.db.transaction(async (tx) => {
      expect((await service().get(window, tx)).status).toBe('proposal');
    });

    // A definition the registry does not hold — another key, or a copy of a registered one.
    const unregistered = defineReleaseSetting({ ...hours, key: 'test.unregistered' });
    for (const definition of [unregistered, { ...hours }]) {
      await expect(service().get(definition)).rejects.toMatchObject({ code: 'INTERNAL' });
    }
  });

  it('keeps a string value that reads as JSON text a string, everywhere it is read', async () => {
    for (const value of ['24', 'null', '"x"', '{}']) {
      const res = await patch(code.key, { status: 'test', value, reason: '문자열' });
      expect(data<ReleaseSetting>(res).value).toBe(value);
      expect(await service().get(code)).toEqual({ key: code.key, status: 'test', value });
      const listed = data<ReleaseSetting[]>(await get(`${BASE}?status=test`));
      expect(listed.map((item) => item.value)).toEqual([value]);
      const [latest] = (await get(`${BASE}/changes?limit=1`)).json<ChangePage>().data;
      expect(latest!.after).toEqual({ status: 'test', value });
    }
    // Each change recorded the previous string as its `before`, unchanged.
    const [latest] = (await get(`${BASE}/changes?limit=1`)).json<ChangePage>().data;
    expect(latest!.before).toEqual({ status: 'test', value: '"x"' });
  });

  it('refuses a change without a reason, writing nothing', async () => {
    for (const reason of [undefined, '', '   ', 'x'.repeat(501), 7]) {
      const res = await patch(hours.key, { status: 'test', value: 24, reason });
      expect({ reason, status: res.statusCode }).toEqual({ reason, status: 400 });
      expect(errorOf(res)).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(errorOf(res).details?.[0]?.path).toEqual(['reason']);
    }
    expect(await settingRows()).toEqual([]);
    expect(await records()).toEqual([]);
  });

  it('refuses a reason or a value jsonb cannot hold as bad input, writing nothing', async () => {
    // Codex #201: PostgreSQL's jsonb refuses U+0000 and a lone surrogate, so such text in the
    // reason or the value (admin_actions.payload, release_settings.value) failed the write as a
    // 500. It is now a VALIDATION_ERROR naming the field, before anything is written.
    const lone = JSONB_LONE_SURROGATE_MESSAGE;
    for (const [key, body, path, message] of [
      [hours.key, { value: 24, reason: NUL }, ['reason'], JSONB_NUL_MESSAGE],
      [hours.key, { value: 24, reason: `  사유${NUL}  ` }, ['reason'], JSONB_NUL_MESSAGE],
      [hours.key, { value: 24, reason: '사유\ud800' }, ['reason'], lone],
      [hours.key, { value: 24, reason: '\udc00사유' }, ['reason'], lone],
      [code.key, { value: `a${NUL}`, reason: '시험' }, ['value'], JSONB_NUL_MESSAGE],
      [code.key, { value: 'a\ud800', reason: '시험' }, ['value'], lone],
      [
        limits.key,
        { value: { [`a${NUL}`]: 1 }, reason: '시험' },
        ['value', `a${NUL}`],
        `key ${JSONB_NUL_MESSAGE}`,
      ],
      [
        limits.key,
        { value: { 'a\udbff': 1 }, reason: '시험' },
        ['value', 'a\udbff'],
        `key ${lone}`,
      ],
    ] as const) {
      const res = await patch(key, { status: 'test', ...body });
      expect({ body, status: res.statusCode }).toEqual({ body, status: 400 });
      expect(errorOf(res)).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ path, message }],
      });
    }
    expect(await settingRows()).toEqual([]);
    expect(await records()).toEqual([]);
    // A NUL reads the same whether the body schema or the global pipe's sweep finds it.
    expect(JSONB_NUL_MESSAGE).toBe(NUL_MESSAGE);

    // Paired surrogates and the other control characters are text jsonb holds: stored as sent.
    const value = { '😀': 1, 'a\u0001': 2 };
    const res = await patch(limits.key, { status: 'test', value, reason: '😀\u001f사유' });
    expect(res.statusCode).toBe(200);
    expect(data<ReleaseSetting>(res).value).toEqual(value);
    expect(await records()).toMatchObject([
      { payload: { after: { status: 'test', value }, reason: '😀\u001f사유' } },
    ]);
  });

  it('checks the value against the status rule and the item, writing nothing', async () => {
    for (const [key, body, path] of [
      [hours.key, { status: 'test', value: 0 }, ['value']],
      [hours.key, { status: 'test', value: 1.5 }, ['value']],
      [hours.key, { status: 'test', value: '24' }, ['value']],
      [hours.key, { status: 'approved' }, ['value']],
      [hours.key, { status: 'approved', value: null }, ['value']],
      [hours.key, { status: 'undecided', value: 24 }, ['value']],
      [window.key, { status: 'test', value: { from: 1, to: 'x' } }, ['value', 'to']],
      [window.key, { status: 'test', value: { from: 1, to: 2, extra: 3 } }, ['value']],
      [hours.key, { status: 'final', value: 24 }, ['status']],
    ] as const) {
      const res = await patch(key, { ...body, reason: '시험' });
      expect({ body, status: res.statusCode }).toEqual({ body, status: 400 });
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(errorOf(res).details?.[0]?.path).toEqual(path);
    }
    expect(await settingRows()).toEqual([]);
    expect(await records()).toEqual([]);
  });

  it('refuses a change to the current status and value, writing and recording nothing', async () => {
    const unchanged = { path: [], message: RELEASE_SETTING_UNCHANGED_MESSAGE };
    async function expectUnchanged(key: string, body: Record<string, unknown>) {
      const res = await patch(key, { ...body, reason: '같은 값' });
      expect({ body, status: res.statusCode }).toEqual({ body, status: 400 });
      expect(errorOf(res)).toMatchObject({ code: 'VALIDATION_ERROR', details: [unchanged] });
    }

    // No row is undecided with no value: going "back" to undecided changes nothing.
    await expectUnchanged(hours.key, { status: 'undecided' });
    await expectUnchanged(hours.key, { status: 'undecided', value: null });
    expect(await settingRows()).toEqual([]);
    expect(await records()).toEqual([]);

    await patch(hours.key, { status: 'test', value: 24, reason: '시험' });
    await patch(window.key, { status: 'proposal', value: { from: 1, to: 3 }, reason: '제안' });
    await patch(code.key, { status: 'test', value: '24', reason: '문자열' });
    const before = { rows: await settingRows(), records: await records() };

    await expectUnchanged(hours.key, { status: 'test', value: 24 });
    // The same object with its members in another order (jsonb does not keep the order).
    await expectUnchanged(window.key, { status: 'proposal', value: { to: 3, from: 1 } });
    await expectUnchanged(code.key, { status: 'test', value: '24' });
    expect(await settingRows()).toEqual(before.rows);
    expect(await records()).toEqual(before.records);

    // A new status with the same value, or a new value of the same type, is a change.
    expect(
      (await patch(hours.key, { status: 'approved', value: 24, reason: '승인' })).statusCode,
    ).toBe(200);
    expect(
      (await patch(code.key, { status: 'test', value: '25', reason: '바꿈' })).statusCode,
    ).toBe(200);
    expect(await records()).toHaveLength(before.records.length + 2);
  });

  it('refuses the second of two identical concurrent changes: it found the first done', async () => {
    const body = { status: 'test', value: 10, reason: '동시' };
    const answers = await Promise.all([patch(hours.key, body), patch(hours.key, body)]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 400]);
    const refused = answers.find((res) => res.statusCode === 400)!;
    expect(errorOf(refused).details).toEqual([
      { path: [], message: RELEASE_SETTING_UNCHANGED_MESSAGE },
    ]);
    expect(await records()).toHaveLength(1);
    expect(await settingRows()).toMatchObject([{ status: 'test', value: 10 }]);
  });

  it('answers 404 for a key no item has and 400 for a malformed one', async () => {
    const unknown = await patch('test.unknown', { status: 'test', value: 1, reason: '시험' });
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown).code).toBe('NOT_FOUND');
    const malformed = await patch('Test-Key', { status: 'test', value: 1, reason: '시험' });
    expect(malformed.statusCode).toBe(400);
    expect(errorOf(malformed).code).toBe('VALIDATION_ERROR');
    expect(await records()).toEqual([]);
  });

  it('lists only the undecided items, or those of any one status', async () => {
    await patch(hours.key, { status: 'test', value: 24, reason: '시험' });
    const keys = async (query: string) =>
      data<ReleaseSetting[]>(await get(`${BASE}${query}`)).map((item) => item.key);
    expect(await keys('?status=undecided')).toEqual([window.key, code.key, limits.key, broken.key]);
    expect(await keys('?status=test')).toEqual([hours.key]);
    expect(await keys('?status=approved')).toEqual([]);
    expect((await get(`${BASE}?status=final`)).statusCode).toBe(400);
  });

  it('pages the change records newest first, with the actor, and by key', async () => {
    await patch(hours.key, { status: 'proposal', value: 24, reason: '첫 제안' });
    await patch(window.key, { status: 'test', value: { from: 0, to: 1 }, reason: '시험값' });
    const approved = await patch(hours.key, { status: 'approved', value: 24, reason: '승인' });
    // A record of a key the registry no longer holds keeps its place, with no label — written
    // 1 ms after the last change, so the order below does not hang on the clock's resolution.
    await t.db.insert(schema.adminActions).values({
      adminId: admin.id,
      type: 'release_setting_change',
      targetType: 'release_setting',
      targetId: 'test.retired',
      payload: {
        key: 'test.retired',
        before: { status: 'undecided', value: null },
        after: { status: 'test', value: true },
        reason: '없어진 항목',
      },
      createdAt: new Date(Date.parse(data<ReleaseSetting>(approved).updatedAt!) + 1),
    });
    // Another type in the same log is not a release setting change.
    await t.db
      .insert(schema.adminActions)
      .values({ adminId: admin.id, type: 'market_open', targetType: 'market', targetId: 'x' });

    const first = await get(`${BASE}/changes?limit=2`);
    expect(first.statusCode).toBe(200);
    const page1 = first.json<ChangePage>();
    expect(page1.data.map((c) => [c.key, c.reason])).toEqual([
      ['test.retired', '없어진 항목'],
      [hours.key, '승인'],
    ]);
    expect(page1.data[0]).toMatchObject({ label: null, after: { status: 'test', value: true } });
    const { id, createdAt, ...latest } = page1.data[1]!;
    expect(latest).toEqual({
      key: hours.key,
      label: '시험 기간',
      before: { status: 'proposal', value: 24 },
      after: { status: 'approved', value: 24 },
      reason: '승인',
      actor: { id: admin.id, nickname: adminNickname },
    });
    const [record] = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.id, id));
    expect(record!.createdAt.toISOString()).toBe(createdAt);
    expect(page1.meta.nextCursor).not.toBeNull();

    const second = await get(
      `${BASE}/changes?limit=2&cursor=${encodeURIComponent(page1.meta.nextCursor!)}`,
    );
    const page2 = second.json<ChangePage>();
    expect(page2.data.map((c) => [c.key, c.reason])).toEqual([
      [window.key, '시험값'],
      [hours.key, '첫 제안'],
    ]);
    expect(page2.meta.nextCursor).toBeNull();

    const byKey = await get(`${BASE}/changes?key=${hours.key}`);
    expect(byKey.json<ChangePage>().data.map((c) => c.reason)).toEqual(['승인', '첫 제안']);
    expect((await get(`${BASE}/changes?key=Not-A-Key`)).statusCode).toBe(400);
  });

  it('serialises concurrent changes of one key: both commit, each recording the other', async () => {
    const [a, b] = await Promise.all([
      patch(hours.key, { status: 'test', value: 10, reason: 'A' }),
      patch(hours.key, { status: 'test', value: 20, reason: 'B' }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const rows = await records();
    // Strictly later, even within one millisecond of the first: the order is the commit order.
    expect(rows).toHaveLength(2);
    expect(rows[1]!.createdAt.getTime()).toBeGreaterThan(rows[0]!.createdAt.getTime());
    const payloads = rows.map((r) => r.payload as { before: unknown; after: unknown });
    // The second to commit saw the first's value as its `before`; the row holds the second.
    expect(payloads[0]!.before).toEqual({ status: 'undecided', value: null });
    expect(payloads[1]!.before).toEqual(payloads[0]!.after);
    expect((await settingRows())[0]).toMatchObject({
      value: (payloads[1]!.after as { value: number }).value,
    });
  });

  it('makes each change of a key later than the last, even when the clock has not passed it', async () => {
    // A change stored a minute ahead of the database clock: the next one is recorded 1 ms after
    // it rather than at the clock's earlier instant (migration 0020 would refuse that UPDATE).
    const ahead = new Date(Date.now() + 60_000);
    const stored = { status: 'test', value: 10 } as const;
    await t.db.transaction(async (tx) => {
      await tx.insert(schema.adminActions).values({
        adminId: admin.id,
        type: 'release_setting_change',
        targetType: 'release_setting',
        targetId: hours.key,
        payload: {
          key: hours.key,
          before: { status: 'undecided', value: null },
          after: stored,
          reason: '앞선 시각',
        },
        createdAt: ahead,
      });
      await tx
        .insert(schema.releaseSettings)
        .values({ key: hours.key, ...stored, updatedAt: ahead, updatedBy: admin.id });
    });

    const res = await patch(hours.key, { status: 'test', value: 20, reason: '다음 변경' });
    expect(res.statusCode).toBe(200);
    const next = ahead.getTime() + 1;
    expect(Date.parse(data<ReleaseSetting>(res).updatedAt!)).toBe(next);
    const [, record] = await records();
    expect(record!.createdAt.getTime()).toBe(next);
    expect(record!.payload).toMatchObject({ before: stored, after: { status: 'test', value: 20 } });
    expect((await settingRows())[0]!.updatedAt.getTime()).toBe(next);
  });

  it('commits a change and its record together or not at all', async () => {
    // The record is inserted first, then the row write fails (the CHECK refuses JSON null):
    // the whole transaction rolls back and no record is left describing a change that never was.
    const res = await patch(broken.key, { status: 'test', value: 1, reason: '시험' });
    expect(res.statusCode).toBe(500);
    expect(errorOf(res).code).toBe('INTERNAL');
    expect(await settingRows()).toEqual([]);
    expect(await records()).toEqual([]);
  });

  it('is closed to members and anonymous callers, on reads and writes alike', async () => {
    await patch(hours.key, { status: 'test', value: 24, reason: '시험' });
    for (const [method, url, payload] of [
      ['GET', BASE, undefined],
      ['GET', `${BASE}?status=undecided`, undefined],
      ['GET', `${BASE}/changes`, undefined],
      ['PATCH', `${BASE}/${hours.key}`, { status: 'approved', value: 72, reason: '시험' }],
    ] as const) {
      const asMember = await t.app.inject({
        method,
        url,
        headers: { ...jsonHeaders, cookie: member.cookie },
        payload,
      });
      expect({ method, url, status: asMember.statusCode }).toEqual({ method, url, status: 403 });
      expect(errorOf(asMember).code).toBe('FORBIDDEN');

      const anonymous = await t.app.inject({ method, url, headers: jsonHeaders, payload });
      expect({ method, url, status: anonymous.statusCode }).toEqual({ method, url, status: 401 });
      expect(errorOf(anonymous).code).toBe('UNAUTHENTICATED');
    }
    // A cookie-authenticated change from a foreign Origin (CSRF) is refused as well.
    const foreign = await t.app.inject({
      method: 'PATCH',
      url: `${BASE}/${hours.key}`,
      headers: { ...jsonHeaders, origin: 'https://evil.example', cookie: admin.cookie },
      payload: { status: 'approved', value: 72, reason: '시험' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(await settingRows()).toMatchObject([{ status: 'test', value: 24 }]);
    expect(await records()).toHaveLength(1);
  });
});

describe.skipIf(!hasTestInfra)('the shipped registry (integration)', () => {
  let t: TestApp;
  let admin: TestUser;

  beforeAll(async () => {
    // No `releaseSettings`: the app runs what production ships (RELEASE_SETTINGS).
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
    await t.app.get(AdminGuard).invalidate(admin.id);
  });

  it('lists the start grant amount (#70), undecided until an admin enters a value', async () => {
    expect([...RELEASE_SETTINGS.keys()]).toEqual([START_COIN_SETTING.key]);
    const res = await t.app.inject({
      method: 'GET',
      url: BASE,
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: ReleaseSetting[] }>().data).toEqual([
      {
        key: 'grant.start_coin',
        label: '시작 지급액',
        unit: 'Coin',
        description: START_COIN_SETTING.description,
        valueSchema: expect.objectContaining({
          type: 'integer',
          minimum: 1,
          maximum: 1_000_000,
        }) as unknown,
        status: 'undecided',
        value: null,
        updatedAt: null,
        updatedBy: null,
      },
    ]);
    const settings = t.app.get(ReleaseSettingsService);
    expect(await settings.get(START_COIN_SETTING)).toEqual({
      key: 'grant.start_coin',
      status: 'undecided',
      value: null,
    });

    const change = await t.app.inject({
      method: 'PATCH',
      url: `${BASE}/grant.start_coin`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { status: 'test', value: 10_000, reason: '내부 시험값' },
    });
    expect(change.statusCode).toBe(200);
    expect(await settings.get(START_COIN_SETTING)).toEqual({
      key: 'grant.start_coin',
      status: 'test',
      value: 10_000,
    });
    // Not a whole positive amount within the bound: refused, nothing written.
    for (const value of [0, 10.5, '10000', 1_000_001]) {
      const refused = await t.app.inject({
        method: 'PATCH',
        url: `${BASE}/grant.start_coin`,
        headers: { ...jsonHeaders, cookie: admin.cookie },
        payload: { status: 'approved', value, reason: '잘못된 값' },
      });
      expect(refused.statusCode, String(value)).toBe(400);
    }
    expect((await settings.get(START_COIN_SETTING)).value).toBe(10_000);
  });
});
