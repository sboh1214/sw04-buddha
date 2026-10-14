import {
  AUDIT_FAILURE_KINDS,
  type AdminSettlementStep,
  type AuditFailureKind,
  COIN_UNIT,
  MINUS_SIGN,
  type MarketEventType,
  type MarketStatus,
  type PaymentStatus,
  type SettlementStep,
  type SettlementStepStatus,
  formatCoin,
  outcomeSchema,
  coinAmountSchema,
  parseCoinAmount,
  uuidParamSchema,
} from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import { type ApiError, isApiError, validationField, validationMessage } from './api';
import { formatKst } from './datetime';

/**
 * Pure helpers behind the market screens: status and event labels, the list badges (PLAN 12),
 * the admin's settlement-step rows (ADR-0046), and the number formats the public cards and the
 * detail header share with the admin screens. No domain maths lives here — prices and Coin come
 * from the API and @buddha/shared (PLAN 11.5).
 */

export const MARKET_STATUS_LABEL: Record<MarketStatus, string> = {
  draft: copy.marketStatusDraft,
  open: copy.marketStatusOpen,
  closed: copy.marketStatusClosed,
  resolved: copy.marketStatusResolved,
  settled: copy.marketStatusSettled,
  voided: copy.marketStatusVoided,
};

/**
 * Chakra colorPalette per status: brand while live, orange while it waits on the admin (판정) or
 * the worker (정산), gray when it is over, `no` for voided.
 */
export const MARKET_STATUS_PALETTE: Record<MarketStatus, 'brand' | 'gray' | 'orange' | 'no'> = {
  draft: 'gray',
  open: 'brand',
  closed: 'orange',
  resolved: 'orange',
  settled: 'gray',
  voided: 'no',
};

export const MARKET_EVENT_LABEL: Record<MarketEventType, string> = {
  created: copy.eventCreated,
  opened: copy.eventOpened,
  closed: copy.eventClosed,
  // The M5 dispute flow's two events (legacy, ADR-0046): no longer written, but market_events is
  // append-only and a market judged before the change still shows them in its log.
  resolve_proposed: copy.eventResolveProposed,
  result_changed: copy.eventResultChanged,
  finalized: copy.eventFinalized,
  voided: copy.eventVoided,
  rules_edited: copy.eventRulesEdited,
  resolved: copy.eventResolved,
};

export const SETTLEMENT_STEP_LABEL: Record<SettlementStep, string> = {
  coin: copy.settlementStepCoin,
};

export const SETTLEMENT_STEP_STATUS_LABEL: Record<SettlementStepStatus, string> = {
  pending: copy.settlementStepStatusPending,
  done: copy.settlementStepStatusDone,
  failed: copy.settlementStepStatusFailed,
};

/**
 * Orange while the step waits for the worker (the same "needs attention" the 정산 대기 badge
 * carries), gray once done, `no` once its last attempt rolled back. Never colour alone: every
 * badge shows `SETTLEMENT_STEP_STATUS_LABEL` beside it (PLAN 11.2).
 */
export const SETTLEMENT_STEP_STATUS_PALETTE: Record<
  SettlementStepStatus,
  'gray' | 'orange' | 'no'
> = {
  pending: 'orange',
  done: 'gray',
  failed: 'no',
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
 * 판정 대기 badge takes over once it is closed.
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

/** 판정 대기 (ADR-0046): trading has stopped and the market waits for the admin's 판정. */
export function isAwaitingResolution(status: MarketStatus): boolean {
  return status === 'closed';
}

/**
 * 정산 대기 (ADR-0046): judged, and the worker's settlement steps have not all finished. The
 * worker runs them right after the 판정, so this lasts seconds; a market that keeps the badge is
 * the operational signal that a step is failing (the detail's 정산 단계 panel says which).
 */
export function isAwaitingSettlement(status: MarketStatus): boolean {
  return status === 'resolved';
}

/** How often the admin detail re-reads a judged market until it is settled (ADR-0046). */
export const SETTLEMENT_POLL_INTERVAL_MS = 5_000;

/**
 * `refetchInterval` of the admin detail: every 5 s while the market is `resolved`. Nothing else
 * tells this screen that the worker finished or failed a step — the admin query joins no
 * realtime room, and a failed attempt publishes nothing at all — so without it the 정산 단계
 * panel keeps the `pending` row the 판정 answered with until a reload. Not budgeted like the
 * 결제 내역 poll (payments.ts): a failing step is retried by the worker's per-minute scan,
 * and this panel is where an operator watches those attempts. query-core pauses the interval
 * while the tab is hidden, and it stops by itself at `settled`.
 */
export function settlementPollInterval(
  market: { status: MarketStatus } | undefined,
): number | false {
  return market !== undefined && isAwaitingSettlement(market.status)
    ? SETTLEMENT_POLL_INTERVAL_MS
    : false;
}

/** Which form fields a status admits (design 3.4): draft everything, open the text fields. */
export function isEditable(status: MarketStatus): boolean {
  return status === 'draft' || status === 'open';
}

/**
 * 판정 (PLAN 12, ADR-0046): a closed market only, once. The result is final at once; there is no
 * way to change it afterwards (#26 decides re-judgement).
 */
export function canResolve(status: MarketStatus): boolean {
  return status === 'closed';
}

/** One row of the admin's 정산 단계 panel, every cell already in words. */
export interface SettlementStepView {
  step: SettlementStep;
  label: string;
  statusLabel: string;
  palette: (typeof SETTLEMENT_STEP_STATUS_PALETTE)[SettlementStepStatus];
  /** The one state that needs the admin: drawn as a solid badge, not a subtle one. */
  failed: boolean;
  attempts: string;
  /** KST, or '—' while the step has not finished. */
  completedAt: string;
  /** The last failed attempt's message (kept after a later success), or '—'. */
  lastError: string;
}

/**
 * `AdminMarket.settlementSteps` (ADR-0046) as the 정산 단계 panel reads it. The API already
 * answers in SETTLEMENT_STEPS order — the order the worker runs them in — so the rows keep it.
 * `lastError` stays on a step that later succeeded: it is the record of why the earlier attempt
 * failed, and the 완료 badge beside it says that the failure is over.
 */
export function settlementStepViews(
  steps: readonly Pick<
    AdminSettlementStep,
    'step' | 'status' | 'attempts' | 'completedAt' | 'lastError'
  >[],
): SettlementStepView[] {
  return steps.map((row) => ({
    step: row.step,
    label: SETTLEMENT_STEP_LABEL[row.step],
    statusLabel: SETTLEMENT_STEP_STATUS_LABEL[row.status],
    palette: SETTLEMENT_STEP_STATUS_PALETTE[row.status],
    failed: row.status === 'failed',
    attempts: String(row.attempts),
    // `formatKst` answers '' for an instant it cannot read; a blank cell would say less than '—'.
    completedAt: (row.completedAt === null ? '' : formatKst(row.completedAt)) || '—',
    lastError: row.lastError || '—',
  }));
}

/**
 * PLAN 11.2: never colour alone — "YES 63%". `null` is a market with no fill yet, which reads
 * 체결 없음 rather than any number (N02 §5): no initial setting is shown as a price.
 */
export function formatYesPrice(lastPrice: number | null): string {
  return lastPrice === null ? copy.noFills : `${copy.yes} ${String(lastPrice)}%`;
}

/**
 * The other side of the same reading — "NO 37%" for a 63% market. The complement is taken
 * from the same `lastPrice` (the whole percent the API sends), so YES and NO on the same card
 * always add up to 100.
 */
export function formatNoPrice(lastPrice: number): string {
  return `${copy.no} ${String(100 - lastPrice)}%`;
}

/** Basis points (0..10000) as a percentage with two decimals: 6300 → "63.00%". */
export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

/**
 * The same basis points as what one contract costs: 6300 → "63.00 Coin" (a winner pays 100 Coin).
 * Two decimals, which `formatCoin` (integers only) cannot write, so the unit is spelled here the
 * way it spells it: one ordinary space, then `COIN_UNIT`.
 */
export function formatPricePerContract(bp: number): string {
  return `${(bp / 100).toFixed(2)} ${COIN_UNIT}`;
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
 * The value-based identity of ONE price move — what `ProbabilityDisplay` remembers a dismissal
 * against when its caller passes no `moveId`, so the NEXT move revives the five-second badge
 * (PLAN 11.4).
 *
 * Only a fallback, and a weak one: `lastPrice` is the WHOLE percent, so a move too small to
 * change it — which `deltaLabel` still shows as +0.1%p and up — produces the same string as the
 * move before it and a badge already dismissed never comes back. The one call site passes the
 * monotone `moveId` (`recentMove`, lib/ticks.ts) for exactly that reason. Derived from values
 * alone, so a server render and the first client render produce the same string.
 */
export function deltaMoveKey(lastPrice: number | null, label: string): string {
  return `${lastPrice === null ? '' : String(lastPrice)}:${label}`;
}

/** A quantity, possibly a decimal string, trimmed to four decimals and grouped for reading. */
export function formatQuantity(q: string): string {
  const n = Number(q);
  return Number.isFinite(n)
    ? n.toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
    : q;
}

/** A contract count as the position, order and fill rows read it: "1,234계약". */
export function formatContracts(n: number): string {
  return `${formatQuantity(String(n))}${copy.unitContracts}`;
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
 * 판정 detail nulls a blank note.
 */
const RULES_EDITED_PAYLOAD = z.object({ before: z.string(), after: z.string() });
const OPENED_PAYLOAD = z.object({ openAt: kstInstant, closeAt: kstInstant });
const CLOSED_PAYLOAD = z.object({ closedAt: kstInstant });
const RESOLVE_DETAIL = {
  note: z.string().nullish(),
  evidenceUrl: z.string().nullish(),
};
/** The 판정 (ADR-0046): `{result, note, evidenceUrl}`. */
const RESOLVED_PAYLOAD = z.object({ result: outcomeSchema, ...RESOLVE_DETAIL });
/**
 * M5's two legacy events (no longer written, still in old logs). Both carried the dispute
 * window's end; it is optional here and never shown — the window no longer means anything, and
 * a row reading 이의 마감 would describe a stage the product does not have.
 */
const LEGACY_RESOLVE_DETAIL = { ...RESOLVE_DETAIL, disputeUntil: kstInstant.optional() };
const RESOLVE_PROPOSED_PAYLOAD = z.object({ result: outcomeSchema, ...LEGACY_RESOLVE_DETAIL });
const RESULT_CHANGED_PAYLOAD = z.object({
  before: outcomeSchema,
  after: outcomeSchema,
  ...LEGACY_RESOLVE_DETAIL,
});
// The counts and the total are what the worker writes today; optional so an older row (or a
// leaner writer) still reads as "정산 완료 · 결과 YES" rather than falling back to JSON.
const FINALIZED_PAYLOAD = z.object({
  result: outcomeSchema,
  settledAccounts: z.number().int().nonnegative().optional(),
  paidAccounts: z.number().int().nonnegative().optional(),
  paidCoin: coinAmountSchema.optional(),
});

/** `copy.yes` / `copy.no` for a result row: the screen's label, never the raw wire value. */
function outcomeLabel(outcome: 'YES' | 'NO'): string {
  return outcome === 'YES' ? copy.yes : copy.no;
}

/** The note / evidence rows the resolve events share; blanks are left out. */
function resolveDetailRows(detail: {
  note?: string | null;
  evidenceUrl?: string | null;
}): EventRow[] {
  return [
    ...(detail.note ? [{ label: copy.adminMarketResolveNote, value: detail.note }] : []),
    ...(detail.evidenceUrl
      ? [{ label: copy.adminMarketResolveEvidence, value: detail.evidenceUrl }]
      : []),
  ];
}

/**
 * An event's payload as label/value rows in Korean, for the shapes the API and the worker
 * write (design 3.4's 이벤트 로그, 5.5): the rules diff, the open and close instants, the 판정
 * with its note and evidence (and M5's legacy proposed / changed result), the finalize summary.
 * The payload is `unknown` on the wire (jsonb), so each shape is checked before it is read;
 * `created` (the whole create body), `voided` (nothing writes one since the admin void went,
 * #125) and anything that does not match are `undefined`, and the screen shows those as
 * `compactJson` instead of a half-read row.
 */
export function marketEventRows(type: MarketEventType, payload: unknown): EventRow[] | undefined {
  switch (type) {
    case 'resolved': {
      const parsed = RESOLVED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      return [
        { label: copy.marketResolvedResult, value: outcomeLabel(parsed.data.result) },
        ...resolveDetailRows(parsed.data),
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
      const { result, settledAccounts, paidAccounts, paidCoin } = parsed.data;
      return [
        { label: copy.marketResolvedResult, value: outcomeLabel(result) },
        ...(settledAccounts === undefined
          ? []
          : [{ label: copy.eventSettledAccounts, value: String(settledAccounts) }]),
        ...(paidAccounts === undefined
          ? []
          : [{ label: copy.eventPaidAccounts, value: String(paidAccounts) }]),
        ...(paidCoin === undefined
          ? []
          : [{ label: copy.eventPaidTotal, value: formatCoin(parseCoinAmount(paidCoin)) }]),
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
 * stale (a second 판정 of a market another admin has already judged lands here).
 * NOT_FOUND is the market itself (every admin write answers 404 for an unknown id): not a "try
 * again". A NOT_FOUND naming `categoryId` never reaches here — the form callers hand it to
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
    if (field === 'note') return copy.errMarketResolveNote;
    if (field === 'evidenceUrl') return copy.errMarketResolveEvidence;
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
  | 'slug';

const API_FIELD_TO_FORM: Record<string, MarketFormField> = {
  title: 'title',
  description: 'description',
  rules: 'rules',
  resolutionSource: 'resolutionSource',
  categoryId: 'categoryId',
  imageUrl: 'imageUrl',
  closeAt: 'closeAt',
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
  }
}

function isSlugTaken(error: ApiError): boolean {
  if (/already taken/i.test(error.message)) return true;
  return validationMessage(error) === 'already exists';
}
