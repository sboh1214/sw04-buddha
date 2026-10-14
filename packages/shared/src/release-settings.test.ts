import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { ADMIN_ACTION_TYPES, RELEASE_SETTING_STATUSES } from './enums.js';
import {
  JSONB_LONE_SURROGATE_MESSAGE,
  JSONB_NUL_MESSAGE,
  RELEASE_SETTINGS,
  RELEASE_SETTING_STATUS_LABELS,
  defineReleaseSetting,
  defineReleaseSettings,
  isReleaseSettingUnchanged,
  jsonbValueIssues,
  parseReleaseSettingChange,
  readReleaseSetting,
  releaseSettingChangeBodySchema,
  releaseSettingChangeListQuerySchema,
  releaseSettingKeySchema,
  releaseSettingValueJsonSchema,
  type ReleaseSettingValue,
} from './release-settings.js';

/** U+0000: PostgreSQL's jsonb cannot hold it. */
const NUL = String.fromCharCode(0);

const hours = defineReleaseSetting({
  key: 'test.period_hours',
  label: '시험 기간',
  unit: '시간',
  description: '시험용 항목',
  schema: z.number().int().min(1).max(720),
});

const window = defineReleaseSetting({
  key: 'test.window',
  label: '시험 구간',
  unit: null,
  description: '시험용 항목(객체 값)',
  schema: z.object({ from: z.number().int(), to: z.number().int() }).strict(),
});

describe('release settings registry', () => {
  it('ships empty: each item is registered by the issue that uses it', () => {
    expect([...RELEASE_SETTINGS.keys()]).toEqual([]);
  });

  it('labels every status, and only proposal and test are distinct from approved', () => {
    expect(RELEASE_SETTING_STATUSES).toEqual(['undecided', 'proposal', 'test', 'approved']);
    expect(RELEASE_SETTING_STATUS_LABELS).toEqual({
      undecided: '미정',
      proposal: '설계 제안',
      test: '시험값',
      approved: '승인됨',
    });
  });

  it('keeps registration order and refuses a duplicate or malformed key', () => {
    const registry = defineReleaseSettings([window, hours]);
    expect([...registry.keys()]).toEqual(['test.window', 'test.period_hours']);
    expect(registry.get('test.period_hours')).toBe(hours);

    expect(() => defineReleaseSettings([hours, { ...hours }])).toThrow(/registered twice/);
    for (const key of ['Test.hours', 'test..hours', '1st', 'test-hours', 'test.', 'a'.repeat(65)]) {
      expect(() => defineReleaseSetting({ ...hours, key })).toThrow(/must match/);
    }
    expect(() => defineReleaseSetting({ ...hours, label: ' ' })).toThrow(/label/);
    expect(() => defineReleaseSetting({ ...hours, description: '' })).toThrow(/description/);
    expect(() => defineReleaseSetting({ ...hours, unit: '' })).toThrow(/unit/);
  });

  it('records the change as its own admin action type', () => {
    expect(ADMIN_ACTION_TYPES).toContain('release_setting_change');
  });
});

describe('parseReleaseSettingChange', () => {
  it('takes no value while undecided and requires one otherwise', () => {
    for (const value of [undefined, null]) {
      expect(parseReleaseSettingChange(hours, { status: 'undecided', value })).toEqual({
        success: true,
        state: { status: 'undecided', value: null },
      });
    }
    expect(parseReleaseSettingChange(hours, { status: 'undecided', value: 24 })).toEqual({
      success: false,
      issues: [{ path: ['value'], message: 'must be omitted while the status is undecided' }],
    });
    for (const status of ['proposal', 'test', 'approved'] as const) {
      for (const value of [undefined, null]) {
        expect(parseReleaseSettingChange(hours, { status, value })).toEqual({
          success: false,
          issues: [{ path: ['value'], message: 'is required unless the status is undecided' }],
        });
      }
      expect(parseReleaseSettingChange(hours, { status, value: 24 })).toEqual({
        success: true,
        state: { status, value: 24 },
      });
    }
  });

  it('checks the value against the item, reporting paths under value', () => {
    const outOfRange = parseReleaseSettingChange(hours, { status: 'test', value: 0 });
    expect(outOfRange).toMatchObject({ success: false, issues: [{ path: ['value'] }] });
    expect(parseReleaseSettingChange(hours, { status: 'test', value: '24' }).success).toBe(false);

    const nested = parseReleaseSettingChange(window, {
      status: 'proposal',
      value: { from: 1, to: 'x' },
    });
    expect(nested).toMatchObject({ success: false, issues: [{ path: ['value', 'to'] }] });
    expect(
      parseReleaseSettingChange(window, { status: 'proposal', value: { from: 1, to: 2 } }),
    ).toEqual({ success: true, state: { status: 'proposal', value: { from: 1, to: 2 } } });
  });

  it('refuses a value jsonb cannot hold: NUL or a lone surrogate in a string or a key', () => {
    const json = defineReleaseSetting({
      key: 'test.json',
      label: '시험 JSON',
      unit: null,
      description: '시험용 항목(아무 JSON)',
      schema: z.json() as z.ZodType<ReleaseSettingValue>,
    });
    for (const [value, path, message] of [
      [NUL, ['value'], JSONB_NUL_MESSAGE],
      [`a${NUL}b`, ['value'], JSONB_NUL_MESSAGE],
      ['a\ud800', ['value'], JSONB_LONE_SURROGATE_MESSAGE],
      ['\udc00a', ['value'], JSONB_LONE_SURROGATE_MESSAGE],
      ['\ude00\ud83d', ['value'], JSONB_LONE_SURROGATE_MESSAGE],
      [['ok', [`x${NUL}`]], ['value', 1, 0], JSONB_NUL_MESSAGE],
      [{ list: [{ name: 'a\udbff' }] }, ['value', 'list', 0, 'name'], JSONB_LONE_SURROGATE_MESSAGE],
      [{ [`k${NUL}`]: 1 }, ['value', `k${NUL}`], `key ${JSONB_NUL_MESSAGE}`],
      [
        { inner: { '\ud800': true } },
        ['value', 'inner', '\ud800'],
        `key ${JSONB_LONE_SURROGATE_MESSAGE}`,
      ],
    ] as const) {
      expect(parseReleaseSettingChange(json, { status: 'test', value })).toEqual({
        success: false,
        issues: [{ path, message }],
      });
    }
    // A key and its value are each reported.
    expect(parseReleaseSettingChange(json, { status: 'test', value: { [NUL]: NUL } })).toEqual({
      success: false,
      issues: [
        { path: ['value', NUL], message: `key ${JSONB_NUL_MESSAGE}` },
        { path: ['value', NUL], message: JSONB_NUL_MESSAGE },
      ],
    });
    // Paired surrogates and other control characters are text jsonb holds.
    for (const value of ['😀', { '😀': 'a\u0001\u001f' }]) {
      expect(parseReleaseSettingChange(json, { status: 'test', value })).toEqual({
        success: true,
        state: { status: 'test', value },
      });
    }
    // What is stored is the schema's output: a key it drops is never written.
    const loose = defineReleaseSetting({
      ...window,
      schema: z.object({ from: z.number().int(), to: z.number().int() }),
    });
    expect(
      parseReleaseSettingChange(loose, { status: 'test', value: { from: 1, to: 2, [NUL]: NUL } }),
    ).toEqual({ success: true, state: { status: 'test', value: { from: 1, to: 2 } } });
  });
});

describe('jsonbValueIssues', () => {
  it('walks strings, arrays and object members, skipping undefined members as JSON does', () => {
    expect(jsonbValueIssues([1, true, null, 'ok', { a: 'b' }])).toEqual([]);
    expect(jsonbValueIssues({ [NUL]: undefined, a: undefined })).toEqual([]);
    expect(jsonbValueIssues(`${NUL}`, ['reason'])).toEqual([
      { path: ['reason'], message: JSONB_NUL_MESSAGE },
    ]);
  });
});

describe('isReleaseSettingUnchanged (owner decision: a change to the current state is refused)', () => {
  it('reads no row as undecided with no value', () => {
    expect(isReleaseSettingUnchanged(undefined, { status: 'undecided', value: null })).toBe(true);
    expect(isReleaseSettingUnchanged(undefined, { status: 'test', value: 24 })).toBe(false);
    const undecided = { status: 'undecided', value: null } as const;
    expect(isReleaseSettingUnchanged(undecided, { status: 'undecided', value: null })).toBe(true);
  });

  it('is a change when either the status or the value differs', () => {
    const current = { status: 'test', value: 24 } as const;
    expect(isReleaseSettingUnchanged(current, { status: 'test', value: 24 })).toBe(true);
    expect(isReleaseSettingUnchanged(current, { status: 'approved', value: 24 })).toBe(false);
    expect(isReleaseSettingUnchanged(current, { status: 'test', value: 25 })).toBe(false);
    expect(isReleaseSettingUnchanged(current, { status: 'undecided', value: null })).toBe(false);
    // A string that reads as the number is another value.
    expect(isReleaseSettingUnchanged(current, { status: 'test', value: '24' })).toBe(false);
  });

  it('compares values as jsonb does: deep, members in any order, undefined members absent', () => {
    const current = { status: 'proposal', value: { from: 1, to: [2, { at: 'x' }] } } as const;
    for (const value of [
      { to: [2, { at: 'x' }], from: 1 },
      { from: 1, to: [2, { at: 'x' }], note: undefined },
    ]) {
      expect(isReleaseSettingUnchanged(current, { status: 'proposal', value })).toBe(true);
    }
    for (const value of [
      { from: 1, to: [{ at: 'x' }, 2] },
      { from: 1, to: [2, { at: 'y' }] },
      { from: 1, to: [2, { at: 'x' }], note: null },
      { from: 1 },
      [1, [2, { at: 'x' }]],
    ]) {
      expect(isReleaseSettingUnchanged(current, { status: 'proposal', value })).toBe(false);
    }
    const list = { status: 'test', value: [1, 2] } as const;
    expect(isReleaseSettingUnchanged(list, { status: 'test', value: [1, 2] })).toBe(true);
    expect(isReleaseSettingUnchanged(list, { status: 'test', value: [1, 2, 3] })).toBe(false);
    expect(isReleaseSettingUnchanged(list, { status: 'test', value: { 0: 1, 1: 2 } })).toBe(false);
  });
});

describe('readReleaseSetting', () => {
  const registry = defineReleaseSettings([hours, window]);

  it('reads no row, or an undecided one, as undecided with no value', () => {
    const undecided = { key: 'test.period_hours', status: 'undecided', value: null };
    expect(readReleaseSetting(registry, hours, undefined)).toEqual(undecided);
    expect(readReleaseSetting(registry, hours, { status: 'undecided', value: null })).toEqual(
      undecided,
    );
  });

  it('types and returns a stored value with its status', () => {
    const reading = readReleaseSetting(registry, hours, { status: 'test', value: 48 });
    expect(reading).toEqual({ key: 'test.period_hours', status: 'test', value: 48 });
    if (reading.status !== 'undecided') {
      // Compile-time: the value is the schema's output type.
      const value: number = reading.value;
      expect(value).toBe(48);
    }
  });

  it('refuses a stored row that breaks the rule or no longer fits the schema', () => {
    expect(() => readReleaseSetting(registry, hours, { status: 'undecided', value: 24 })).toThrow(
      /undecided but holds a value/,
    );
    expect(() => readReleaseSetting(registry, hours, { status: 'approved', value: 'x' })).toThrow(
      /does not fit its schema/,
    );
  });

  it('reads only the very definition the registry holds', () => {
    const stored = { status: 'test', value: 48 } as const;
    // Another key, a copy of a registered definition, and the shipped (empty) registry.
    const unlisted = defineReleaseSetting({ ...hours, key: 'test.unlisted' });
    for (const [inRegistry, definition] of [
      [registry, unlisted],
      [registry, { ...hours }],
      [RELEASE_SETTINGS, hours],
    ] as const) {
      expect(() => readReleaseSetting(inRegistry, definition, stored)).toThrow(/is not registered/);
      expect(() => readReleaseSetting(inRegistry, definition, undefined)).toThrow(
        /is not registered/,
      );
    }
  });
});

describe('DTO schemas', () => {
  it('requires a trimmed, non-empty reason of at most 500 characters', () => {
    const body = { status: 'test', value: 24 };
    expect(
      releaseSettingChangeBodySchema.parse({ ...body, reason: '  시뮬레이션 반영  ' }),
    ).toEqual({
      ...body,
      reason: '시뮬레이션 반영',
    });
    for (const reason of [undefined, '', '   ', 'x'.repeat(501)]) {
      expect(releaseSettingChangeBodySchema.safeParse({ ...body, reason }).success).toBe(false);
    }
    expect(releaseSettingChangeBodySchema.safeParse({ status: 'final', reason: 'x' }).success).toBe(
      false,
    );
  });

  it('refuses a reason jsonb cannot hold, naming the reason (Codex #201)', () => {
    const body = { status: 'test', value: 24 };
    for (const [reason, message] of [
      [NUL, JSONB_NUL_MESSAGE],
      [`  ${NUL}  `, JSONB_NUL_MESSAGE],
      [`사유${NUL}끝`, JSONB_NUL_MESSAGE],
      ['사유\ud800', JSONB_LONE_SURROGATE_MESSAGE],
      ['\udc00사유', JSONB_LONE_SURROGATE_MESSAGE],
      ['\ude00\ud83d', JSONB_LONE_SURROGATE_MESSAGE],
    ] as const) {
      const parsed = releaseSettingChangeBodySchema.safeParse({ ...body, reason });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map(({ path, message: m }) => ({ path, message: m }))).toEqual([
        { path: ['reason'], message },
      ]);
    }
    // Paired surrogates and other control characters are text jsonb holds.
    for (const reason of ['😀', '사유\u0001\u001f끝']) {
      expect(releaseSettingChangeBodySchema.parse({ ...body, reason }).reason).toBe(reason);
    }
  });

  it('validates the key of a change-log filter like a registry key', () => {
    expect(releaseSettingKeySchema.safeParse('grant.initial_coin').success).toBe(true);
    expect(releaseSettingChangeListQuerySchema.parse({ key: 'test.period_hours' })).toEqual({
      key: 'test.period_hours',
      limit: 20,
    });
    expect(releaseSettingChangeListQuerySchema.safeParse({ key: 'DROP TABLE' }).success).toBe(
      false,
    );
  });

  it('describes the value an admin enters as JSON Schema', () => {
    expect(releaseSettingValueJsonSchema(hours)).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 720,
    });
    expect(releaseSettingValueJsonSchema(window)).toMatchObject({
      type: 'object',
      required: ['from', 'to'],
    });
  });
});
