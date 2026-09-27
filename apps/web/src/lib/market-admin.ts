import {
  AUDIT_FAILURE_KINDS,
  type AuditFailureKind,
  type DisputeStatus,
  MINUS_SIGN,
  type MarketEventType,
  type MarketStatus,
  type PaymentStatus,
  formatP,
  outcomeSchema,
  pAmountSchema,
  parsePAmount,
  uuidParamSchema,
} from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import { type ApiError, isApiError, validationField } from './api';
import { formatKst } from './datetime';

/**
 * Pure helpers behind the market screens: status and event labels, the two list badges (PLAN
 * 12), and the number formats the public cards, the detail header and the trade panel share
 * with the admin screens. No domain maths lives here — probabilities and P come from the API
 * and @buddha/shared (PLAN 11.5).
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

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: copy.paymentStatusPending,
  succeeded: copy.paymentStatusSucceeded,
  failed: copy.paymentStatusFailed,
  cancelled: copy.paymentStatusCancelled,
  refunding: copy.paymentStatusRefunding,
  refunded: copy.paymentStatusRefunded,
};

/** In flight is orange, credited is brand, refused is `no`, money given back is gray. */
export const PAYMENT_STATUS_PALETTE: Record<PaymentStatus, string> = {
  pending: 'orange',
  succeeded: 'brand',
  failed: 'no',
  cancelled: 'gray',
  refunding: 'orange',
  refunded: 'gray',
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

/** 정산 (PLAN 12, design 5.5): a result is proposed on a closed market only. */
export function canResolve(status: MarketStatus): boolean {
  return status === 'closed';
}

/**
 * 결과 변경 (design 5.5): only while resolving AND the dispute window is still open. Once
 * `disputeUntil` has passed the worker's finalize is due or running and the API refuses the
 * change naming `status` (`errMarketDisputeWindowOver`) — an admin who still wants another
 * outcome must void — so the button goes away rather than offering a refusal. `now` is
 * injected like `isClosingSoon`'s: the screen anchors it, a test pins it. A `resolving` row
 * with no window (a factory row) offers nothing: there is no instant to compare against.
 */
export function canChangeResult(
  market: { status: MarketStatus; disputeUntil: string | null },
  now: number = Date.now(),
): boolean {
  if (market.status !== 'resolving' || market.disputeUntil === null) return false;
  const until = new Date(market.disputeUntil).getTime();
  return !Number.isNaN(until) && until > now;
}

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, string> = {
  open: copy.disputeStatusOpen,
  accepted: copy.disputeStatusAccepted,
  rejected: copy.disputeStatusRejected,
};

/**
 * Orange while it waits for the admin (the same "needs attention" the awaiting-settlement
 * markets carry), brand once accepted, gray once rejected. Never colour alone: every badge
 * shows `DISPUTE_STATUS_LABEL` beside it (PLAN 11.2).
 */
export const DISPUTE_STATUS_PALETTE: Record<DisputeStatus, 'brand' | 'gray' | 'orange'> = {
  open: 'orange',
  accepted: 'brand',
  rejected: 'gray',
};

/** PLAN 11.2: never colour alone — "예 63%". */
export function formatYesPrice(lastPrice: number): string {
  return `${copy.yes} ${String(lastPrice)}%`;
}

/**
 * The other side of the same reading — "아니오 37%" for a 63% market. The complement is taken
 * from `lastPrice` (the whole percent the API rounds), not from `pYesBp`, so 예 and 아니오 on
 * the same card always add up to 100.
 */
export function formatNoPrice(lastPrice: number): string {
  return `${copy.no} ${String(100 - lastPrice)}%`;
}

/** Basis points (0..10000) as a percentage with two decimals: 6300 → "63.00%". */
export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

/** The same basis points as what one contract costs: 6300 → "63.00P" (a winner pays 100P). */
export function formatPricePerContract(bp: number): string {
  return `${(bp / 100).toFixed(2)}P`;
}

/**
 * The probability move for the delta badge (PLAN 11.4), in percentage points: "+2%p" or
 * "−2%p" with U+2212, never an ASCII hyphen — the minus then has the same width as the plus
 * and does not read as a stray dash beside the number.
 *
 * An empty string hides the badge: there is no move to report (`null`), or the move is smaller
 * than the tenth of a point shown, and 실시간은 조용하게 (PLAN 11.1-5) means a wiggle gets no
 * badge at all rather than a "+0%p" one.
 */
export function deltaLabel(deltaPoints: number | null): string {
  if (deltaPoints === null || !Number.isFinite(deltaPoints)) return '';
  const rounded = Math.round(deltaPoints * 10) / 10;
  if (rounded === 0) return '';
  return `${rounded > 0 ? '+' : MINUS_SIGN}${String(Math.abs(rounded))}%p`;
}

/**
 * The identity of ONE probability move, which is what `ProbabilityDisplay` remembers a dismissal
 * against so the NEXT move revives its five-second badge (PLAN 11.4).
 *
 * THE HAZARD it closes: the identity used to be `lastPrice:label`, and `lastPrice` is the WHOLE
 * percent. A move too small to change it — 5 to 49 basis points, which `deltaLabel` still shows
 * as +0.1%p and up — therefore produced the same string as the move before it, the effect never
 * restarted, and a badge already dismissed never came back. Measured: three consecutive +0.1%p
 * trades inside one percent lit it once and stayed dark for the other two, on the screen PLAN
 * 11.4 asks to announce every move.
 *
 * Basis points cannot collide the same way. Two CONSECUTIVE moves share an identity only by
 * ending on the same probability, and a move that ends where it began has a zero delta, which
 * `deltaLabel` already hides. (Non-consecutive repeats are harmless: only the last dismissal is
 * remembered.)
 *
 * `lastPrice` stays the fallback for a caller with no `pYesBp` — a card omits it (PLAN 11.1-1),
 * and today the badge has a single call site that passes both, so the fallback is a contract
 * rather than a live path. Derived from values alone, so a server render and the first client
 * render produce the same string.
 */
export function deltaMoveKey(pYesBp: number | undefined, lastPrice: number, label: string): string {
  return `${String(pYesBp ?? lastPrice)}:${label}`;
}

/** A `numeric(24,10)` quantity string from the API, trimmed to four decimals for reading. */
export function formatQuantity(q: string): string {
  const n = Number(q);
  return Number.isFinite(n)
    ? n.toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
    : q;
}

/**
 * A contract count as the quote summary and the position rows read it: "1,234계약". The number
 * goes through `formatQuantity` so a fractional quote (the quote returns shares, not an
 * integer) groups and truncates exactly like the quantities the API sends as strings.
 */
export function formatContracts(n: number): string {
  return `${formatQuantity(String(n))}${copy.tradeUnitContracts}`;
}

/**
 * Whether a route's `[id]` can name a market at all. The API validates the path param with
 * the same `uuidParamSchema` and answers 400 for anything else (a truncated paste, `/abc`),
 * which is not a "try again" situation: the detail screen shows 찾을 수 없습니다 without a
 * request. The refusal's issue path is `[]` (a scalar schema), so it cannot be told apart
 * from any other 400 after the fact — hence the check up front.
 *
 * The parsed value, not a boolean, and that is the point: a uuid is accepted in either case
 * and `uuidParamSchema` lower-cases it (A-M3-17), which is also the case every row the API
 * answers with carries. A screen that keys its cache on this value keys it on the same
 * string its children read back as `market.id`; one that keeps the segment as typed holds
 * two strings for one market (A-M3-29).
 */
export function marketIdParam(id: string): string | undefined {
  return uuidParamSchema.safeParse(id).data;
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

/**
 * The payloads `market-admin.service` (and the worker's `market-finalize`) write for each
 * event, as the web reads them. `.nullish()` where the writer may omit or null a field: the
 * resolve detail nulls a blank note, and a void of a `closed` market — never proposed —
 * carries no discarded proposal at all.
 */
const VOIDED_PAYLOAD = z.object({
  reason: z.string(),
  refundedAccounts: z.number().int().nonnegative(),
  refundedP: pAmountSchema,
  discardedResult: outcomeSchema.nullish(),
});
const RULES_EDITED_PAYLOAD = z.object({ before: z.string(), after: z.string() });
const OPENED_PAYLOAD = z.object({ openAt: kstInstant, closeAt: kstInstant });
const CLOSED_PAYLOAD = z.object({ closedAt: kstInstant });
const RESOLVE_DETAIL = {
  note: z.string().nullish(),
  evidenceUrl: z.string().nullish(),
  disputeUntil: kstInstant,
};
const RESOLVE_PROPOSED_PAYLOAD = z.object({ result: outcomeSchema, ...RESOLVE_DETAIL });
const RESULT_CHANGED_PAYLOAD = z.object({
  before: outcomeSchema,
  after: outcomeSchema,
  ...RESOLVE_DETAIL,
});
// The counts and the total are what the worker writes today; optional so an older row (or a
// leaner writer) still reads as "확정 · 결과 예" rather than falling back to JSON.
const FINALIZED_PAYLOAD = z.object({
  result: outcomeSchema,
  settledAccounts: z.number().int().nonnegative().optional(),
  paidAccounts: z.number().int().nonnegative().optional(),
  paidP: pAmountSchema.optional(),
});

/** "예" / "아니오" for a result row: never the wire's YES/NO on an admin screen. */
function outcomeLabel(outcome: 'YES' | 'NO'): string {
  return outcome === 'YES' ? copy.yes : copy.no;
}

/** The note / evidence / window rows the two resolve events share; blanks are left out. */
function resolveDetailRows(detail: {
  note?: string | null;
  evidenceUrl?: string | null;
  disputeUntil: string;
}): EventRow[] {
  return [
    ...(detail.note ? [{ label: copy.adminMarketResolveNote, value: detail.note }] : []),
    ...(detail.evidenceUrl
      ? [{ label: copy.adminMarketResolveEvidence, value: detail.evidenceUrl }]
      : []),
    { label: copy.marketDisputeUntil, value: formatKst(detail.disputeUntil) },
  ];
}

/**
 * An event's payload as label/value rows in Korean, for the shapes the API and the worker
 * write (design 3.4's 이벤트 로그, 5.5): the void summary, the rules diff, the open and close
 * instants, the proposed / changed result with its window, the finalize summary. The payload
 * is `unknown` on the wire (jsonb), so each shape is checked before it is read; `created`
 * (the whole create body) and anything that does not match are `undefined`, and the screen
 * shows those as `compactJson` instead of a half-read row.
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
        // A void from `resolving` discards the proposal (A-M3-23); the row says which one.
        ...(parsed.data.discardedResult
          ? [{ label: copy.eventDiscardedResult, value: outcomeLabel(parsed.data.discardedResult) }]
          : []),
      ];
    }
    case 'resolve_proposed': {
      const parsed = RESOLVE_PROPOSED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      return [
        { label: copy.marketResolvedResult, value: outcomeLabel(parsed.data.result) },
        ...resolveDetailRows(parsed.data),
      ];
    }
    case 'result_changed': {
      const parsed = RESULT_CHANGED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      return [
        { label: copy.eventRulesBefore, value: outcomeLabel(parsed.data.before) },
        { label: copy.eventRulesAfter, value: outcomeLabel(parsed.data.after) },
        ...resolveDetailRows(parsed.data),
      ];
    }
    case 'finalized': {
      const parsed = FINALIZED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      const { result, settledAccounts, paidAccounts, paidP } = parsed.data;
      return [
        { label: copy.marketResolvedResult, value: outcomeLabel(result) },
        ...(settledAccounts === undefined
          ? []
          : [{ label: copy.eventSettledAccounts, value: String(settledAccounts) }]),
        ...(paidAccounts === undefined
          ? []
          : [{ label: copy.eventPaidAccounts, value: String(paidAccounts) }]),
        ...(paidP === undefined
          ? []
          : [{ label: copy.eventPaidTotal, value: formatP(parsePAmount(paidP)) }]),
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
 * The toast for a refused transition (design 3.4/3.6, 5.5): RULES_REQUIRED on open,
 * MARKET_NOT_OPEN on close, VALIDATION_ERROR naming `status` for any other state-machine
 * violation — the two "refresh the screen" messages, since the state on screen is what is
 * stale. NOT_FOUND is the market itself (every admin write answers 404 for an unknown id):
 * not a "try again". A NOT_FOUND naming `categoryId` never reaches here — the form callers
 * hand it to `marketFormError` first.
 *
 * Two refusals of the resolve route are named apart from the rest. `result` is the change
 * that changes nothing (the dialog disables the button for the result on screen, so this is
 * the stale case: another admin changed it first). `status` with the dispute-window issue is
 * not a stale screen at all — the market IS resolving, and its window has passed, so the
 * worker's finalize is due and only a void remains; told by the issue text (as `isSlugTaken`
 * reads the slug refusal) rather than by the status on screen, because a screen showing
 * `resolving` for a market the worker has since settled gets `market is settled` from the
 * same route, and that one is the ordinary "refresh" case.
 */
export function transitionErrorMessage(error: unknown): string {
  if (isApiError(error, 'RULES_REQUIRED')) return copy.errMarketRulesRequired;
  if (isApiError(error, 'MARKET_NOT_OPEN')) return copy.errMarketNotOpen;
  if (isApiError(error, 'NOT_FOUND')) return copy.adminMarketNotFound;
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'status') {
      return isDisputeWindowOver(error) ? copy.errMarketDisputeWindowOver : copy.errMarketStatus;
    }
    if (field === 'result') return copy.errMarketResultUnchanged;
    if (field === 'closeAt') return copy.errMarketCloseAt;
    if (field === 'reason') return copy.errMarketVoidReason;
    if (field === 'note') return copy.errMarketResolveNote;
    if (field === 'evidenceUrl') return copy.errMarketResolveEvidence;
    return copy.errMarketInvalid;
  }
  return copy.errUnknown;
}

/** The resolve route's `status` refusal for a window that has passed (market-admin.service.ts). */
function isDisputeWindowOver(error: ApiError): boolean {
  if (/dispute window/i.test(error.message)) return true;
  return /dispute window/i.test(firstIssueMessage(error) ?? '');
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
  // A PATCH that would blank the rules of an open market: the API's RULES_REQUIRED names
  // `rules`, and the field is where the admin can fix it.
  if (isApiError(error, 'RULES_REQUIRED'))
    return { field: 'rules', message: copy.errMarketRulesOpen };
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
  return firstIssueMessage(error) === 'already exists';
}

/** The first issue's `message` when `details` is a `ValidationIssue[]` (PLAN 7); else undefined. */
function firstIssueMessage(error: ApiError): string | undefined {
  if (!Array.isArray(error.details)) return undefined;
  const first: unknown = error.details[0];
  if (typeof first !== 'object' || first === null || !('message' in first)) return undefined;
  const message: unknown = (first as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}
