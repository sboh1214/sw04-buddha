import {
  RELEASE_SETTING_REASON_MAX_LENGTH,
  RELEASE_SETTING_STATUS_LABELS,
  RELEASE_SETTING_UNCHANGED_MESSAGE,
  type ReleaseSettingStatus,
  isReleaseSettingUnchanged,
  releaseSettingStatusSchema,
} from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import {
  isApiError,
  type ReleaseSetting,
  type ReleaseSettingChangeBody,
  type ReleaseSettingState,
  validationField,
  validationMessage,
} from './api';
import { compactJson } from './market-admin';

/**
 * Pure helpers behind 출시 설정 (`/admin/settings`, #170, ADR-0055): the status badge, how a value
 * reads and how it is typed, the change form and its refusals, and the undecided-only view. The
 * screen knows no item: what an item is (name, unit, meaning, value shape) arrives with it from
 * `GET /admin/release-settings`, and the server checks every value against the item's schema.
 */

/** The status names, shared with the API docs and docs/SETTINGS.md (`@buddha/shared`). */
export function releaseSettingStatusLabel(status: ReleaseSettingStatus): string {
  return RELEASE_SETTING_STATUS_LABELS[status];
}

/** What each status means, as the screen's legend says it. */
export const RELEASE_SETTING_STATUS_HINT: Readonly<Record<ReleaseSettingStatus, string>> = {
  undecided: copy.adminReleaseSettingUndecidedHint,
  proposal: copy.adminReleaseSettingProposalHint,
  test: copy.adminReleaseSettingTestHint,
  approved: copy.adminReleaseSettingApprovedHint,
};

/**
 * The badge of each status. Only 승인됨 wears brand, the colour of a settled value; 설계 제안 and
 * 시험값 have palettes of their own, so neither reads as the release value (N01 §10, owner
 * decision 2026-10-13: test values shown apart from release values). 미정 is the solid orange
 * "needs attention" of the 판정 대기 badge: it is what #149's launch check looks for. Never colour
 * alone — the label is inside every badge (PLAN 11.2).
 */
export const RELEASE_SETTING_STATUS_BADGE: Readonly<
  Record<ReleaseSettingStatus, { palette: string; variant: 'solid' | 'subtle' }>
> = {
  undecided: { palette: 'orange', variant: 'solid' },
  proposal: { palette: 'purple', variant: 'subtle' },
  test: { palette: 'blue', variant: 'subtle' },
  approved: { palette: 'brand', variant: 'subtle' },
};

/** What a missing value reads as (an `undecided` item). */
export const NO_VALUE = '—';

/**
 * A value as the list and the change log show it: a string as written (an empty one quoted, so it
 * is not a blank), a number grouped for reading, anything else as one line of JSON. The unit is
 * shown beside it, never joined to it.
 */
export function formatReleaseSettingValue(value: unknown): string {
  if (value === null || value === undefined) return NO_VALUE;
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number') {
    return value.toLocaleString('ko-KR', { maximumFractionDigits: 20 });
  }
  return compactJson(value);
}

/** A status and its value, one side of a change: `시험값 24`, or `미정` with no value. */
export function formatReleaseSettingState(state: ReleaseSettingState): string {
  const label = releaseSettingStatusLabel(state.status);
  return state.status === 'undecided' || state.value === null
    ? label
    : `${label} ${formatReleaseSettingValue(state.value)}`;
}

/** The JSON Schema `GET /admin/release-settings` sends as `valueSchema`. */
type ValueSchema = ReleaseSetting['valueSchema'];

/**
 * How the value field is typed. An item whose value is a string takes the text as written —
 * no quotes to type; every other item (a number, a flag, a list, an object) takes JSON, in a
 * multi-line box when it is a list or an object, or when the schema does not say.
 */
export function releaseSettingValueInput(valueSchema: ValueSchema): {
  kind: 'text' | 'json';
  multiline: boolean;
} {
  const { type } = valueSchema;
  if (type === 'string') return { kind: 'text', multiline: false };
  return {
    kind: 'json',
    multiline: !(type === 'number' || type === 'integer' || type === 'boolean'),
  };
}

/** The value field's starting text for a stored value; blank while there is none (or it is ""). */
export function releaseSettingValueText(value: unknown, valueSchema: ValueSchema): string {
  if (value === null || value === undefined) return '';
  const input = releaseSettingValueInput(valueSchema);
  if (input.kind === 'text' && typeof value === 'string') return value;
  return JSON.stringify(value, null, input.multiline ? 2 : undefined);
}

/**
 * The value an admin typed, or why it cannot be one. A string item takes the text exactly as
 * typed, blank included: an empty string is a value its schema may take or refuse. For any other
 * item blank is no value, and so is JSON `null` (null is how the API says "none"); whether the
 * value fits the item is the server's to say.
 */
export function parseReleaseSettingValueText(
  text: string,
  valueSchema: ValueSchema,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (releaseSettingValueInput(valueSchema).kind === 'text') return { ok: true, value: text };
  if (text.trim() === '') return { ok: false, message: copy.errReleaseSettingValueRequired };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: copy.errReleaseSettingValueFormat };
  }
  return value === null
    ? { ok: false, message: copy.errReleaseSettingValueRequired }
    : { ok: true, value };
}

/** The change dialog's fields: the value as typed, parsed only when the form is sent. */
export interface ReleaseSettingFormValues {
  status: ReleaseSettingStatus;
  value: string;
  reason: string;
}

/**
 * The change form's rules (`ReleaseSettingChangeBody`): a reason of 1–500 characters, and a value
 * unless the status is 미정 — which drops whatever the value field holds (a string item's field
 * always reads as one, `parseReleaseSettingValueText`). The value check is on the object, so it
 * runs (and reports) beside a refused reason rather than after it.
 */
export function releaseSettingFormSchema(valueSchema: ValueSchema) {
  return z
    .object({
      status: releaseSettingStatusSchema,
      value: z.string(),
      reason: z
        .string()
        .trim()
        .min(1, copy.errReleaseSettingReason)
        .max(RELEASE_SETTING_REASON_MAX_LENGTH, copy.errReleaseSettingReason),
    })
    .superRefine((values, ctx) => {
      if (values.status === 'undecided') return;
      const parsed = parseReleaseSettingValueText(values.value, valueSchema);
      if (!parsed.ok) ctx.addIssue({ code: 'custom', path: ['value'], message: parsed.message });
    });
}

/** The dialog's starting values: the item as it stands, and no reason yet. */
export function releaseSettingFormDefaults(item: ReleaseSetting): ReleaseSettingFormValues {
  return {
    status: item.status,
    value: releaseSettingValueText(item.value, item.valueSchema),
    reason: '',
  };
}

/** The request body for a form that passed `releaseSettingFormSchema`: no value while 미정. */
export function toReleaseSettingChangeBody(
  values: ReleaseSettingFormValues,
  valueSchema: ValueSchema,
): ReleaseSettingChangeBody {
  if (values.status === 'undecided') return { status: values.status, reason: values.reason };
  const parsed = parseReleaseSettingValueText(values.value, valueSchema);
  if (!parsed.ok) throw new Error('the release setting form was sent with an unreadable value');
  return { status: values.status, value: parsed.value, reason: values.reason };
}

/**
 * Whether the dialog, as filled, would leave the item as it stands: the same status and the value
 * it would send (none while 미정) — a change the API refuses (owner decision 2026-10-13~14, #170),
 * so 저장 is off and the dialog says 바뀐 내용이 없습니다. A value that cannot be read yet is not
 * "unchanged": sending it reports why under the field. The server compares what the item's
 * schema makes of the value, against the item as it is by then, so it may still refuse a change
 * this calls one (`releaseSettingChangeRefusal`).
 */
export function releaseSettingFormUnchanged(
  values: Pick<ReleaseSettingFormValues, 'status' | 'value'>,
  item: Pick<ReleaseSetting, 'status' | 'value' | 'valueSchema'>,
): boolean {
  const current = { status: item.status, value: item.value };
  if (values.status === 'undecided') {
    return isReleaseSettingUnchanged(current, { status: values.status, value: null });
  }
  const parsed = parseReleaseSettingValueText(values.value, item.valueSchema);
  return (
    parsed.ok && isReleaseSettingUnchanged(current, { status: values.status, value: parsed.value })
  );
}

/**
 * What the dialog does with a refused change.
 * - `field`: the reason or the value was refused; the message goes under that field and the
 *   dialog stays for the fix.
 * - `toast`: anything else, with its `tone` — `info` for a change the API found unchanged
 *   (another admin made it first, or the item's schema made the value the stored one: the item
 *   already is what the admin asked for), `error` otherwise. `keepDialog` only when the request
 *   never came back (nothing was decided, so the admin may send it again); an answer from the API
 *   closes it, and the list is refreshed to what the server now holds.
 */
export type ReleaseSettingChangeRefusal =
  | { field: 'reason' | 'value'; message: string }
  | { toast: string; tone: 'error' | 'info'; keepDialog: boolean };

export function releaseSettingChangeRefusal(error: unknown): ReleaseSettingChangeRefusal {
  if (!isApiError(error)) return { toast: copy.errUnknown, tone: 'error', keepDialog: true };
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'reason') return { field, message: copy.errReleaseSettingReason };
    if (field === 'value') return { field, message: copy.errReleaseSettingValueInvalid };
    if (validationMessage(error) === RELEASE_SETTING_UNCHANGED_MESSAGE) {
      return { toast: copy.adminReleaseSettingUnchanged, tone: 'info', keepDialog: false };
    }
    return { toast: copy.errUnknown, tone: 'error', keepDialog: true };
  }
  if (isApiError(error, 'NOT_FOUND')) {
    return { toast: copy.errReleaseSettingNotFound, tone: 'error', keepDialog: false };
  }
  if (isApiError(error, 'UNAUTHENTICATED')) {
    return { toast: copy.errUnauthenticated, tone: 'error', keepDialog: false };
  }
  if (isApiError(error, 'FORBIDDEN')) {
    return { toast: copy.adminOnly, tone: 'error', keepDialog: false };
  }
  return { toast: copy.errUnknown, tone: 'error', keepDialog: false };
}

/**
 * The list as the screen shows it: every item, or only the 미정 ones (`undecidedOnly`, which #149's
 * launch check reads), in registry order, with the counts beside the toggle and the empty line —
 * 등록된 항목이 없습니다 whenever the registry itself is empty, whichever view is on.
 */
export function releaseSettingsView<T extends Pick<ReleaseSetting, 'status'>>(
  items: readonly T[],
  undecidedOnly: boolean,
): { rows: T[]; count: string; empty: string | null } {
  const undecided = items.filter((item) => item.status === 'undecided');
  const rows = undecidedOnly ? undecided : [...items];
  const unit = copy.adminReleaseSettingsCountUnit;
  const count =
    `${copy.adminReleaseSettingsTotal} ${String(items.length)}${unit} · ` +
    `${releaseSettingStatusLabel('undecided')} ${String(undecided.length)}${unit}`;
  const empty =
    items.length === 0
      ? copy.adminReleaseSettingsEmpty
      : rows.length === 0
        ? copy.adminReleaseSettingsNoUndecided
        : null;
  return { rows, count, empty };
}

/**
 * The changed item as the API answered it, written over its copy in the cached list — the seed
 * that keeps the list honest if the refetch after it fails. An item the list does not hold
 * leaves it as it was.
 */
export function replaceReleaseSetting(
  list: readonly ReleaseSetting[] | undefined,
  fresh: ReleaseSetting,
): readonly ReleaseSetting[] | undefined {
  if (list === undefined || !list.some((item) => item.key === fresh.key)) return list;
  return list.map((item) => (item.key === fresh.key ? fresh : item));
}

/** The JSON Schema of a value, as the dialog's 입력 형식 line: one line, without `$schema`. */
export function releaseSettingSchemaHint(valueSchema: ValueSchema): string {
  const { $schema: _ignored, ...rest } = valueSchema;
  return compactJson(rest);
}
