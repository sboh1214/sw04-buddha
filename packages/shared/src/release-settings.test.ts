import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { ADMIN_ACTION_TYPES, RELEASE_SETTING_STATUSES } from './enums.js';
import {
  RELEASE_SETTINGS,
  RELEASE_SETTING_STATUS_LABELS,
  defineReleaseSetting,
  defineReleaseSettings,
  parseReleaseSettingChange,
  readReleaseSetting,
  releaseSettingChangeBodySchema,
  releaseSettingChangeListQuerySchema,
  releaseSettingKeySchema,
  releaseSettingValueJsonSchema,
} from './release-settings.js';

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
