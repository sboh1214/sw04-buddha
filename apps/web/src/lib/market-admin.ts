import {
  AUDIT_FAILURE_KINDS,
  type AuditFailureKind,
  type MarketEventType,
  type MarketStatus,
  formatP,
  pAmountSchema,
  parsePAmount,
  uuidParamSchema,
} from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import { type ApiError, isApiError, validationField } from './api';
import { formatKst } from './datetime';

/**
 * Pure helpers behind the admin market screens (PLAN 12): status and event labels, the two
 * list badges, and the number formats. No domain maths lives here — probabilities and P come
 * from the API and @buddha/shared (PLAN 11.5).
 */

export const MARKET_STATUS_LABEL: Record<MarketStatus, string> = {
  draft: copy.marketStatusDraft,
  open: copy.marketStatusOpen,
  closed: copy.marketStatusClosed,
  resolving: copy.marketStatusResolving,
  settled: copy.marketStatusSettled,
  voided: copy.marketStatusVoided,
};

/** Chakra colorPalette per status: brand while live, gray when it is over, `no` for voided. */
export const MARKET_STATUS_PALETTE: Record<MarketStatus, 'brand' | 'gray' | 'orange' | 'no'> = {
  draft: 'gray',
  open: 'brand',
  closed: 'orange',
  resolving: 'orange',
  settled: 'gray',
  voided: 'no',
};

export const MARKET_EVENT_LABEL: Record<MarketEventType, string> = {
  created: copy.eventCreated,
  opened: copy.eventOpened,
  closed: copy.eventClosed,
  resolve_proposed: copy.eventResolveProposed,
  result_changed: copy.eventResultChanged,
  finalized: copy.eventFinalized,
  voided: copy.eventVoided,
  rules_edited: copy.eventRulesEdited,
};

export const PAYMENT_STATUS_LABEL: Record<'pending' | 'succeeded' | 'failed', string> = {
  pending: copy.paymentStatusPending,
  succeeded: copy.paymentStatusSucceeded,
  failed: copy.paymentStatusFailed,
};

export const PAYMENT_STATUS_PALETTE: Record<'pending' | 'succeeded' | 'failed', string> = {
  pending: 'orange',
  succeeded: 'brand',
  failed: 'no',
};

export const AUDIT_FAILURE_KIND_LABEL: Record<AuditFailureKind, string> = {
  ledger_balance_mismatch: copy.auditKindLedgerMismatch,
};

/**
 * The audit failure's `kind` in Korean. The API types it as a plain string (the worker may
 * learn new kinds before the web does), so anything outside the shared enum shows verbatim
 * rather than as a blank.
 */
export function auditFailureKindLabel(kind: string): string {
  return (AUDIT_FAILURE_KINDS as readonly string[]).includes(kind)
    ? AUDIT_FAILURE_KIND_LABEL[kind as AuditFailureKind]
    : kind;
}

export const CLOSING_SOON_MS = 24 * 60 * 60 * 1000;

/**
 * 마감 임박 (PLAN 12): an open market whose close time is within the next 24 hours. A close
 * time already in the past is not "soon" — the market is waiting for the close job, and the
 * 정산 대기 badge takes over once it is closed.
 */
export function isClosingSoon(
  market: { status: MarketStatus; closeAt: string },
  now: number = Date.now(),
): boolean {
  if (market.status !== 'open') return false;
  const closeAt = new Date(market.closeAt).getTime();
  if (Number.isNaN(closeAt)) return false;
  return closeAt > now && closeAt - now <= CLOSING_SOON_MS;
}

/** 정산 대기 (PLAN 12): closed and waiting for a result, or resolving with one proposed. */
export function isAwaitingSettlement(status: MarketStatus): boolean {
  return status === 'closed' || status === 'resolving';
}

/** Which form fields a status admits (design 3.4): draft everything, open the text fields. */
export function isEditable(status: MarketStatus): boolean {
  return status === 'draft' || status === 'open';
}

export function canEditLiquidity(status: MarketStatus): boolean {
  return status === 'draft';
}

export function canVoid(status: MarketStatus): boolean {
  return status === 'open' || status === 'closed' || status === 'resolving';
}

/** PLAN 11.2: never colour alone — "예 63%". */
export function formatYesPrice(lastPrice: number): string {
  return `${copy.yes} ${String(lastPrice)}%`;
}

/** Basis points (0..10000) as a percentage with two decimals: 6300 → "63.00%". */
export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

/** A `numeric(24,10)` quantity string from the API, trimmed to four decimals for reading. */
export function formatQuantity(q: string): string {
  const n = Number(q);
  return Number.isFinite(n)
    ? n.toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
    : q;
}

/**
 * Whether a route's `[id]` can name a market at all. The API validates the path param with
 * the same `uuidParamSchema` and answers 400 for anything else (a truncated paste, `/abc`),
 * which is not a "try again" situation: the detail screen shows 찾을 수 없습니다 without a
 * request. The refusal's issue path is `[]` (a scalar schema), so it cannot be told apart
 * from any other 400 after the fact — hence the check up front.
 */
export function isMarketId(id: string): boolean {
  return uuidParamSchema.safeParse(id).success;
}

/** An event/audit payload as one compact line; `null` and `undefined` render as nothing. */
export function compactJson(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  try {
    return JSON.stringify(payload);
  } catch {
    return copy.payloadUnreadable;
  }
}

export interface EventRow {
  label: string;
  value: string;
}

/** An instant `formatKst` can render; the row would otherwise be a blank. */
const kstInstant = z.string().refine((iso) => formatKst(iso) !== '');

/** The payloads `market-admin.service` writes for each event, as the web reads them. */
const VOIDED_PAYLOAD = z.object({
  reason: z.string(),
  refundedAccounts: z.number().int().nonnegative(),
  refundedP: pAmountSchema,
});
const RULES_EDITED_PAYLOAD = z.object({ before: z.string(), after: z.string() });
const OPENED_PAYLOAD = z.object({ openAt: kstInstant, closeAt: kstInstant });
const CLOSED_PAYLOAD = z.object({ closedAt: kstInstant });

/**
 * An event's payload as label/value rows in Korean, for the shapes the API writes (design
 * 3.4's 이벤트 로그): the void summary, the rules diff, the open and close instants. The
 * payload is `unknown` on the wire (jsonb), so each shape is checked before it is read;
 * `created` (the whole create body) and anything that does not match are `undefined`, and
 * the screen shows those as `compactJson` instead of a half-read row.
 */
export function marketEventRows(type: MarketEventType, payload: unknown): EventRow[] | undefined {
  switch (type) {
    case 'voided': {
      const parsed = VOIDED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      return [
        { label: copy.eventVoidReason, value: parsed.data.reason },
        { label: copy.eventRefundedAccounts, value: String(parsed.data.refundedAccounts) },
        { label: copy.eventRefundedTotal, value: formatP(parsePAmount(parsed.data.refundedP)) },
      ];
    }
    case 'rules_edited': {
      const parsed = RULES_EDITED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      return [
        { label: copy.eventRulesBefore, value: parsed.data.before || '—' },
        { label: copy.eventRulesAfter, value: parsed.data.after || '—' },
      ];
    }
    case 'opened': {
      const parsed = OPENED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      return [
        { label: copy.marketOpenAt, value: formatKst(parsed.data.openAt) },
        { label: copy.adminMarketCloseAtShort, value: formatKst(parsed.data.closeAt) },
      ];
    }
    case 'closed': {
      const parsed = CLOSED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      return [{ label: copy.adminMarketCloseAtShort, value: formatKst(parsed.data.closedAt) }];
    }
    default:
      return undefined;
  }
}

/**
 * The toast for a refused transition (design 3.4/3.6): RULES_REQUIRED on open, MARKET_NOT_OPEN
 * on close, VALIDATION_ERROR naming `status` for any other state-machine violation — the two
 * "refresh the screen" messages, since the state on screen is what is stale. NOT_FOUND is the
 * market itself (every admin write answers 404 for an unknown id): not a "try again". A
 * NOT_FOUND naming `categoryId` never reaches here — the form callers hand it to
 * `marketFormError` first.
 */
export function transitionErrorMessage(error: unknown): string {
  if (isApiError(error, 'RULES_REQUIRED')) return copy.errMarketRulesRequired;
  if (isApiError(error, 'MARKET_NOT_OPEN')) return copy.errMarketNotOpen;
  if (isApiError(error, 'NOT_FOUND')) return copy.adminMarketNotFound;
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'status') return copy.errMarketStatus;
    if (field === 'closeAt') return copy.errMarketCloseAt;
    if (field === 'reason') return copy.errMarketVoidReason;
    return copy.errMarketInvalid;
  }
  return copy.errUnknown;
}

export type MarketFormField =
  | 'title'
  | 'description'
  | 'rules'
  | 'resolutionSource'
  | 'categoryId'
  | 'imageUrl'
  | 'closeAt'
  | 'probabilityPct'
  | 'liquidityB'
  | 'slug';

const API_FIELD_TO_FORM: Record<string, MarketFormField> = {
  title: 'title',
  description: 'description',
  rules: 'rules',
  resolutionSource: 'resolutionSource',
  categoryId: 'categoryId',
  imageUrl: 'imageUrl',
  closeAt: 'closeAt',
  initialProbBp: 'probabilityPct',
  liquidityB: 'liquidityB',
  slug: 'slug',
};

/**
 * Where a refused create/update lands on the form: the field the API named, with the message
 * the admin can act on. `slug` is the UNIQUE collision (design 3.4), `categoryId` an unknown
 * (404) or retired category. Anything else — including a VALIDATION_ERROR naming `status`,
 * which is not a field the form has — is `undefined` and goes to the generic toast.
 */
export function marketFormError(
  error: unknown,
): { field: MarketFormField; message: string } | undefined {
  if (!isApiError(error)) return undefined;
  if (!isApiError(error, 'VALIDATION_ERROR') && !isApiError(error, 'NOT_FOUND')) return undefined;
  const named = validationField(error);
  if (named === undefined) return undefined;
  const field = API_FIELD_TO_FORM[named];
  if (field === undefined) return undefined;
  return { field, message: fieldMessage(field, error) };
}

function fieldMessage(field: MarketFormField, error: ApiError): string {
  switch (field) {
    case 'slug':
      // The unique-index refusal (design 3.4) says "already exists" in its issue; the shared
      // zod rule's refusal (pattern / uuid-shaped) says how the slug is malformed.
      return isSlugTaken(error) ? copy.errMarketSlugTaken : copy.errMarketSlug;
    case 'categoryId':
      return copy.errMarketCategoryUnavailable;
    case 'closeAt':
      return copy.errMarketCloseAt;
    case 'title':
      return copy.errMarketTitle;
    case 'description':
    case 'rules':
      return copy.errMarketText;
    case 'resolutionSource':
      return copy.errMarketSource;
    case 'imageUrl':
      return copy.errMarketImageUrl;
    case 'liquidityB':
      return copy.errMarketLiquidity;
    case 'probabilityPct':
      return copy.errMarketInvalid;
  }
}

function isSlugTaken(error: ApiError): boolean {
  if (/already taken/i.test(error.message)) return true;
  if (!Array.isArray(error.details)) return false;
  const first: unknown = error.details[0];
  return (
    typeof first === 'object' &&
    first !== null &&
    'message' in first &&
    (first as { message?: unknown }).message === 'already exists'
  );
}
