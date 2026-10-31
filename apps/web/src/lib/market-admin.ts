import {
  AUDIT_FAILURE_KINDS,
  type AdminSettlementStep,
  type AuditFailureKind,
  COIN_UNIT,
  MINUS_SIGN,
  type MarketEventType,
  type MarketResult,
  type MarketStatus,
  OPEN_ITEMS,
  type OpenItem,
  type PaymentStatus,
  type SettlementStep,
  type SettlementStepStatus,
  formatCoin,
  marketResultSchema,
  coinAmountSchema,
  parseCoinAmount,
  uuidParamSchema,
} from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import {
  type ApiError,
  isApiError,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { formatKst } from './datetime';

/**
 * Pure helpers behind the market screens: status and event labels, the list badges (PLAN 12),
 * the admin's settlement-step rows (ADR-0046), and the number formats the public cards and the
 * detail header share with the admin screens. No domain maths lives here — prices and Coin come
 * from the API and @buddha/shared (PLAN 11.5).
 */

/**
 * The status badge's words (ADR-0093 decision 1, item 12): the user labels as the owner gave them,
 * and 초안·검수 중 for the two statuses only an admin sees (검수 중 is #174's choice).
 */
export const MARKET_STATUS_LABEL: Record<MarketStatus, string> = {
  draft: copy.marketStatusDraft,
  review: copy.marketStatusReview,
  scheduled: copy.marketStatusScheduled,
  open: copy.marketStatusOpen,
  paused: copy.marketStatusPaused,
  closed: copy.marketStatusClosed,
  provisional: copy.marketStatusProvisional,
  resolved: copy.marketStatusResolved,
  settling: copy.marketStatusSettling,
  settled: copy.marketStatusSettled,
  cancelled: copy.marketStatusCancelled,
};

/**
 * Chakra colorPalette per status, never the state alone (the label is always beside it, PLAN
 * 11.2). ADR-0093 sets no colours, so these keep the old meanings (#174's choice):
 * - `brand` while it trades: OPEN alone.
 * - `orange` while it waits for something to happen to it — a time (SCHEDULED opens, PAUSED still
 *   closes on schedule), the admin (CLOSED waits for the 판정, PROVISIONAL for its confirmation)
 *   or the worker (RESOLVED and SETTLING for the payout).
 * - `gray` when nothing is coming: over (SETTLED, CANCELLED), or not public yet (DRAFT, REVIEW),
 *   which is where a draft always was.
 *
 * `no` is left to a refusal or a failure (a failed settlement step, a failed payment): VOID is a
 * result now, not a status, and a cancelled market is ended, not failed.
 */
export const MARKET_STATUS_PALETTE: Record<MarketStatus, 'brand' | 'gray' | 'orange'> = {
  draft: 'gray',
  review: 'gray',
  scheduled: 'orange',
  open: 'brand',
  paused: 'orange',
  closed: 'orange',
  provisional: 'orange',
  resolved: 'orange',
  settling: 'orange',
  settled: 'gray',
  cancelled: 'gray',
};

/**
 * A judgement's result in words (ADR-0093 decision 1, item 12): the contracts' 예·아니오 for YES
 * and NO, 무효 for VOID. Every screen that names a result reads it here — the detail's 결과, 내
 * 포지션, MY's 정산 이력, the admin detail and its event log, a theme's results — so none can
 * mistake VOID for NO. A missing result (`null`: before a judgement, or a cancelled market) is the
 * caller's '—'.
 */
export const MARKET_RESULT_LABEL: Record<MarketResult, string> = {
  YES: copy.yes,
  NO: copy.no,
  VOID: copy.marketResultVoid,
};

export const MARKET_EVENT_LABEL: Record<MarketEventType, string> = {
  created: copy.eventCreated,
  opened: copy.eventOpened,
  closed: copy.eventClosed,
  resolved: copy.eventResolved,
  settling: copy.eventSettling,
  finalized: copy.eventFinalized,
  rules_edited: copy.eventRulesEdited,
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
 * 마감 임박 (PLAN 12): an open or paused market whose close time is within the next 24 hours —
 * a paused market still closes on schedule (ADR-0093 decision 1, item 3). A scheduled one is not
 * "closing" before it has opened. A close time already in the past is not "soon" — the market is
 * waiting for the close job, and the 판정 대기 badge takes over once it is closed.
 */
export function isClosingSoon(
  market: { status: MarketStatus; closeAt: string },
  now: number = Date.now(),
): boolean {
  if (market.status !== 'open' && market.status !== 'paused') return false;
  const closeAt = new Date(market.closeAt).getTime();
  if (Number.isNaN(closeAt)) return false;
  return closeAt > now && closeAt - now <= CLOSING_SOON_MS;
}

/** 판정 대기 (ADR-0046): trading has stopped and the market waits for the admin's 판정. */
export function isAwaitingResolution(status: MarketStatus): boolean {
  return status === 'closed';
}

/**
 * 정산 대기 (ADR-0046): the result is confirmed and the worker's settlement steps have not all
 * finished — `resolved` until the worker starts the payout, `settling` while it runs (ADR-0093
 * decision 1, items 1 and 14). The worker runs them right after the 판정, so this lasts seconds;
 * a market that keeps the badge is the operational signal that a step is failing (the detail's
 * 정산 단계 panel says which), which leaves it in `settling`.
 */
export function isAwaitingSettlement(status: MarketStatus): boolean {
  return status === 'resolved' || status === 'settling';
}

/** How often the admin detail re-reads a judged market until it is settled (ADR-0046). */
export const SETTLEMENT_POLL_INTERVAL_MS = 5_000;

/**
 * `refetchInterval` of the admin detail: every 5 s while the market is `resolved` or `settling`
 * (`isAwaitingSettlement`). Nothing else tells this screen that the worker finished or failed a
 * step — the admin query joins no realtime room, and a failed attempt publishes nothing at all —
 * so without it the 정산 단계 panel keeps the `pending` row the 판정 answered with until a
 * reload. Not budgeted like the 결제 내역 poll (payments.ts): a failing step is retried by the
 * worker's per-minute scan, and this panel is where an operator watches those attempts.
 * query-core pauses the interval while the tab is hidden, and it stops by itself at `settled`.
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
 * way to change it afterwards. The interim edge closed → resolved until #152 replaces it with a
 * judgement another admin approves (ADR-0093 result 2).
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
/** The worker's resolved → settling (#174): `{source: 'job'}`, which the 시스템 actor already says. */
const SETTLING_PAYLOAD = z.object({ source: z.string() });
const RESOLVE_DETAIL = {
  note: z.string().nullish(),
  evidenceUrl: z.string().nullish(),
};
/**
 * The 판정 (ADR-0046): `{result, note, evidenceUrl}`. The result is the stored result type
 * (YES·NO·VOID, #174), so a row that carries VOID reads 무효 rather than falling back to JSON —
 * though the interim 판정 writes YES or NO alone until #152.
 */
const RESOLVED_PAYLOAD = z.object({ result: marketResultSchema, ...RESOLVE_DETAIL });
// The counts and the total are what the worker writes today; optional so an older row (or a
// leaner writer) still reads as "지급 완료 · 결과 YES" rather than falling back to JSON.
const FINALIZED_PAYLOAD = z.object({
  result: marketResultSchema,
  settledAccounts: z.number().int().nonnegative().optional(),
  paidAccounts: z.number().int().nonnegative().optional(),
  paidCoin: coinAmountSchema.optional(),
});

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
 * with its note and evidence, the finalize summary — and no row at all for the start of the
 * payout, whose only field is the `source` the 시스템 actor beside it already says. The payload is
 * `unknown` on the wire (jsonb), so each shape is checked before it is read; `created` (the whole
 * create body) and anything that does not match are `undefined`, and the screen shows those as
 * `compactJson` instead of a half-read row.
 */
export function marketEventRows(type: MarketEventType, payload: unknown): EventRow[] | undefined {
  switch (type) {
    case 'resolved': {
      const parsed = RESOLVED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      return [
        { label: copy.marketResolvedResult, value: MARKET_RESULT_LABEL[parsed.data.result] },
        ...resolveDetailRows(parsed.data),
      ];
    }
    case 'settling':
      return SETTLING_PAYLOAD.safeParse(payload).success ? [] : undefined;
    case 'finalized': {
      const parsed = FINALIZED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      const { result, settledAccounts, paidAccounts, paidCoin } = parsed.data;
      return [
        { label: copy.marketResolvedResult, value: MARKET_RESULT_LABEL[result] },
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
 * The open-items check's names (#17), in OPEN_ITEMS order: the draft's notice and the toast of a
 * refused 열기 say the same words (brief labels: 정산 규칙 · 카테고리 · 태그 1~5개).
 */
export const OPEN_ITEM_LABEL: Record<OpenItem, string> = {
  rules: copy.openItemRules,
  category: copy.openItemCategory,
  tags: copy.openItemTags,
};

/** `items` as one line of labels, in OPEN_ITEMS order whatever order they came in, each once. */
function openItemList(items: readonly OpenItem[]): string {
  return OPEN_ITEMS.filter((item) => items.includes(item))
    .map((item) => OPEN_ITEM_LABEL[item])
    .join(' · ');
}

/**
 * The admin draft's notice (#17): '열기 전에 채울 항목: 정산 규칙 · 태그 1~5개' while the open-items
 * check finds something missing (`AdminMarket.missingOpenItems`), `undefined` when nothing is. A
 * draft only — the check is what leaving the draft takes; an open market whose category was hidden
 * later keeps it (#172 item 1) and gets no notice.
 */
export function openItemsNotice(market: {
  status: MarketStatus;
  missingOpenItems: readonly OpenItem[];
}): string | undefined {
  if (market.status !== 'draft' || market.missingOpenItems.length === 0) return undefined;
  return `${copy.adminMarketOpenItems}: ${openItemList(market.missingOpenItems)}`;
}

/**
 * The items an OPEN_ITEMS_MISSING names: one `{path: [item], message}` per missing item (for the
 * category the message is why, which the label does not repeat). Unknown paths are skipped.
 */
function missingItemsOf(error: ApiError): OpenItem[] {
  if (!Array.isArray(error.details)) return [];
  return (error.details as unknown[]).flatMap((issue) => {
    const path: unknown =
      typeof issue === 'object' && issue !== null ? (issue as { path?: unknown }).path : undefined;
    const item: unknown = Array.isArray(path) ? path[0] : undefined;
    return (OPEN_ITEMS as readonly unknown[]).includes(item) ? [item as OpenItem] : [];
  });
}

/**
 * The toast for a refused transition (design 3.4/3.6, 5.5): OPEN_ITEMS_MISSING on open (#17 —
 * '열기 전에 채울 항목이 있습니다: …' naming what the refusal names, or the line alone when it
 * names nothing this screen knows), MARKET_NOT_OPEN on close, VALIDATION_ERROR naming `status`
 * for any other state-machine violation — the two "refresh the screen" messages, since the state
 * on screen is what is stale (a second 판정 of a market another admin has already judged lands
 * here). RULES_REQUIRED is no transition's any more (open answers OPEN_ITEMS_MISSING instead): it
 * is the PATCH that blanks an open market's rules, which `marketFormError` puts on the field.
 * NOT_FOUND is the market itself (every admin write answers 404 for an unknown id): not a "try
 * again". A NOT_FOUND naming `categoryId` never reaches here — the form callers hand it to
 * `marketFormError` first. The cookie of another account (`isForAnotherAccount` — every market
 * write names the admin on screen, ADR-0092) is `copy.sessionChanged`: nothing was done, and the
 * caller asks for the session again (`useSessionChanged`).
 */
export function transitionErrorMessage(error: unknown): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isApiError(error, 'OPEN_ITEMS_MISSING')) {
    const items = openItemList(missingItemsOf(error));
    return items === ''
      ? `${copy.errMarketOpenItemsMissing}.`
      : `${copy.errMarketOpenItemsMissing}: ${items}`;
  }
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
  | 'tags'
  | 'imageUrl'
  | 'closeAt'
  | 'slug';

const API_FIELD_TO_FORM: Record<string, MarketFormField> = {
  title: 'title',
  description: 'description',
  rules: 'rules',
  resolutionSource: 'resolutionSource',
  categoryId: 'categoryId',
  tags: 'tags',
  imageUrl: 'imageUrl',
  closeAt: 'closeAt',
  slug: 'slug',
};

/**
 * Where a refused create/update lands on the form: the field the API named, with the message
 * the admin can act on. `slug` is the UNIQUE collision (design 3.4), `categoryId` an unknown
 * (404) category or one a market may not be filed under, said by why (#17: hidden, under a hidden
 * parent, or holding sub-categories), `tags` (and `tags.N`) a list the API refused — a second
 * name of one tag, a malformed name, too many, or none left on an open market. Anything else —
 * including a VALIDATION_ERROR naming `status`, which is not a field the form has — is
 * `undefined` and goes to the generic toast.
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
      return categoryMessage(error);
    case 'tags':
      return tagsMessage(error);
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

/**
 * Why the API refused the category (#17, ADR-0093 decision 2 #172 item 1): the VALIDATION_ERROR's
 * issue message is the reason (`CATEGORY_UNSELECTABLE_REASONS`); a 404 (unknown id) or a reason
 * this screen does not know is the plain "cannot be chosen".
 */
function categoryMessage(error: ApiError): string {
  if (!isApiError(error, 'VALIDATION_ERROR')) return copy.errMarketCategoryUnavailable;
  switch (validationMessage(error)) {
    case 'inactive':
      return copy.errMarketCategoryHidden;
    case 'parent_inactive':
      return copy.errMarketCategoryParentHidden;
    case 'subcategories':
      return copy.errMarketCategoryHasChildren;
    default:
      return copy.errMarketCategoryUnavailable;
  }
}

/**
 * Why the API refused the tags (#17): `marketTagsSchema`'s duplicate ('duplicate tag', naming the
 * second one's index), the open market left without any ('required while open', naming `tags`),
 * the list over MARKET_TAGS_MAX (naming `tags` itself), and otherwise a name `tagNameSchema`
 * refused (naming `tags.N`): zod's 'Too big' for the length, the pattern's message for the rest.
 */
function tagsMessage(error: ApiError): string {
  const message = validationMessage(error);
  if (message === 'duplicate tag') return copy.errMarketTagDuplicate;
  if (message === 'required while open') return copy.errMarketTagsOpen;
  const first: unknown = Array.isArray(error.details) ? (error.details as unknown[])[0] : undefined;
  const path: unknown =
    typeof first === 'object' && first !== null ? (first as { path?: unknown }).path : undefined;
  if (!Array.isArray(path) || path.length < 2) return copy.errMarketTagsMax;
  return message?.startsWith('Too big') ? copy.errMarketTagLength : copy.errMarketTagFormat;
}

function isSlugTaken(error: ApiError): boolean {
  if (/already taken/i.test(error.message)) return true;
  return validationMessage(error) === 'already exists';
}
