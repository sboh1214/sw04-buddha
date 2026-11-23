import {
  APPROVAL_REASON_MAX_LENGTH,
  APPROVAL_REFUSALS,
  type ApprovalRefusal,
  type ApprovalStatus,
  JUDGEMENT_EVIDENCE_LINKS_MAX,
  JUDGEMENT_EVIDENCE_LINK_MAX,
  JUDGEMENT_INCIDENT_STATUSES,
  MARKET_JUDGEMENT_INCIDENT_REFUSALS,
  MARKET_RESULTS,
  type MarketResult,
  type MarketStatus,
  STORABLE_INSTANT_MIN,
  duplicateLinkIndexes,
  judgementIncidentDecisionRefusal,
  judgementIncidentStatusRefusal,
} from '@buddha/shared';
import { copy } from '@/copy';
import {
  type AdminMarket,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
  validationPath,
} from './api';
import { kstLocalToIso } from './datetime';
import { MARKET_RESULT_LABEL, judgementVersionName } from './market-admin';
import { isHttpUrl } from './market-form';

/**
 * The pure half of the admin detail's 판정 오류 사건 (#144 part 1, ADR-0165; owner answers 144-3,
 * 144-4, 144-8, 144-13, 144-14, 144-19; ADR-0093 decision 1 #173 items 8·12·13·15; ADR-0120
 * decisions 5·6): whether the panel is drawn, why a registration is not taken now, who on screen
 * may decide the waiting incident and why not, what the registration form may send, what each
 * decision's dialog says and what a refusal says. The panel, its dialogs
 * (app/admin/markets/[id]/market-judgement-incident-*.tsx) and the 판정 오류 사건 검토 대기 queue draw
 * them. Admin-only: the public 판정 정정 is `Market.judgingRecord.correction`, an allowlist without
 * identities or the reviewer's reason (#173 item 13, ADR-0121).
 */

/**
 * Whether the admin detail draws the 판정 오류 사건 panel: from the result's confirmation on —
 * RESOLVED, SETTLING or SETTLED, where a registration is taken (144-8) — and on any market that
 * already has an incident (waiting, confirmed or in the log), so its record never goes away.
 */
export function showsJudgementIncidentPanel(
  market: Pick<AdminMarket, 'status' | 'judgementIncident'>,
): boolean {
  const { pending, confirmed, log } = market.judgementIncident;
  return (
    (JUDGEMENT_INCIDENT_STATUSES as readonly MarketStatus[]).includes(market.status) ||
    pending !== null ||
    confirmed !== null ||
    log.length > 0
  );
}

/**
 * Why the market takes no registration now (`AdminMarket.judgementIncident.registrable` false), in
 * the order the server refuses: the status (before 결과 확정, or 취소 — 144-8), a market judged
 * before #152 (`legacy`, D4), a confirmed incident (144-14: none is taken after it) or a waiting
 * one (one at a time). Null when it takes one.
 */
export type IncidentUnregistrable = 'status' | 'legacy' | 'confirmed' | 'pending';

export function incidentUnregistrable(
  market: Pick<AdminMarket, 'status' | 'judgementVersion' | 'judgementIncident'>,
): IncidentUnregistrable | null {
  if (judgementIncidentStatusRefusal(market.status, 'register') !== null) return 'status';
  if (market.judgementVersion === null) return 'legacy';
  if (market.judgementIncident.confirmed !== null) return 'confirmed';
  if (market.judgementIncident.pending !== null) return 'pending';
  return null;
}

const UNREGISTRABLE_NOTE: Readonly<Record<IncidentUnregistrable, string>> = {
  status: copy.adminMarketJudgementIncidentUnregistrableStatus,
  legacy: copy.adminMarketJudgementIncidentUnregistrableLegacy,
  confirmed: copy.adminMarketJudgementIncidentUnregistrableConfirmed,
  pending: copy.adminMarketJudgementIncidentUnregistrablePending,
};

/** What the panel says under its 사건 등록 while a registration is not taken. */
export function incidentUnregistrableNote(reason: IncidentUnregistrable): string {
  return UNREGISTRABLE_NOTE[reason];
}

/**
 * The paid judgement version's registrant (`AdminMarket.judgement.current.registeredBy`): the
 * paid version stays the current one (the market row never moves, ADR-0165 decision 2). Null on a
 * market with no current judgement, where no incident is registered.
 */
export function paidRegistrantOf(market: Pick<AdminMarket, 'judgement'>): string | null {
  return market.judgement.current?.registeredBy.id ?? null;
}

/** The two review decisions on the waiting incident (144-3). */
export type IncidentReview = 'confirm' | 'dismiss';

/**
 * Why the admin on screen may not press 오류 확인 or 기각 on the waiting incident, or null when
 * they may — the server refuses each again:
 * - `operator`: `GET /me` has not said who is on screen yet (ADR-0092);
 * - `own`: they registered it (#171, the approval engine's `requester`);
 * - `registrant`: they registered the paid judgement version (144-4,
 *   `judgementIncidentDecisionRefusal` — the service's own rule, `decider` 'registrant');
 * - `status`: a 오류 확인 before SETTLED (144-13 "지급이 끝난 뒤 확인할 수 있습니다"), or either
 *   decision outside RESOLVED·SETTLING·SETTLED.
 * A conflict on the market is #143's, which the dialog's confirmation and the server check.
 */
export type IncidentReviewUnavailable = 'operator' | 'own' | 'registrant' | 'status';

export function incidentReviewUnavailable(
  market: Pick<AdminMarket, 'status' | 'judgement' | 'judgementIncident'>,
  kind: IncidentReview,
  operatorId: string | undefined,
): IncidentReviewUnavailable | null {
  const pending = market.judgementIncident.pending;
  if (operatorId === undefined) return 'operator';
  if (pending !== null && pending.requestedBy.id === operatorId) return 'own';
  const paid = paidRegistrantOf(market);
  if (paid !== null && judgementIncidentDecisionRefusal(operatorId, paid) !== null) {
    return 'registrant';
  }
  if (kind === 'confirm' && !market.judgementIncident.confirmable) return 'status';
  if (judgementIncidentStatusRefusal(market.status, kind) !== null) return 'status';
  return null;
}

/** The results an incident may name: every result but the paid one (`correctedResult` 'same'). */
export function incidentResultChoices(paid: MarketResult | null): MarketResult[] {
  return MARKET_RESULTS.filter((result) => result !== paid);
}

/** How an incident registration ended, its badge in the 사건 기록 (`approval_requests.status`). */
export const INCIDENT_STATUS_LABEL: Readonly<Record<ApprovalStatus, string>> = {
  pending: copy.adminMarketJudgementIncidentStatusPending,
  approved: copy.adminMarketJudgementIncidentStatusApproved,
  rejected: copy.adminMarketJudgementIncidentStatusRejected,
  retracted: copy.adminMarketJudgementIncidentStatusRetracted,
};

/**
 * The admin detail's 결과 line: the paid result, and once an incident is confirmed '{paid} → 판정
 * 정정 {corrected}' (the market row keeps the paid result, ADR-0165 decision 2); '—' before one.
 */
export function adminResultText(
  market: Pick<AdminMarket, 'resolvedResult' | 'judgementIncident'>,
): string {
  if (market.resolvedResult === null) return '—';
  const paid = MARKET_RESULT_LABEL[market.resolvedResult];
  const confirmed = market.judgementIncident.confirmed;
  if (confirmed === null) return paid;
  return `${paid} → ${copy.adminMarketResultCorrected} ${MARKET_RESULT_LABEL[confirmed.correctedResult]}`;
}

/** The paid version and result an incident corrects, as the panel and its dialogs say it. */
export function incidentPaidText(version: number | null, result: MarketResult | null): string {
  const label = result === null ? '—' : MARKET_RESULT_LABEL[result];
  return version === null ? label : `${label} (${judgementVersionName(version)})`;
}

// ---- the registration --------------------------------------------------------------------------

/** 사건 등록 as its dialog holds it: every control's value as typed or picked ('' for none). */
export interface IncidentFormValues {
  /** '', or a result of MARKET_RESULTS. */
  correctedResult: string;
  description: string;
  /** One input per link, in order; the form keeps at least one. */
  links: readonly string[];
  /** The collection instant as a KST `datetime-local`. */
  collectedLocal: string;
}

export function incidentFormDefaults(): IncidentFormValues {
  return { correctedResult: '', description: '', links: [''], collectedLocal: '' };
}

/** What each field says is wrong with it, or null; `links` one per input. */
export interface IncidentFormErrors {
  correctedResult: string | null;
  description: string | null;
  links: (string | null)[];
  collectedAt: string | null;
}

/** The registration's fields without the confirmation and the admin it names (ADR-0092). */
export interface IncidentRegistration {
  correctedResult: MarketResult;
  description: string;
  evidence: { links: string[]; collectedAt: string };
}

/**
 * 사건 등록 as the dialog holds it (`registerJudgementIncidentBodySchema`'s rules, which the API
 * checks again): the correct result — YES, NO or VOID, never the paid one (`paid`, the server's
 * 'same result'); 오류 내용 1..500 trimmed; 1..JUDGEMENT_EVIDENCE_LINKS_MAX links, each trimmed,
 * http(s), at most JUDGEMENT_EVIDENCE_LINK_MAX characters and none twice (`duplicateLinkIndexes`);
 * the collection instant as a KST `datetime-local`, from STORABLE_INSTANT_MIN on and not after
 * `now` (the API refuses one after its clock, 'after now'; no lower bound). `registration` is
 * what is sent once every field holds.
 */
export function incidentDraft(
  values: IncidentFormValues,
  paid: MarketResult | null,
  now: number = Date.now(),
): { registration: IncidentRegistration | null; errors: IncidentFormErrors } {
  const result = MARKET_RESULTS.find((choice) => choice === values.correctedResult) ?? null;
  const resultError =
    result === null
      ? copy.errMarketJudgementIncidentResult
      : result === paid
        ? copy.errMarketJudgementIncidentSameResult
        : null;

  const description = values.description.trim();
  const descriptionOk = description.length >= 1 && description.length <= APPROVAL_REASON_MAX_LENGTH;

  const links = values.links.map((link) => link.trim());
  const repeated = new Set(duplicateLinkIndexes(links));
  const linkErrors = links.map((link, index) => {
    if (link.length > JUDGEMENT_EVIDENCE_LINK_MAX || !isHttpUrl(link)) {
      return copy.errMarketJudgementLink;
    }
    return repeated.has(index) ? copy.errMarketJudgementLinkDuplicate : null;
  });
  const linksCounted = links.length >= 1 && links.length <= JUDGEMENT_EVIDENCE_LINKS_MAX;

  const collectedAt = kstLocalToIso(values.collectedLocal);
  let collectedAtError: string | null = null;
  if (values.collectedLocal === '') collectedAtError = copy.errMarketJudgementCollectedAtRequired;
  else if (collectedAt === null || Date.parse(collectedAt) < Date.parse(STORABLE_INSTANT_MIN)) {
    collectedAtError = copy.errMarketJudgementCollectedAtTime;
  } else if (Date.parse(collectedAt) > now) {
    collectedAtError = copy.errMarketJudgementCollectedAtAfter;
  }

  const errors: IncidentFormErrors = {
    correctedResult: resultError,
    description: descriptionOk ? null : copy.errMarketJudgementIncidentDescription,
    links: linksCounted ? linkErrors : linkErrors.map(() => copy.errMarketJudgementLinks),
    collectedAt: collectedAtError,
  };
  const whole =
    errors.correctedResult === null &&
    errors.description === null &&
    linksCounted &&
    errors.links.every((error) => error === null) &&
    errors.collectedAt === null;
  return {
    registration:
      whole && result !== null && collectedAt !== null
        ? { correctedResult: result, description, evidence: { links, collectedAt } }
        : null,
    errors,
  };
}

// ---- the decisions ---------------------------------------------------------------------------

/** A decision on the waiting incident: its 오류 확인, its 기각, or its registrant's 철회. */
export type IncidentDecision = IncidentReview | 'retract';

/** What a decision's dialog is called, says, confirms with and toasts once it went through. */
export interface IncidentDecisionTexts {
  title: string;
  body: string;
  confirm: string;
  done: string;
}

export const INCIDENT_DECISION_TEXTS: Readonly<Record<IncidentDecision, IncidentDecisionTexts>> = {
  confirm: {
    title: copy.adminMarketJudgementIncidentConfirmTitle,
    body: copy.adminMarketJudgementIncidentConfirmBody,
    confirm: copy.adminMarketJudgementIncidentConfirm,
    done: copy.adminMarketJudgementIncidentConfirmDone,
  },
  dismiss: {
    title: copy.adminMarketJudgementIncidentDismissTitle,
    body: copy.adminMarketJudgementIncidentDismissBody,
    confirm: copy.adminMarketJudgementIncidentDismiss,
    done: copy.adminMarketJudgementIncidentDismissed,
  },
  retract: {
    title: copy.adminMarketJudgementIncidentRetractTitle,
    body: copy.adminMarketJudgementIncidentRetractBody,
    confirm: copy.adminMarketJudgementIncidentRetract,
    done: copy.adminMarketJudgementIncidentRetracted,
  },
};

// ---- what a refusal says ---------------------------------------------------------------------

/**
 * The approval engine's refusals as the incident says them: its registrant's in its own words, and
 * `no_decider` naming every admin a registration leaves out — the registrant, the paid version's
 * registrant (144-4) and the conflicted (#143) — not a conflict alone, as the judgement's says.
 */
const INCIDENT_APPROVAL_REFUSAL: Readonly<Record<ApprovalRefusal, string>> = {
  requester: copy.errMarketJudgementIncidentRequester,
  decided: copy.errApprovalDecided,
  retracted: copy.errApprovalRetracted,
  not_requester: copy.errApprovalNotRequester,
  creator: copy.errApprovalCreator,
  editor: copy.errApprovalEditor,
  no_decider: copy.errMarketJudgementIncidentNoDecider,
};

/** The fields a refusal can land under: the registration's and the decision's reason. */
export type IncidentField = 'correctedResult' | 'description' | 'links' | 'collectedAt' | 'reason';

/**
 * Where a refused incident write is said:
 * - `field`: under the input it is about — the result (none, or the paid one: 'same result'), the
 *   description, a link (`index`: not http(s), too long, given twice — or, without one, their
 *   count), the collection instant (unreadable, after the server's clock), a decision's reason;
 * - `alert`: in the dialog, which stays — the status (not 결과 확정 onwards; a 오류 확인 before
 *   지급 완료, 144-13), a legacy market, a confirmed incident (144-14) or another waiting, the
 *   paid version's registrant as the decider (144-4), an unknown request, the approval engine's
 *   refusals (the registrant, decided, retracted, no other admin to decide — `no_decider`), a
 *   conflict (#143) or a revoked role, the market gone, a session ended, a request that never
 *   reached the API or an internal error. `refresh` when the screen behind is out of date;
 * - `toast`: the cookie of another account (ADR-0092): nothing was done, the dialog closes.
 */
export type IncidentFailure =
  | { kind: 'field'; field: IncidentField; index?: number; message: string }
  | { kind: 'alert'; message: string; refresh: boolean }
  | { kind: 'toast'; message: string };

export function incidentFailure(error: unknown): IncidentFailure {
  const alert = (message: string, refresh = false): IncidentFailure => ({
    kind: 'alert',
    message,
    refresh,
  });
  const field = (name: IncidentField, message: string, index?: number): IncidentFailure =>
    index === undefined
      ? { kind: 'field', field: name, message }
      : { kind: 'field', field: name, index, message };
  if (isForAnotherAccount(error)) return { kind: 'toast', message: copy.sessionChanged };
  if (isApiError(error, 'UNAUTHENTICATED')) return alert(copy.errUnauthenticated);
  if (isApiError(error, 'FORBIDDEN')) {
    const conflict = validationMessage(error) === 'market_conflict';
    return alert(conflict ? copy.marketConflictRefused : copy.adminOnly, conflict);
  }
  if (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'noConflictConfirmed') {
    return alert(copy.marketConflictConfirmRequired);
  }
  if (isApiError(error, 'APPROVAL_NOT_ALLOWED')) {
    const refusal = APPROVAL_REFUSALS.find((reason) => reason === validationMessage(error));
    return alert(
      refusal === undefined ? copy.errUnknown : INCIDENT_APPROVAL_REFUSAL[refusal],
      true,
    );
  }
  if (isApiError(error, 'NOT_FOUND')) return alert(copy.adminMarketNotFound, true);
  if (!isApiError(error, 'VALIDATION_ERROR')) {
    return alert(isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown);
  }
  const message = validationMessage(error);
  const path = validationPath(error) ?? [];
  const refused = MARKET_JUDGEMENT_INCIDENT_REFUSALS;
  switch (validationField(error)) {
    case 'status':
      return alert(
        message === refused.status.notSettled
          ? copy.errMarketJudgementIncidentNotSettled
          : copy.errMarketJudgementIncidentStatus,
        true,
      );
    case 'judgement':
      return alert(copy.errMarketJudgementIncidentLegacy, true);
    case 'incident':
      return alert(
        message === refused.incident.confirmed
          ? copy.errMarketJudgementIncidentConfirmed
          : copy.errMarketJudgementIncidentPending,
        true,
      );
    case 'decider':
      return alert(copy.errMarketJudgementIncidentRegistrant, true);
    case 'requestId':
      return alert(copy.errMarketJudgementIncidentUnknown, true);
    case 'correctedResult':
      return field(
        'correctedResult',
        message === refused.correctedResult.sameResult
          ? copy.errMarketJudgementIncidentSameResult
          : copy.errMarketJudgementIncidentResult,
      );
    case 'description':
      return field('description', copy.errMarketJudgementIncidentDescription);
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
    case 'reason':
      return field('reason', copy.errMarketReviewReason);
    default:
      return alert(copy.errMarketInvalid);
  }
}
