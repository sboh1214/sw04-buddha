import {
  APPROVAL_REASON_MAX_LENGTH,
  APPROVAL_REFUSALS,
  type ApprovalRefusal,
  type ApprovalStatus,
  JUDGEMENT_EVIDENCE_LINKS_MAX,
  JUDGEMENT_EVIDENCE_LINK_MAX,
  MARKET_JUDGEMENT_REFUSALS,
  MARKET_RESULTS,
  type MarketSource,
  STORABLE_INSTANT_MIN,
  duplicateLinkIndexes,
  isBeforeScheduledJudgement,
  isFallbackSourcePriority,
  judgementChoiceRefusals,
  judgementVoidOnly,
  sameJudgementGrounds,
} from '@buddha/shared';
import { copy } from '@/copy';
import { nicknameShown } from './account-closure';
import {
  type AdminMarket,
  type AdminMarketJudgement,
  type JudgementSource,
  type MarketJudgementCorrection,
  type MarketJudgementLogEntry,
  type MarketJudgementPending,
  type RegisterJudgementBody,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
  validationPath,
} from './api';
import { isoToKstLocal, kstLocalToIso } from './datetime';
import {
  type EventRow,
  MARKET_RESULT_LABEL,
  judgementVersionMove,
  judgementVersionName,
} from './market-admin';
import { isHttpUrl } from './market-form';
import { publishedAtWait } from './market-pause';
import { reviewReasonDraft } from './market-review';
import { ruleVersionName } from './rule-versions';

/**
 * The pure half of the 판정 screens (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·4·5·9·11–13,
 * decision 3 the #152 rows '역할'·'판정 출처'·'증거'·'등록 시점') and of the 판정 정정 (#176, ADR-0105;
 * #173 items 2·5·7·8, decision 3 '#176 정정 대기'): whether the admin detail draws the 판정 panel and
 * offers a registration or a correction and why not, the sources a judgement may name, who on
 * screen may decide the registration waiting and whether it can be approved, what the panel, its
 * 판정 기록 and its 판정 버전 이력 read, what each write may send and what a refusal says. A correction
 * is a registration too — the same approval kind and routes — told apart by its `correction`
 * (the version it replaces and its reason), never by the market's status. The panel, its form and
 * dialogs (app/admin/markets/[id]/market-judgement-*.tsx) and the 판정 승인 대기 queue draw them.
 * Admin-only (excluded-features.test.ts): the evidence, the reasons, the instants and the admins
 * are never a member's — the public judging record (#24) decides what of it is shown (a
 * correction's previous versions and reason included, #173 item 13), never who registered or
 * approved it. The event rows' names (`judgementVersionName`, `judgementVersionMove`, the results)
 * are lib/market-admin.ts', which the 이벤트 로그 reads too.
 */

/** How a registration ended, its badge in the 판정 기록 (`approval_requests.status`). */
export const JUDGEMENT_STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: copy.judgementStatusPending,
  approved: copy.judgementStatusApproved,
  rejected: copy.judgementStatusRejected,
  retracted: copy.judgementStatusRetracted,
};

/**
 * Whether the admin detail draws the 판정 panel: on a market CLOSED (to register its judgement) or
 * PROVISIONAL (its deadline), and on any that has a judgement or a registration — a confirmed
 * market keeps its record, read-only, and a registration still waiting once the market moved on is
 * shown for its 반려 or 철회. Not before the close, and not for a market judged before #152 (ADR-0046's
 * one-admin 판정 left no judgement and no registration).
 */
export function showsJudgementPanel(market: Pick<AdminMarket, 'status' | 'judgement'>): boolean {
  return (
    market.status === 'closed' ||
    market.status === 'provisional' ||
    market.judgement.current !== null ||
    market.judgement.log.length > 0
  );
}

/**
 * Why 판정 등록 — or, given the version it replaces (`baseVersion`), 판정 정정 (#176) — is not
 * offered, in the order the API checks it (MARKET_JUDGEMENT_REFUSALS, `judgementStatusRefusal`):
 * `status` — a first judgement's market is not CLOSED (#173 item 1: a registration any time after
 * the close, until one is approved), a correction's not PROVISIONAL (#173 item 8: corrections
 * before the confirmation alone); `stale` — the correction's version is no longer the current one
 * (another correction was approved meanwhile); `pending` — one waits already (one at a time, a
 * first judgement and a correction alike), which the panel shows instead; `undecided` — for a first
 * judgement, the release setting `market.dispute_window` is undecided and no deadline can be fixed
 * from no value (ADR-0103: the registration and the approval are both refused then; a correction
 * reads no setting, its deadline taking the first one's length, #173 item 5). The server's
 * `no_decider` (no admin but the registrant could decide it) is not knowable here: its refusal says
 * it. `null` when it is offered.
 */
export type JudgementUnavailable = 'status' | 'stale' | 'pending' | 'undecided';

export function judgementUnavailable(
  market: Pick<AdminMarket, 'status' | 'judgement'>,
  baseVersion: number | null = null,
): JudgementUnavailable | null {
  if (baseVersion === null) {
    if (market.status !== 'closed') return 'status';
    if (market.judgement.pending !== null) return 'pending';
    return market.judgement.disputeWindowUndecided ? 'undecided' : null;
  }
  if (market.status !== 'provisional') return 'status';
  if (market.judgement.current?.version !== baseVersion) return 'stale';
  return market.judgement.pending !== null ? 'pending' : null;
}

/**
 * The current judgement a 판정 정정 would replace (#176, ADR-0105), or `null` when none is offered
 * (`judgementUnavailable` for it): a PROVISIONAL market with none waiting. The panel's 판정 정정
 * and an accepted dispute's 정정 등록 open the form on it, prefilled
 * (`judgementCorrectionDefaults`). Any admin may register it — the base version's registrant and
 * approver, and the admin who accepted the dispute, included (ADR-0105: as #152's registration).
 */
export function judgementCorrectionBase(
  market: Pick<AdminMarket, 'status' | 'judgement'>,
): AdminMarketJudgement | null {
  const { current } = market.judgement;
  if (current === null) return null;
  return judgementUnavailable(market, current.version) === null ? current : null;
}

/**
 * What the registration form says once the market read takes no registration
 * (`judgementUnavailable`): the form stays with what was typed, says why and sends nothing — a
 * correction's form (`correction`) in its own words for `status` and `stale`.
 */
export function judgementFormUnavailableNote(
  reason: JudgementUnavailable,
  correction: boolean,
): string {
  switch (reason) {
    case 'status':
      return correction
        ? copy.adminMarketJudgementCorrectionFormStatus
        : copy.adminMarketJudgementFormStatus;
    case 'stale':
      return copy.adminMarketJudgementCorrectionFormStale;
    case 'pending':
      return copy.adminMarketJudgementFormPending;
    case 'undecided':
      return copy.adminMarketJudgementWindowUndecided;
  }
}

/**
 * Why the waiting registration cannot be approved as the row read stands, or `null` when it can
 * (the approval checks each again at its own instant): `status` — a first judgement's market is no
 * longer CLOSED, a correction's no longer PROVISIONAL (nothing moves either while one waits —
 * a waiting correction holds the confirmation — but a 반려 or 철회 still ends it in any status);
 * `stale` — a correction's version is no longer the current one (one waits at a time, so none can
 * be approved meanwhile; the API refuses it all the same); `undecided` — for a first judgement, the
 * dispute window is undecided, which the panel's warning says. Either way its 반려 or its 철회 ends
 * it.
 */
export type JudgementUnapprovable = 'status' | 'stale' | 'undecided';

export function judgementUnapprovable(
  market: Pick<AdminMarket, 'status' | 'judgement'>,
): JudgementUnapprovable | null {
  const correction = market.judgement.pending?.correction ?? null;
  if (correction === null) {
    if (market.status !== 'closed') return 'status';
    return market.judgement.disputeWindowUndecided ? 'undecided' : null;
  }
  if (market.status !== 'provisional') return 'status';
  return market.judgement.current?.version === correction.baseVersion ? null : 'stale';
}

/**
 * What the waiting registration says while it cannot be approved (`judgementUnapprovable`), or
 * `null` where the panel says it otherwise (the undecided window's own warning).
 */
export function judgementUnapprovableNote(
  reason: JudgementUnapprovable,
  correction: boolean,
): string | null {
  switch (reason) {
    case 'status':
      return correction
        ? copy.adminMarketJudgementCorrectionPendingStatus
        : copy.adminMarketJudgementPendingStatus;
    case 'stale':
      return copy.adminMarketJudgementCorrectionPendingStale;
    case 'undecided':
      return null;
  }
}

/**
 * Whether the admin on screen registered the waiting judgement — who may not approve or reject it
 * and alone may retract it (decision 3 '역할', ADR-0056 1-1: `requester`, `not_requester`) — or
 * `undefined` until `GET /me` has said who is on screen (`useOperatorId`): the panel offers no
 * decision until then. Only that judgement's registrant is barred: the admin who rejected an
 * earlier one may approve this one, and its registrant may decide a later one by someone else.
 */
export function isJudgementRegistrant(
  pending: Pick<MarketJudgementPending, 'requestedBy'>,
  operatorId: string | undefined,
): boolean | undefined {
  return operatorId === undefined ? undefined : pending.requestedBy.id === operatorId;
}

/** Who did a step: the nickname, or '탈퇴한 사용자' for an account gone since. */
export function judgementActorName(actor: { nickname: string | null }): string {
  return nicknameShown(actor.nickname);
}

/**
 * Whether the market takes a VOID judgement alone (`judgementVoidOnly`, ADR-0102 결과 5): its last
 * pause — the newest of `pause.history` — ended in an approved 조기 마감 reviewed 판정 불가. The
 * form preselects 무효 and turns YES and NO off, and says why.
 */
export function marketJudgementVoidOnly(market: Pick<AdminMarket, 'pause'>): boolean {
  return judgementVoidOnly(market.pause.history[0] ?? null);
}

/**
 * Whether `now` is before the market's scheduled judgement (decision 3 '등록 시점'): the register
 * and approve screens warn then, the approver confirms the NO condition's event deadline, and the
 * 판정 승인 대기 queue marks the row. A market with none (opened before #22) never is. `now` is read
 * in render through the default, as `isClosingSoon` is: the admin screens never render on the
 * server, so there is no hydration to mismatch.
 */
export function judgementEarly(
  market: Pick<AdminMarket, 'scheduledJudgementAt'>,
  now: number = Date.now(),
): boolean {
  return isBeforeScheduledJudgement(market.scheduledJudgementAt, now);
}

/** The longest the waiting registration waits at once — a day, as the pause dialog's instant. */
const SCHEDULED_JUDGEMENT_WAIT_MAX_MS = 24 * 60 * 60 * 1_000;

/**
 * How long from `now` until the scheduled judgement has come — `judgementEarly` lifted — with a
 * second's margin and at most a day; `null` when it is not ahead (or there is none). A CLOSED
 * market's detail is not polled, so the waiting registration waits this long and draws again, and
 * its warning goes when the time comes, as the approve dialog's (which reads the clock) does.
 */
export function scheduledJudgementWait(
  market: Pick<AdminMarket, 'scheduledJudgementAt'>,
  now: number,
): number | null {
  if (market.scheduledJudgementAt === null) return null;
  const wait = Date.parse(market.scheduledJudgementAt) - now;
  return wait > 0 ? Math.min(wait + 1_000, SCHEDULED_JUDGEMENT_WAIT_MAX_MS) : null;
}

// ---- sources ---------------------------------------------------------------------------------

/** 판정 출처's name for a priority: 1차 출처 for 0, 대체 출처 n for n (ADR-0097 7-3). */
export function judgementSourceLabel(priority: number): string {
  return isFallbackSourcePriority(priority)
    ? `${copy.adminMarketJudgementSourceFallback} ${String(priority)}`
    : copy.adminMarketJudgementSourcePrimary;
}

/** One choice of 판정 출처: the rule's source at its priority. */
export interface JudgementSourceChoice {
  priority: number;
  source: MarketSource;
}

/**
 * The sources a judgement may name (decision 3 '판정 출처'): the rule's 1차 출처 at priority 0 and
 * its 대체 출처 at 1.. in order — the admin detail's `fallbackSources` are in priority order, and
 * the rules are frozen after the close (ADR-0101: no supplement then), so the API copies the same
 * source's name and address. None for a market opened before #23, which a VOID alone judges.
 */
export function judgementSourceChoices(
  market: Pick<AdminMarket, 'primarySource' | 'fallbackSources'>,
): JudgementSourceChoice[] {
  return [
    ...(market.primarySource === null ? [] : [{ priority: 0, source: market.primarySource }]),
    ...market.fallbackSources.map((source, index) => ({ priority: index + 1, source })),
  ];
}

/** A source a judgement names, as one line: its name, then 'name (url)'; none for a VOID's. */
export function judgementSourceText(source: JudgementSource | null): string {
  if (source === null) return copy.adminMarketJudgementSourceNone;
  const name = source.name.trim();
  const url = source.url.trim();
  const text = name !== '' && url !== '' ? `${name} (${url})` : name || url;
  return `${judgementSourceLabel(source.priority)} · ${text}`;
}

// ---- rows ------------------------------------------------------------------------------------

/** What a registration says, as every view of it reads it. */
type Registration = Pick<
  MarketJudgementPending,
  'result' | 'source' | 'fallbackReason' | 'voidReason' | 'evidence' | 'description' | 'ruleVersion'
>;

/** The rule version a judgement follows, or 규칙 버전 없음 for a market opened before #80. */
export function judgementRuleVersionText(ruleVersion: number | null): string {
  return ruleVersion === null
    ? copy.adminMarketJudgementNoRuleVersion
    : ruleVersionName(ruleVersion);
}

/**
 * A registration as rows: the result, the source, the fallback reason and the VOID reason (each
 * absent where it has none), the evidence links one per line, the collection instant, what was
 * confirmed and the rule version it follows. `time` renders an instant (the admin's KST).
 */
export function judgementRegistrationRows(
  registration: Registration,
  time: (iso: string) => string,
): EventRow[] {
  const rows: EventRow[] = [
    { label: copy.adminMarketJudgementResult, value: MARKET_RESULT_LABEL[registration.result] },
    { label: copy.adminMarketJudgementSource, value: judgementSourceText(registration.source) },
  ];
  if (registration.fallbackReason !== null) {
    rows.push({
      label: copy.adminMarketJudgementFallbackReason,
      value: registration.fallbackReason,
    });
  }
  if (registration.voidReason !== null) {
    rows.push({ label: copy.adminMarketJudgementVoidReason, value: registration.voidReason });
  }
  rows.push(
    { label: copy.adminMarketJudgementLinks, value: registration.evidence.links.join('\n') },
    {
      label: copy.adminMarketJudgementCollectedAt,
      value: time(registration.evidence.collectedAt),
    },
    { label: copy.adminMarketJudgementDescription, value: registration.description },
    {
      label: copy.adminMarketJudgementRuleVersion,
      value: judgementRuleVersionText(registration.ruleVersion),
    },
  );
  return rows;
}

/**
 * What a judgement adds to its registration — the current one, and each of the 판정 버전 이력
 * (`judgement.history`, #176): its version, who registered and who approved it, the instant its
 * 잠정 결과 was published, the dispute window and the deadline it fixed (#173 item 5: a correction's
 * the first one's length, from its approval), when the approval came before the scheduled judgement
 * that the approver confirmed the event deadline, and — for a version a correction made — its
 * correction reason.
 */
export function judgementCurrentRows(
  current: AdminMarketJudgement,
  time: (iso: string) => string,
): EventRow[] {
  const rows: EventRow[] = [
    { label: copy.adminMarketJudgementVersion, value: judgementVersionName(current.version) },
    {
      label: copy.adminMarketJudgementRegisteredBy,
      value: judgementActorName(current.registeredBy),
    },
    { label: copy.adminMarketJudgementApprovedBy, value: judgementActorName(current.approvedBy) },
    { label: copy.adminMarketJudgementPublishedAt, value: time(current.publishedAt) },
    {
      label: copy.adminMarketJudgementWindow,
      value: `${current.disputeWindowMinutes.toLocaleString('ko-KR')}${copy.adminMarketJudgementWindowMinutes}`,
    },
    { label: copy.adminMarketJudgementDeadline, value: time(current.disputeDeadline) },
  ];
  if (current.eventDeadlineConfirmed) {
    rows.push({
      label: copy.adminMarketJudgementDeadlineConfirmed,
      value: copy.adminMarketJudgementDeadlineConfirmedDone,
    });
  }
  if (current.correctionReason !== null) {
    rows.push({
      label: copy.adminMarketJudgementCorrectionReason,
      value: current.correctionReason,
    });
  }
  return rows;
}

/**
 * One registration of the 판정 기록 (`AdminMarket.judgement.log`) as rows below its status,
 * registrant and time: a correction's move ('v1 → v2') and reason first (#176), what it says
 * (`judgementRegistrationRows`), then how it ended — the version an approval made, the decider, the
 * decision's instant and reason, the 철회's instant. Each absent where it has none, and a
 * correction's made version too, which its move names.
 */
export function judgementLogRows(
  entry: MarketJudgementLogEntry,
  time: (iso: string) => string,
): EventRow[] {
  const rows = [
    ...judgementCorrectionRows(entry.correction),
    ...judgementRegistrationRows(entry, time),
  ];
  // A correction's move already names the version its approval made.
  if (entry.version !== null && entry.correction === null) {
    rows.push({
      label: copy.adminMarketJudgementVersion,
      value: judgementVersionName(entry.version),
    });
  }
  if (entry.decidedBy !== null) {
    rows.push({ label: copy.judgementLogDecidedBy, value: judgementActorName(entry.decidedBy) });
  }
  if (entry.decidedAt !== null) {
    rows.push({ label: copy.judgementLogDecidedAt, value: time(entry.decidedAt) });
  }
  if (entry.decisionReason !== null) {
    rows.push({ label: copy.judgementLogDecisionReason, value: entry.decisionReason });
  }
  if (entry.retractedAt !== null) {
    rows.push({ label: copy.judgementLogRetractedAt, value: time(entry.retractedAt) });
  }
  return rows;
}

/**
 * A correction's own rows (#176): the version it replaces and the one its approval would make
 * ('v1 → v2'), and its reason; none for a first judgement.
 */
export function judgementCorrectionRows(
  correction: Pick<MarketJudgementCorrection, 'baseVersion' | 'reason'> | null,
): EventRow[] {
  if (correction === null) return [];
  return [
    {
      label: copy.adminMarketJudgementCorrectionVersion,
      value: judgementVersionMove(correction.baseVersion),
    },
    { label: copy.adminMarketJudgementCorrectionReason, value: correction.reason },
  ];
}

// ---- what each write may send ----------------------------------------------------------------

/** 판정 출처's value for none ('규칙의 출처 없음'), which a VOID alone may pick. */
export const JUDGEMENT_SOURCE_NONE = 'none';

/** 판정 등록 as the form holds it: every control's value as typed or picked ('' for none). */
export interface JudgementFormValues {
  /** '', or a result of MARKET_RESULTS. */
  result: string;
  /** '', a priority as digits, or JUDGEMENT_SOURCE_NONE. */
  source: string;
  fallbackReason: string;
  voidReason: string;
  /** One input per link, in order; the form keeps at least one. */
  links: readonly string[];
  /** The collection instant as a KST `datetime-local`. */
  collectedLocal: string;
  description: string;
  /** A correction's reason (#176); a first judgement's form has no such field and keeps ''. */
  correctionReason: string;
}

/** The form a registration opens with: 무효 picked on a market that takes it alone. */
export function judgementFormDefaults(voidOnly: boolean): JudgementFormValues {
  return {
    result: voidOnly ? 'VOID' : '',
    source: '',
    fallbackReason: '',
    voidReason: '',
    links: [''],
    collectedLocal: '',
    description: '',
    correctionReason: '',
  };
}

/**
 * The form a correction opens with (#176): the version it replaces as the form holds a
 * registration — its result, its source by priority (규칙의 출처 없음 for a VOID with none), both
 * reasons, its links, its collection instant in KST and its description — so the admin changes
 * what is wrong and leaves the rest; the correction reason empty. A market that takes 무효 alone
 * was judged 무효, so the prefill keeps it.
 */
export function judgementCorrectionDefaults(base: AdminMarketJudgement): JudgementFormValues {
  return {
    result: base.result,
    source: base.source === null ? JUDGEMENT_SOURCE_NONE : String(base.source.priority),
    fallbackReason: base.fallbackReason ?? '',
    voidReason: base.voidReason ?? '',
    links: base.evidence.links.length > 0 ? [...base.evidence.links] : [''],
    collectedLocal: isoToKstLocal(base.evidence.collectedAt),
    description: base.description,
    correctionReason: '',
  };
}

/** What each field says is wrong with it, or null; `links` one per input. */
export interface JudgementFormErrors {
  result: string | null;
  source: string | null;
  fallbackReason: string | null;
  voidReason: string | null;
  links: (string | null)[];
  collectedAt: string | null;
  description: string | null;
  /** A correction's reason (#176): none, or over 500 characters. */
  correctionReason: string | null;
  /** A correction that changes nothing of its base version (#176, the API's 'unchanged'). */
  correction: string | null;
}

/** The registration's fields without the admin it names (ADR-0092). */
export type JudgementRegistration = Omit<RegisterJudgementBody, 'expectedAccountId'>;

/**
 * 판정 등록 as the form holds it (`registerJudgementBodySchema`'s rules, which the API checks again):
 * - `result`: YES, NO or VOID — VOID alone on a market closed early as 판정 불가 (`voidOnly`);
 * - `source`: a rule source by its priority, or none for a VOID alone (`judgementChoiceRefusals`'
 *   'source'); `needsFallbackReason` once a 대체 출처 is picked, `needsVoidReason` once VOID is — each
 *   reason sent only then (the API refuses it otherwise) and required 1..500 trimmed;
 * - the links: each trimmed, http(s), at most JUDGEMENT_EVIDENCE_LINK_MAX characters, none twice
 *   (`duplicateLinkIndexes`), 1..JUDGEMENT_EVIDENCE_LINKS_MAX of them;
 * - the collection instant: a KST `datetime-local` (ADR-0093 decision 3: entered in KST, sent in
 *   UTC), from STORABLE_INSTANT_MIN on and not after `now` (the API refuses one after its clock,
 *   'after now'; no lower bound — an early result can predate the close);
 * - the description of what was confirmed: 1..500 trimmed;
 * - a correction's (`base`, the version it replaces, #176): its reason, 1..500 trimmed, and a
 *   change — the result or its grounds (`sameJudgementGrounds`, the API's 'unchanged': #173 item
 *   7, with nothing to change the dispute is dismissed). The collection instant left as prefilled
 *   sends the base version's own, to the millisecond (the control holds minutes), so leaving it
 *   alone changes nothing.
 * `registration` is what is sent once `ready` — `correction` null for a first judgement; `errors`
 * what each field says (the caller shows them once the form was sent once, the instant's 'after
 * now' at once). `now` is read in render through the default, as `pauseDraft` does; the form draws
 * again as the minute typed comes (`collectedAtWait`).
 */
export function judgementDraft(
  values: JudgementFormValues,
  voidOnly: boolean,
  now: number = Date.now(),
  base: AdminMarketJudgement | null = null,
): {
  ready: boolean;
  registration: JudgementRegistration | null;
  errors: JudgementFormErrors;
  needsFallbackReason: boolean;
  needsVoidReason: boolean;
} {
  const result = MARKET_RESULTS.find((choice) => choice === values.result) ?? null;
  let resultError: string | null = null;
  if (result === null) resultError = copy.errMarketJudgementResult;
  else if (voidOnly && result !== 'VOID') resultError = copy.errMarketJudgementVoidOnly;

  const priority = /^\d$/.test(values.source) ? Number(values.source) : null;
  const sourcePicked = priority !== null || values.source === JUDGEMENT_SOURCE_NONE;
  const needsFallbackReason = priority !== null && isFallbackSourcePriority(priority);
  const needsVoidReason = result === 'VOID';
  const fallback = needsFallbackReason ? reasonOf(values.fallbackReason) : null;
  const voidReason = needsVoidReason ? reasonOf(values.voidReason) : null;
  const choiceRefused =
    result !== null &&
    judgementChoiceRefusals({
      result,
      source: priority === null ? null : { priority },
      fallbackReason: fallback?.reason ?? null,
      voidReason: voidReason?.reason ?? null,
    }).some((refusal) => refusal.path === 'source');
  const sourceError = !sourcePicked || choiceRefused ? copy.errMarketJudgementSource : null;

  const links = values.links.map((link) => link.trim());
  const repeated = new Set(duplicateLinkIndexes(links));
  const linkErrors = links.map((link, index) => {
    if (link.length > JUDGEMENT_EVIDENCE_LINK_MAX || !isHttpUrl(link)) {
      return copy.errMarketJudgementLink;
    }
    return repeated.has(index) ? copy.errMarketJudgementLinkDuplicate : null;
  });
  const linksCounted = links.length >= 1 && links.length <= JUDGEMENT_EVIDENCE_LINKS_MAX;

  const untouched =
    base !== null && values.collectedLocal === isoToKstLocal(base.evidence.collectedAt);
  const collectedAt = untouched ? base.evidence.collectedAt : kstLocalToIso(values.collectedLocal);
  let collectedAtError: string | null = null;
  if (values.collectedLocal === '') collectedAtError = copy.errMarketJudgementCollectedAtRequired;
  else if (collectedAt === null || Date.parse(collectedAt) < Date.parse(STORABLE_INSTANT_MIN)) {
    collectedAtError = copy.errMarketJudgementCollectedAtTime;
  } else if (Date.parse(collectedAt) > now) {
    collectedAtError = copy.errMarketJudgementCollectedAtAfter;
  }

  const description = reasonOf(values.description);
  const correctionReason = base === null ? null : reasonOf(values.correctionReason);
  const errors: JudgementFormErrors = {
    result: resultError,
    source: sourceError,
    fallbackReason: fallback?.ok === false ? copy.errMarketJudgementFallbackReason : null,
    voidReason: voidReason?.ok === false ? copy.errMarketJudgementVoidReason : null,
    links: linksCounted ? linkErrors : linkErrors.map(() => copy.errMarketJudgementLinks),
    collectedAt: collectedAtError,
    description: description.ok ? null : copy.errMarketJudgementDescription,
    correctionReason:
      correctionReason?.ok === false ? copy.errMarketJudgementCorrectionReason : null,
    correction: null,
  };
  const grounded =
    errors.result === null &&
    errors.source === null &&
    errors.fallbackReason === null &&
    errors.voidReason === null &&
    linksCounted &&
    errors.links.every((error) => error === null) &&
    errors.collectedAt === null &&
    errors.description === null;
  const grounds =
    grounded && result !== null && collectedAt !== null
      ? {
          result,
          source: priority === null ? null : { priority },
          fallbackReason: fallback?.reason ?? null,
          voidReason: voidReason?.reason ?? null,
          evidence: { links, collectedAt },
          description: description.reason,
        }
      : null;
  // Only grounds that could be sent are compared: until then each field says what it lacks.
  if (base !== null && grounds !== null && sameJudgementGrounds(base, grounds)) {
    errors.correction = copy.errMarketJudgementCorrectionUnchanged;
  }
  const ready = grounds !== null && errors.correctionReason === null && errors.correction === null;
  return {
    ready,
    registration:
      ready && grounds !== null
        ? {
            ...grounds,
            correction:
              base === null || correctionReason === null
                ? null
                : { baseVersion: base.version, reason: correctionReason.reason },
          }
        : null,
    errors,
    needsFallbackReason,
    needsVoidReason,
  };
}

/** A reason as typed: trimmed, and whether it is 1..APPROVAL_REASON_MAX_LENGTH characters. */
function reasonOf(text: string): { reason: string; ok: boolean } {
  const reason = text.trim();
  return { reason, ok: reason.length >= 1 && reason.length <= APPROVAL_REASON_MAX_LENGTH };
}

/**
 * How long from `now` until the collection instant typed (`collectedLocal`) is no longer after now
 * — `judgementDraft`'s 'after now' lifted — as the pause's publication instant waits
 * (`publishedAtWait`: a second's margin, at most a day); `null` when it is not after now, or is
 * unreadable. The form waits this long while that sentence is said and then draws again.
 */
export function collectedAtWait(collectedLocal: string, now: number): number | null {
  return publishedAtWait(collectedLocal, now);
}

/**
 * 승인 as the dialog holds it: the reason (1..500 trimmed) and, when the dialog asks for it — the
 * approval comes before the scheduled judgement, or the server said so (`eventDeadlineConfirmed`
 * 'required') — the approver's confirmation of the NO condition's event deadline (decision 3 '등록
 * 시점'). `eventDeadlineConfirmed` is what is sent: true only when asked and checked (stored on the
 * judgement, false when not needed). `ready` once the reason is typed and, when asked, checked.
 */
export function judgementApproveDraft(
  reasonText: string,
  confirmed: boolean,
  asked: boolean,
): { ready: boolean; reason: string; eventDeadlineConfirmed: boolean } {
  const { reason, error } = reviewReasonDraft(reasonText);
  return {
    ready: error === null && (!asked || confirmed),
    reason,
    eventDeadlineConfirmed: asked && confirmed,
  };
}

/** A decision on the waiting registration: its 승인, its 반려, or its registrant's 철회. */
export type JudgementDecision = 'approve' | 'reject' | 'retract';

/** What a decision's dialog is called, says and toasts once it went through. */
export interface JudgementDecisionTexts {
  title: string;
  body: string;
  done: string;
}

/**
 * What a waiting 판정 정정's 반려 or 철회 leaves (#176, ADR-0105), as its dialog says it:
 * `reopened` — how many accepted disputes were registered with it (`correction.disputeIds`), which
 * go back to 검토 중 (owner answer 2026-11-02, the 철회 as the 반려); `deadlinePassed` — the market's
 * 이의 기한 had passed as the detail was read (`judgementDeadlinePassed`), so once nothing holds it
 * any more the API queues the confirmation at once and the worker confirms the current version
 * within seconds, after which it takes no correction (#173 item 8).
 */
export interface CorrectionEnd {
  reopened: number;
  deadlinePassed: boolean;
}

/**
 * Whether a 잠정 결과 market's 이의 기한 had passed at `readAt` (the detail query's
 * `dataUpdatedAt`, as the panels judge the close and the scheduled judgement): never a clock read
 * in render. The detail reads a 잠정 결과 market again at its deadline
 * (`provisionalMarketPollDelay`), so a dialog opened before it says so once that read lands. False
 * for any other status, and for a missing or unreadable deadline.
 */
export function judgementDeadlinePassed(
  market: Pick<AdminMarket, 'status' | 'disputeDeadline'>,
  readAt: number,
): boolean {
  if (market.status !== 'provisional' || market.disputeDeadline === null) return false;
  const deadline = Date.parse(market.disputeDeadline);
  return !Number.isNaN(deadline) && deadline <= readAt;
}

/**
 * What the registration a dialog decides leaves if it is rejected or retracted (`CorrectionEnd`),
 * read at `readAt`; `null` for a first judgement's (or none).
 */
export function judgementCorrectionEnd(
  request: Pick<MarketJudgementPending, 'correction'> | null,
  market: Pick<AdminMarket, 'status' | 'disputeDeadline'>,
  readAt: number,
): CorrectionEnd | null {
  const correction = request?.correction ?? null;
  if (correction === null) return null;
  return {
    reopened: correction.disputeIds.length,
    deadlinePassed: judgementDeadlinePassed(market, readAt),
  };
}

/**
 * The three dialogs' words by whether the registration decided is a correction (#176, ADR-0105):
 * a first judgement's 승인 publishes the 잠정 결과 and starts the window (출시 설정); a correction's
 * moves the version on, publishes its result at once, gives the first deadline's length again
 * from the approval and closes the replaced version's pending disputes as 정정으로 종결 (#173 items
 * 5·8). A first judgement's 반려 leaves the market CLOSED; a correction's 반려 and 철회 leave the
 * version, its deadline and its disputes' results as they were (decision 3 '#176 정정 대기') and
 * — only when it carried any (`reopened`) — send the accepted disputes registered with it back to
 * 검토 중 (owner answer 2026-11-02 — the 철회 as the 반려, ADR-0105); past the deadline
 * (`deadlinePassed`) they say the current version is then confirmed within seconds once nothing
 * holds it, and is no longer correctable (the API queues the confirmation at once, as the #175
 * dismissal's dialog says). `correction` is `null` for a first judgement; a correction's 승인 reads
 * nothing of it.
 */
export function judgementDecisionTexts(
  kind: JudgementDecision,
  correction: CorrectionEnd | null,
): JudgementDecisionTexts {
  switch (kind) {
    case 'approve':
      return correction !== null
        ? {
            title: copy.adminMarketJudgementCorrectionApproveTitle,
            body: copy.adminMarketJudgementCorrectionApproveBody,
            done: copy.adminMarketJudgementCorrectionApproved,
          }
        : {
            title: copy.adminMarketJudgementApproveTitle,
            body: copy.adminMarketJudgementApproveBody,
            done: copy.adminMarketJudgementApproved,
          };
    case 'reject':
      return correction !== null
        ? {
            title: copy.adminMarketJudgementCorrectionRejectTitle,
            body: correctionEndBody(copy.adminMarketJudgementCorrectionRejectBody, correction),
            done: copy.adminMarketJudgementCorrectionRejected,
          }
        : {
            title: copy.adminMarketJudgementRejectTitle,
            body: copy.adminMarketJudgementRejectBody,
            done: copy.adminMarketJudgementRejected,
          };
    case 'retract':
      return correction !== null
        ? {
            title: copy.adminMarketJudgementCorrectionRetractTitle,
            body: correctionEndBody(
              copy.adminMarketJudgementCorrectionRetractBody,
              correction,
              copy.adminMarketJudgementCorrectionRetractConfirm,
            ),
            done: copy.adminMarketJudgementCorrectionRetracted,
          }
        : {
            title: copy.adminMarketJudgementRetractTitle,
            body: copy.adminMarketJudgementRetractBody,
            done: copy.adminMarketJudgementRetracted,
          };
  }
}

/**
 * A correction's 반려 or 철회 body: its first sentence, the reopened disputes' when it carried any,
 * the confirmation's past the deadline, then the question a 철회 asks.
 */
function correctionEndBody(first: string, end: CorrectionEnd, question?: string): string {
  return [
    first,
    end.reopened > 0 ? copy.adminMarketJudgementCorrectionReopen : null,
    end.deadlinePassed ? copy.adminMarketJudgementCorrectionEndConfirms : null,
    question ?? null,
  ]
    .filter((sentence) => sentence !== null)
    .join(' ');
}

// ---- what a refusal says ---------------------------------------------------------------------

/**
 * The two-person rule's refusals as the judgement says them: the registrant's in its own words,
 * the rest as every approval screen says them (`creator` and `editor` are the review's, which no
 * judgement meets).
 */
const JUDGEMENT_REFUSAL_MESSAGES: Readonly<Record<ApprovalRefusal, string>> = {
  requester: copy.adminMarketJudgementExcludedRequester,
  decided: copy.errApprovalDecided,
  retracted: copy.errApprovalRetracted,
  not_requester: copy.errApprovalNotRequester,
  creator: copy.errApprovalCreator,
  editor: copy.errApprovalEditor,
  no_decider: copy.errApprovalNoDecider,
};

/**
 * The write a refusal answers: the registration (`POST …/judgements`, a first judgement's or a
 * correction's) or a decision of the one waiting (its approval, 반려 or 철회) — whose `status` and
 * `stale` refusals say different things.
 */
export type JudgementWrite = 'register' | 'decision';

/**
 * The fields a refusal can land under: the registration form's — the result, the source, the two
 * reasons, a link (`index`, or every link for their count), the collection instant, the
 * description, a correction's reason and the correction as a whole (nothing changed, #176) — and
 * the decision dialogs' reason and the approval's event-deadline confirmation.
 */
export type JudgementField =
  | 'result'
  | 'source'
  | 'fallbackReason'
  | 'voidReason'
  | 'links'
  | 'collectedAt'
  | 'description'
  | 'correctionReason'
  | 'correction'
  | 'reason'
  | 'eventDeadlineConfirmed';

/**
 * Where a refused judgement write is said (#152):
 * - `field`: under the input it is about — the result (none, or YES·NO on a market closed early as
 *   판정 불가), the source (none for a YES or NO), the fallback and VOID reasons (missing, too long,
 *   or one the choice takes none of), a link (`index`: not http(s), too long, given twice — or,
 *   without one, their count), the collection instant (unreadable, after now), the description, a
 *   correction's reason and a correction that changes nothing (`correction`, #176), a decision's
 *   reason, the approval's event-deadline confirmation (needed before the scheduled judgement — the
 *   dialog then asks for it);
 * - `alert`: in the form or the dialog, which stays — the market not CLOSED (a first judgement's)
 *   or not PROVISIONAL (a correction's, `notProvisional`), the version a correction replaces no
 *   longer the current one (`stale`), another registration waiting, the dispute window undecided,
 *   a source the rules no longer have, an unknown request,
 *   APPROVAL_NOT_ALLOWED by its reason (the registrant, decided, retracted, no other admin to
 *   decide), the market gone, a session ended or a role revoked, a request that never reached the
 *   API or an internal error. `refresh` when the screen behind is out of date: the caller reads the
 *   detail again;
 * - `toast`: the cookie of another account (ADR-0092): nothing was done, the form or dialog closes
 *   and the session is asked again.
 */
export type JudgementFailure =
  | { kind: 'field'; field: JudgementField; index?: number; message: string }
  | { kind: 'alert'; message: string; refresh: boolean }
  | { kind: 'toast'; message: string };

export function judgementFailure(error: unknown, write: JudgementWrite): JudgementFailure {
  const alert = (message: string, refresh = false): JudgementFailure => ({
    kind: 'alert',
    message,
    refresh,
  });
  const field = (name: JudgementField, message: string, index?: number): JudgementFailure =>
    index === undefined
      ? { kind: 'field', field: name, message }
      : { kind: 'field', field: name, index, message };
  if (isForAnotherAccount(error)) return { kind: 'toast', message: copy.sessionChanged };
  if (isApiError(error, 'UNAUTHENTICATED')) return alert(copy.errUnauthenticated);
  // Not the account check above: AdminGuard's, once another admin revoked this one's role.
  if (isApiError(error, 'FORBIDDEN')) return alert(copy.adminOnly);
  if (isApiError(error, 'APPROVAL_NOT_ALLOWED')) {
    const refusal = APPROVAL_REFUSALS.find((reason) => reason === validationMessage(error));
    return alert(
      refusal === undefined ? copy.errUnknown : JUDGEMENT_REFUSAL_MESSAGES[refusal],
      true,
    );
  }
  if (isApiError(error, 'NOT_FOUND')) return alert(copy.adminMarketNotFound, true);
  if (!isApiError(error, 'VALIDATION_ERROR')) {
    // A rule version moved under an approval is the API's INTERNAL (it cannot after the close).
    return alert(isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown);
  }
  const message = validationMessage(error);
  const path = validationPath(error) ?? [];
  const refused = MARKET_JUDGEMENT_REFUSALS;
  switch (validationField(error)) {
    case 'status': {
      const correction = message === refused.status.notProvisional;
      if (write === 'register') {
        return alert(
          correction ? copy.errMarketJudgementCorrectionStatus : copy.errMarketJudgementStatus,
          true,
        );
      }
      return alert(
        correction
          ? copy.errMarketJudgementCorrectionDecisionStatus
          : copy.errMarketJudgementDecisionStatus,
        true,
      );
    }
    case 'correction':
      if (path[1] === 'reason') {
        return field('correctionReason', copy.errMarketJudgementCorrectionReason);
      }
      if (message === refused.correction.unchanged) {
        return field('correction', copy.errMarketJudgementCorrectionUnchanged);
      }
      if (message === refused.correction.stale) {
        return alert(
          write === 'register'
            ? copy.errMarketJudgementCorrectionStale
            : copy.errMarketJudgementCorrectionDecisionStale,
          true,
        );
      }
      // A base version the body refused (not a version at all): the screen sent what it read.
      return alert(copy.errMarketInvalid, true);
    case 'judgement':
      return alert(copy.errMarketJudgementPending, true);
    case 'disputeWindow':
      return alert(copy.adminMarketJudgementWindowUndecided, true);
    case 'requestId':
      return alert(copy.errMarketJudgementUnknown, true);
    case 'result':
      return field(
        'result',
        message === refused.result.voidOnly
          ? copy.errMarketJudgementVoidOnly
          : copy.errMarketJudgementResult,
      );
    case 'source':
      // A priority the market has no source for: the rules on screen are not the market's.
      if (message === refused.source.unknown)
        return alert(copy.errMarketJudgementSourceUnknown, true);
      return field('source', copy.errMarketJudgementSource);
    case 'fallbackReason':
      return field(
        'fallbackReason',
        message === refused.fallbackReason.fallbackOnly
          ? copy.errMarketJudgementFallbackOnly
          : copy.errMarketJudgementFallbackReason,
      );
    case 'voidReason':
      return field(
        'voidReason',
        message === refused.voidReason.voidOnly
          ? copy.errMarketJudgementVoidReasonOnly
          : copy.errMarketJudgementVoidReason,
      );
    case 'evidence': {
      if (path[1] === 'collectedAt') {
        return field(
          'collectedAt',
          message === refused.evidence.collectedAfterNow
            ? copy.errMarketJudgementCollectedAtAfter
            : copy.errMarketJudgementCollectedAtTime,
        );
      }
      const index = path[1] === 'links' ? path[2] : undefined;
      if (typeof index !== 'number') return field('links', copy.errMarketJudgementLinks);
      return field(
        'links',
        message === refused.evidence.duplicateLink
          ? copy.errMarketJudgementLinkDuplicate
          : copy.errMarketJudgementLink,
        index,
      );
    }
    case 'description':
      return field('description', copy.errMarketJudgementDescription);
    case 'reason':
      return field('reason', copy.errMarketReviewReason);
    case 'eventDeadlineConfirmed':
      return field('eventDeadlineConfirmed', copy.errMarketJudgementDeadlineConfirm);
    default:
      return alert(copy.errMarketInvalid);
  }
}
