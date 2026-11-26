import {
  APPROVAL_REASON_MAX_LENGTH,
  RELEASE_SETTING_REASON_MAX_LENGTH,
  RELEASE_SETTING_STAGE_SLOTS,
  RELEASE_SETTING_STATUS_LABELS,
  RELEASE_SETTING_UNCHANGED_MESSAGE,
  type ApprovalStatus,
  type ReleaseSettingApprovalRule,
  type ReleaseSettingChangeBasis,
  type ReleaseSettingChangePath,
  type ReleaseSettingRefusal,
  type ReleaseSettingStageSlot,
  type ReleaseSettingState as SharedReleaseSettingState,
  type ReleaseSettingStatus,
  classifyReleaseSettingChange,
  isReleaseSettingUnchanged,
  releaseSettingNotAllowedDetailsSchema,
  releaseSettingStatusSchema,
} from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import {
  isApiError,
  isForAnotherAccount,
  type ReleaseSetting,
  type ReleaseSettingChangeBody,
  type ReleaseSettingChangeRequest,
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
    const shown = value.toLocaleString('ko-KR', { maximumFractionDigits: 20 });
    // A valid small curve coefficient must not be displayed as zero.
    return value !== 0 && Number(shown.replaceAll(',', '')) === 0 ? String(value) : shown;
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

/**
 * The request body for a form that passed `releaseSettingFormSchema`: no value while 미정. And the
 * admin on screen, who changes it (`useOperatorId`, ADR-0092: the server refuses another account's).
 */
export function toReleaseSettingChangeBody(
  values: ReleaseSettingFormValues,
  valueSchema: ValueSchema,
  operatorId: string,
): ReleaseSettingChangeBody {
  if (values.status === 'undecided') {
    return { status: values.status, reason: values.reason, expectedAccountId: operatorId };
  }
  const parsed = parseReleaseSettingValueText(values.value, valueSchema);
  if (!parsed.ok) throw new Error('the release setting form was sent with an unreadable value');
  return {
    status: values.status,
    value: parsed.value,
    reason: values.reason,
    expectedAccountId: operatorId,
  };
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

/** What each refusal of RELEASE_SETTING_NOT_ALLOWED says. */
const REFUSAL_MESSAGE: Readonly<Record<ReleaseSettingRefusal, string>> = {
  request_pending: copy.errReleaseSettingRequestPending,
  stale: copy.errReleaseSettingStale,
  requester_ineligible: copy.errReleaseSettingRequesterIneligible,
};

/** The two-person rule's refusals (APPROVAL_NOT_ALLOWED), as the other approval screens say them. */
const APPROVAL_MESSAGE: Readonly<Record<string, string>> = {
  no_decider: copy.errReleaseSettingNoDecider,
  requester: copy.errApprovalRequester,
  decided: copy.errApprovalDecided,
  retracted: copy.errApprovalRetracted,
  not_requester: copy.errApprovalNotRequester,
};

/**
 * What the dialog does with a refused change.
 * - `field`: the reason or the value was refused; the message goes under that field and the
 *   dialog stays for the fix.
 * - `toast`: anything else, with its `tone` — `info` for a change the API found unchanged
 *   (another admin made it first, or the item's schema made the value the stored one: the item
 *   already is what the admin asked for), `error` otherwise. `keepDialog` only when the request
 *   never came back (nothing was decided, so the admin may send it again); an answer from the API
 *   closes it, and the list is refreshed to what the server now holds — the cookie of another
 *   account too (`copy.sessionChanged`: nothing was changed, and the session is asked again,
 *   whose reset reads everything — ADR-0092).
 */
export type ReleaseSettingChangeRefusal =
  | { field: 'reason' | 'value'; message: string }
  | { toast: string; tone: 'error' | 'info'; keepDialog: boolean };

export function releaseSettingChangeRefusal(error: unknown): ReleaseSettingChangeRefusal {
  if (!isApiError(error)) return { toast: copy.errUnknown, tone: 'error', keepDialog: true };
  // Each code check below narrows `error` away from ApiError once it fails; the details are read
  // from the error as it came.
  const { details: errorDetails } = error;
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
  // #331: a two-admin change of a key whose request waits, or one no other admin could decide.
  if (isApiError(error, 'RELEASE_SETTING_NOT_ALLOWED')) {
    const details = releaseSettingNotAllowedDetailsSchema.safeParse(errorDetails);
    return {
      toast: details.success ? REFUSAL_MESSAGE[details.data.reason] : copy.errUnknown,
      tone: 'error',
      keepDialog: false,
    };
  }
  if (isApiError(error, 'APPROVAL_NOT_ALLOWED')) {
    const reason = validationMessage(error);
    return {
      toast:
        reason !== undefined && Object.hasOwn(APPROVAL_MESSAGE, reason)
          ? APPROVAL_MESSAGE[reason]!
          : copy.errUnknown,
      tone: 'error',
      keepDialog: false,
    };
  }
  if (isApiError(error, 'UNAUTHENTICATED')) {
    return { toast: copy.errUnauthenticated, tone: 'error', keepDialog: false };
  }
  if (isForAnotherAccount(error)) {
    return { toast: copy.sessionChanged, tone: 'error', keepDialog: false };
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

// ---- 묶음별 승인 (#331, ADR-0175) -------------------------------------------------------------

/**
 * An item's approval rule in one line (the list's '변경 승인'): its group and which changes one admin
 * makes at once. That 승인됨 is two admins' for every item is said once, under the legend.
 */
export function releaseSettingApprovalSummary(rule: ReleaseSettingApprovalRule): string {
  if (rule.group === 'observation') return copy.adminReleaseSettingRuleObservation;
  if (rule.group === 'order_intake') return copy.adminReleaseSettingRuleIntake;
  if (rule.group === 'retention') return copy.adminReleaseSettingRuleRetention;
  if (rule.stage !== undefined) return copy.adminReleaseSettingRuleStage;
  if (rule.undecided === 'block') return copy.adminReleaseSettingRuleDisputeWindow;
  if (rule.undecided === 'loosen') return copy.adminReleaseSettingRuleRateLimit;
  if (rule.reduce === 'lower') return copy.adminReleaseSettingRuleLower;
  if (rule.reduce === 'higher') return copy.adminReleaseSettingRuleHigher;
  return copy.adminReleaseSettingRuleNoDirection;
}

/** Why a change takes its path, as the dialog, the requests and the change log say it. */
export const RELEASE_SETTING_BASIS_TEXT: Readonly<Record<ReleaseSettingChangeBasis, string>> = {
  approved_target: copy.adminReleaseSettingBasisApprovedTarget,
  status_only: copy.adminReleaseSettingBasisStatusOnly,
  observation: copy.adminReleaseSettingBasisObservation,
  intake_open: copy.adminReleaseSettingBasisIntakeOpen,
  intake_close: copy.adminReleaseSettingBasisIntakeClose,
  undecided_stop: copy.adminReleaseSettingBasisUndecidedStop,
  undecided_loosens: copy.adminReleaseSettingBasisUndecidedLoosens,
  undecided_blocks: copy.adminReleaseSettingBasisUndecidedBlocks,
  enter_value: copy.adminReleaseSettingBasisEnterValue,
  enter_tightens: copy.adminReleaseSettingBasisEnterTightens,
  stage_stop: copy.adminReleaseSettingBasisStageStop,
  stage_resume: copy.adminReleaseSettingBasisStageResume,
  reduce: copy.adminReleaseSettingBasisReduce,
  increase: copy.adminReleaseSettingBasisIncrease,
  no_direction: copy.adminReleaseSettingBasisNoDirection,
};

/** The change log's badge of a path: 1인 즉시, 2인 승인, or none for a record before #331. */
export function releaseSettingPathBadge(path: ReleaseSettingChangePath | null): string {
  if (path === 'one_admin') return copy.adminReleaseSettingPathOneBadge;
  if (path === 'two_admin') return copy.adminReleaseSettingPathTwoBadge;
  return NO_VALUE;
}

/** A request's status as the requests list names it. */
export const RELEASE_SETTING_REQUEST_STATUS: Readonly<Record<ApprovalStatus, string>> = {
  pending: copy.adminReleaseSettingStatusPending,
  approved: copy.adminReleaseSettingStatusApproved,
  rejected: copy.adminReleaseSettingStatusRejected,
  retracted: copy.adminReleaseSettingStatusRetracted,
};

/** The three risk stages' states as the list holds them, by slot (#129). */
function stageStates(
  items: readonly Pick<ReleaseSetting, 'status' | 'value' | 'approval'>[],
): Record<ReleaseSettingStageSlot, SharedReleaseSettingState | undefined> {
  const states = Object.fromEntries(
    RELEASE_SETTING_STAGE_SLOTS.map((slot) => [slot, undefined]),
  ) as Record<ReleaseSettingStageSlot, SharedReleaseSettingState | undefined>;
  for (const item of items) {
    const { approval } = item;
    if ('stage' in approval && approval.stage !== undefined) {
      states[approval.stage] = { status: item.status, value: item.value };
    }
  }
  return states;
}

/**
 * The path the dialog's change would take, as the server will judge it
 * (`classifyReleaseSettingChange` on the item and the list as the screen holds them): null while the
 * change is no change or its value cannot be read yet. `blocked`: a two-admin change of an item
 * whose request waits (`request_pending`). `approvedHint`: an item at 승인됨 asked to stay there
 * with a new value — saying how to make it one admin's (331-6). The server reads the row again
 * under its lock, so its answer is the one that counts.
 */
export function releaseSettingChangePreview(
  values: Pick<ReleaseSettingFormValues, 'status' | 'value'>,
  item: Pick<ReleaseSetting, 'status' | 'value' | 'valueSchema' | 'approval' | 'pendingRequest'>,
  items: readonly Pick<ReleaseSetting, 'status' | 'value' | 'approval'>[],
): {
  path: ReleaseSettingChangePath;
  basis: ReleaseSettingChangeBasis;
  message: string;
  blocked: boolean;
  approvedHint: boolean;
} | null {
  let after: SharedReleaseSettingState;
  if (values.status === 'undecided') after = { status: 'undecided', value: null };
  else {
    const parsed = parseReleaseSettingValueText(values.value, item.valueSchema);
    if (!parsed.ok) return null;
    after = { status: values.status, value: parsed.value };
  }
  const current = { status: item.status, value: item.value };
  const { approval } = item;
  const stages =
    'stage' in approval && approval.stage !== undefined ? stageStates(items) : undefined;
  const result = classifyReleaseSettingChange(approval, current, after, stages);
  if (result.path === 'unchanged') return null;
  const basis = RELEASE_SETTING_BASIS_TEXT[result.basis];
  const two = result.path === 'two_admin';
  return {
    path: result.path,
    basis: result.basis,
    message: `${two ? copy.adminReleaseSettingPathTwo : copy.adminReleaseSettingPathOne} (${basis})`,
    blocked: two && item.pendingRequest !== null,
    approvedHint:
      two &&
      item.status === 'approved' &&
      after.status === 'approved' &&
      classifyReleaseSettingChange(approval, current, { ...after, status: 'test' }, stages).path ===
        'one_admin',
  };
}

/** The reason a decision takes: 1–500 characters after trimming, as `approvalReasonSchema`. */
export function releaseSettingDecisionReasonError(reason: string): string | undefined {
  const trimmed = reason.trim();
  return trimmed.length === 0 || trimmed.length > APPROVAL_REASON_MAX_LENGTH
    ? copy.errReleaseSettingDecisionReason
    : undefined;
}

/**
 * What the screen says of a refused decision or retraction: under the reason field, or one toast —
 * the requests are read again either way (`useDecideReleaseSettingChange`).
 */
export function releaseSettingRequestFailure(
  error: unknown,
): { field: 'reason'; message: string } | { message: string } {
  if (isApiError(error, 'VALIDATION_ERROR')) {
    return validationField(error) === 'reason'
      ? { field: 'reason', message: copy.errReleaseSettingDecisionReason }
      : { message: copy.errUnknown };
  }
  if (isApiError(error, 'RELEASE_SETTING_NOT_ALLOWED')) {
    const details = releaseSettingNotAllowedDetailsSchema.safeParse(error.details);
    return { message: details.success ? REFUSAL_MESSAGE[details.data.reason] : copy.errUnknown };
  }
  if (isApiError(error, 'APPROVAL_NOT_ALLOWED')) {
    const reason = validationMessage(error);
    return {
      message:
        reason !== undefined && Object.hasOwn(APPROVAL_MESSAGE, reason)
          ? APPROVAL_MESSAGE[reason]!
          : copy.errUnknown,
    };
  }
  if (isApiError(error, 'NOT_FOUND')) return { message: copy.errReleaseSettingRequestNotFound };
  if (isApiError(error, 'UNAUTHENTICATED')) return { message: copy.errUnauthenticated };
  if (isForAnotherAccount(error)) return { message: copy.sessionChanged };
  if (isApiError(error, 'FORBIDDEN')) return { message: copy.adminOnly };
  return { message: copy.errUnknown };
}

/**
 * What the admin on screen may do with a request: its requester retracts it while it waits and
 * decides nothing of it; any other admin approves (not while it is `stale`) or rejects it. Nothing
 * once it is decided or retracted, or while the admin on screen is unknown (`GET /me`).
 */
export function changeRequestActions(
  request: Pick<ReleaseSettingChangeRequest, 'requestedBy' | 'status' | 'stale'>,
  operatorId: string | undefined,
): { own: boolean; canApprove: boolean; canReject: boolean; canRetract: boolean } {
  const own = operatorId !== undefined && request.requestedBy.id === operatorId;
  const open = operatorId !== undefined && request.status === 'pending';
  return {
    own,
    canApprove: open && !own && !request.stale,
    canReject: open && !own,
    canRetract: open && own,
  };
}
