import {
  RELEASE_SETTING_REASON_MAX_LENGTH,
  RELEASE_SETTING_STATUSES,
  RELEASE_SETTING_STATUS_LABELS,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type ReleaseSetting } from './api';
import {
  NO_VALUE,
  RELEASE_SETTING_STATUS_BADGE,
  RELEASE_SETTING_STATUS_HINT,
  formatReleaseSettingState,
  formatReleaseSettingValue,
  parseReleaseSettingValueText,
  releaseSettingChangeRefusal,
  releaseSettingFormDefaults,
  releaseSettingFormSchema,
  releaseSettingSchemaHint,
  releaseSettingStatusLabel,
  releaseSettingValueInput,
  releaseSettingValueText,
  releaseSettingsView,
  replaceReleaseSetting,
  toReleaseSettingChangeBody,
} from './release-settings';

const INTEGER = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'integer',
  minimum: 1,
};
const STRING = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' };
const OBJECT = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { hours: { type: 'integer' } },
};

function item(overrides: Partial<ReleaseSetting> = {}): ReleaseSetting {
  return {
    key: 'test.grant_coin',
    label: '시험 지급액',
    unit: 'Coin',
    description: '시험용 항목',
    valueSchema: INTEGER,
    status: 'undecided',
    value: null,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);

/** The message the form shows for one field, or undefined when that field is accepted. */
function fieldError(
  schema: ReturnType<typeof releaseSettingFormSchema>,
  values: { status: string; value: string; reason: string },
  field: string,
): string | undefined {
  const result = schema.safeParse(values);
  if (result.success) return undefined;
  return result.error.issues.find((issue) => issue.path[0] === field)?.message;
}

describe('status', () => {
  it('names every status with the shared labels', () => {
    for (const status of RELEASE_SETTING_STATUSES) {
      expect(releaseSettingStatusLabel(status)).toBe(RELEASE_SETTING_STATUS_LABELS[status]);
      expect(RELEASE_SETTING_STATUS_HINT[status].trim()).not.toBe('');
    }
    expect(releaseSettingStatusLabel('proposal')).toBe('설계 제안');
    expect(releaseSettingStatusLabel('test')).toBe('시험값');
  });

  it('never draws a proposal or a test value like an approved one (N01 §10, owner decision)', () => {
    const approved = RELEASE_SETTING_STATUS_BADGE.approved;
    const palettes = new Set(
      RELEASE_SETTING_STATUSES.map((status) => RELEASE_SETTING_STATUS_BADGE[status].palette),
    );
    // Four statuses, four palettes, and brand (a settled value) is approved's alone.
    expect(palettes.size).toBe(RELEASE_SETTING_STATUSES.length);
    expect(approved.palette).toBe('brand');
    // 미정 is the one that needs attention (#149): solid, unlike the three that hold a value.
    expect(RELEASE_SETTING_STATUS_BADGE.undecided.variant).toBe('solid');
  });

  it('says in the legend that a proposal and a test value are not the release value', () => {
    expect(RELEASE_SETTING_STATUS_HINT.proposal).toContain('승인된 값이 아닙니다');
    expect(RELEASE_SETTING_STATUS_HINT.test).toContain('출시 값이 아닙니다');
  });
});

describe('formatReleaseSettingValue', () => {
  it('reads each kind of value', () => {
    expect(formatReleaseSettingValue(null)).toBe(NO_VALUE);
    expect(formatReleaseSettingValue(10000)).toBe('10,000');
    expect(formatReleaseSettingValue(0.25)).toBe('0.25');
    expect(formatReleaseSettingValue('24h')).toBe('24h');
    expect(formatReleaseSettingValue('')).toBe('""');
    expect(formatReleaseSettingValue(true)).toBe('true');
    expect(formatReleaseSettingValue([1, 2])).toBe('[1,2]');
    expect(formatReleaseSettingValue({ hours: 24 })).toBe('{"hours":24}');
  });

  it('writes one side of a change as the status and its value', () => {
    expect(formatReleaseSettingState({ status: 'undecided', value: null })).toBe('미정');
    expect(formatReleaseSettingState({ status: 'test', value: 24 })).toBe('시험값 24');
    expect(formatReleaseSettingState({ status: 'proposal', value: 'a' })).toBe('설계 제안 a');
  });
});

describe('value input', () => {
  it('takes a string item as written and everything else as JSON', () => {
    expect(releaseSettingValueInput(STRING)).toEqual({ kind: 'text', multiline: false });
    expect(releaseSettingValueInput(INTEGER)).toEqual({ kind: 'json', multiline: false });
    expect(releaseSettingValueInput({ type: 'boolean' })).toEqual({
      kind: 'json',
      multiline: false,
    });
    expect(releaseSettingValueInput(OBJECT)).toEqual({ kind: 'json', multiline: true });
    expect(releaseSettingValueInput({ anyOf: [] })).toEqual({ kind: 'json', multiline: true });
  });

  it('starts the field from the stored value, round-tripping through the parser', () => {
    expect(releaseSettingValueText(null, INTEGER)).toBe('');
    expect(releaseSettingValueText(24, INTEGER)).toBe('24');
    expect(releaseSettingValueText('"quoted"', STRING)).toBe('"quoted"');
    expect(releaseSettingValueText({ hours: 24 }, OBJECT)).toBe('{\n  "hours": 24\n}');
    for (const [value, schema] of [
      [24, INTEGER],
      ['"quoted"', STRING],
      [{ hours: 24 }, OBJECT],
    ] as const) {
      expect(parseReleaseSettingValueText(releaseSettingValueText(value, schema), schema)).toEqual({
        ok: true,
        value,
      });
    }
  });

  it('refuses a blank, a JSON null and unreadable JSON', () => {
    expect(parseReleaseSettingValueText('  ', INTEGER)).toEqual({
      ok: false,
      message: copy.errReleaseSettingValueRequired,
    });
    expect(parseReleaseSettingValueText('', STRING)).toEqual({
      ok: false,
      message: copy.errReleaseSettingValueRequired,
    });
    expect(parseReleaseSettingValueText('null', INTEGER)).toEqual({
      ok: false,
      message: copy.errReleaseSettingValueRequired,
    });
    expect(parseReleaseSettingValueText('24시간', INTEGER)).toEqual({
      ok: false,
      message: copy.errReleaseSettingValueFormat,
    });
    // A string item takes text that merely looks like JSON as text.
    expect(parseReleaseSettingValueText('24', STRING)).toEqual({ ok: true, value: '24' });
  });

  it('shows the value shape without the $schema line', () => {
    expect(releaseSettingSchemaHint(INTEGER)).toBe('{"type":"integer","minimum":1}');
  });
});

describe('releaseSettingFormSchema', () => {
  const schema = releaseSettingFormSchema(INTEGER);

  it('requires a reason of 1–500 characters', () => {
    // The copy states the limit the API enforces.
    expect(copy.errReleaseSettingReason).toContain(String(RELEASE_SETTING_REASON_MAX_LENGTH));
    expect(fieldError(schema, { status: 'test', value: '24', reason: '  ' }, 'reason')).toBe(
      copy.errReleaseSettingReason,
    );
    const long = 'a'.repeat(RELEASE_SETTING_REASON_MAX_LENGTH + 1);
    expect(fieldError(schema, { status: 'test', value: '24', reason: long }, 'reason')).toBe(
      copy.errReleaseSettingReason,
    );
    expect(schema.safeParse({ status: 'test', value: '24', reason: ' 시험 ' }).data).toEqual({
      status: 'test',
      value: '24',
      reason: '시험',
    });
  });

  it('requires a value unless 미정, and reports it beside a refused reason', () => {
    const blank = { status: 'approved', value: '', reason: '' };
    expect(fieldError(schema, blank, 'value')).toBe(copy.errReleaseSettingValueRequired);
    expect(fieldError(schema, blank, 'reason')).toBe(copy.errReleaseSettingReason);
    expect(fieldError(schema, { status: 'proposal', value: '{', reason: 'x' }, 'value')).toBe(
      copy.errReleaseSettingValueFormat,
    );
    // 미정 takes whatever the hidden field still holds and drops it.
    expect(schema.safeParse({ status: 'undecided', value: '{', reason: 'x' }).success).toBe(true);
  });
});

describe('toReleaseSettingChangeBody', () => {
  it('sends no value while 미정, and the parsed value otherwise', () => {
    expect(
      toReleaseSettingChangeBody({ status: 'undecided', value: '24', reason: '보류' }, INTEGER),
    ).toEqual({ status: 'undecided', reason: '보류' });
    expect(
      toReleaseSettingChangeBody({ status: 'test', value: '24', reason: '시험' }, INTEGER),
    ).toEqual({ status: 'test', value: 24, reason: '시험' });
    expect(
      toReleaseSettingChangeBody({ status: 'approved', value: '24', reason: '승인' }, STRING),
    ).toEqual({ status: 'approved', value: '24', reason: '승인' });
  });

  it('starts the dialog from the item as it stands, with no reason', () => {
    expect(releaseSettingFormDefaults(item({ status: 'test', value: 500 }))).toEqual({
      status: 'test',
      value: '500',
      reason: '',
    });
    expect(releaseSettingFormDefaults(item())).toEqual({
      status: 'undecided',
      value: '',
      reason: '',
    });
  });
});

describe('releaseSettingChangeRefusal', () => {
  it('puts a refused reason or value under its field', () => {
    expect(
      releaseSettingChangeRefusal(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'x' }]),
      ),
    ).toEqual({ field: 'reason', message: copy.errReleaseSettingReason });
    expect(
      releaseSettingChangeRefusal(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['value', 'hours'], message: 'x' }]),
      ),
    ).toEqual({ field: 'value', message: copy.errReleaseSettingValueInvalid });
  });

  it('closes on an answer about the item or the account, and stays when nothing came back', () => {
    expect(releaseSettingChangeRefusal(apiError(404, 'NOT_FOUND'))).toEqual({
      toast: copy.errReleaseSettingNotFound,
      keepDialog: false,
    });
    expect(releaseSettingChangeRefusal(apiError(403, 'FORBIDDEN'))).toEqual({
      toast: copy.adminOnly,
      keepDialog: false,
    });
    expect(releaseSettingChangeRefusal(apiError(401, 'UNAUTHENTICATED'))).toEqual({
      toast: copy.errUnauthenticated,
      keepDialog: false,
    });
    expect(releaseSettingChangeRefusal(apiError(500, 'INTERNAL'))).toEqual({
      toast: copy.errUnknown,
      keepDialog: false,
    });
    expect(releaseSettingChangeRefusal(new TypeError('Failed to fetch'))).toEqual({
      toast: copy.errUnknown,
      keepDialog: true,
    });
  });
});

describe('releaseSettingsView', () => {
  const items = [
    item({ key: 'a', status: 'approved', value: 1 }),
    item({ key: 'b' }),
    item({ key: 'c', status: 'test', value: 2 }),
    item({ key: 'd' }),
  ];

  it('says the registry is empty whichever view is on', () => {
    for (const undecidedOnly of [false, true]) {
      expect(releaseSettingsView([], undecidedOnly)).toEqual({
        rows: [],
        count: '전체 0개 · 미정 0개',
        empty: copy.adminReleaseSettingsEmpty,
      });
    }
  });

  it('lists every item, or the 미정 ones only, in registry order', () => {
    const all = releaseSettingsView(items, false);
    expect(all.rows.map((row) => row.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(all.count).toBe('전체 4개 · 미정 2개');
    expect(all.empty).toBeNull();
    expect(releaseSettingsView(items, true).rows.map((row) => row.key)).toEqual(['b', 'd']);
  });

  it('says no item is 미정 when every registered one has a value', () => {
    const decided = items.filter((row) => row.status !== 'undecided');
    expect(releaseSettingsView(decided, true)).toEqual({
      rows: [],
      count: '전체 2개 · 미정 0개',
      empty: copy.adminReleaseSettingsNoUndecided,
    });
  });
});

describe('replaceReleaseSetting', () => {
  it('writes the answered item over its copy and leaves an unknown one alone', () => {
    const list = [item({ key: 'a' }), item({ key: 'b' })];
    const fresh = item({ key: 'b', status: 'test', value: 3 });
    expect(replaceReleaseSetting(list, fresh)).toEqual([list[0], fresh]);
    expect(replaceReleaseSetting(list, item({ key: 'z' }))).toBe(list);
    expect(replaceReleaseSetting(undefined, fresh)).toBeUndefined();
  });
});
