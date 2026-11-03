import {
  JUDGEMENT_DELAY_REVIEW_MAX_MS,
  type JudgementDelayNextReviewRefusal,
  MARKET_JUDGEMENT_DELAY_REFUSALS,
  type MarketDisplayState,
  STORABLE_INSTANT_MIN,
  isLongDelayDeadlineReached,
  judgementDelayNextReviewRefusal,
  judgementDelayReviewPassed,
  judgementDelayStatusRefusal,
  longDelayDeadline,
} from '@buddha/shared';
import { copy } from '@/copy';
import { nicknameShown } from './account-closure';
import {
  type AdminJudgementDelay,
  type AdminMarket,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { instantWait, kstLocalToIso } from './datetime';
import { type EventRow } from './market-admin';
import { reviewReasonDraft } from './market-review';

/**
 * The pure half of the 판정 지연 기록 (#142, ADR-0106; ADR-0093 decision 1 #173 items 2·7·11·13,
 * decision 2 #172 item 14, decision 3 '#142 지연 사유', decision 4, and the owner's answers of
 * 2026-11-03 (1)–(4)) in the admin 판정 panel: whether the panel draws it and offers a record and
 * why not, the market's current record, whether its next review time is late, whether the
 * long-delay warning stands, the history's rows, what the record dialog may send and what a
 * refusal says. The panel's section and its dialog (app/admin/markets/[id]/market-judgement-delay-
 * *.tsx) draw them. Admin-only (excluded-features.test.ts): who recorded a delay and when are never
 * a member's (#173 item 13, decision 3) — the public detail reads `Market.judgementDelay`
 * (lib/market-detail.ts `shownJudgementDelay`). A record is one admin's alone (#173 item 2: no
 * approval, any admin, the registrant of a waiting judgement included), changes no status, no
 * result and no time of the market (#172 item 14), and is never edited or withdrawn (owner answer
 * (4)): a change is a new record. The episode words (`judgementDelayEpisodeText`) are
 * lib/market-admin.ts', which the 이벤트 로그 reads too.
 */

/**
 * Whether the 판정 panel draws its 판정 지연 기록 section: on a market CLOSED or PROVISIONAL — the two
 * that can read '판정 지연' (#173 items 11·12) — and on any that has a record, whose history stays
 * once the market moved on (a confirmed market's, read-only).
 */
export function showsJudgementDelays(
  market: Pick<AdminMarket, 'status' | 'judgementDelays'>,
): boolean {
  return (
    market.status === 'closed' ||
    market.status === 'provisional' ||
    market.judgementDelays.length > 0
  );
}

/**
 * The market as `isJudgementDelayed` reads it (@buddha/shared), from what the admin detail holds:
 * how many 판정 이의 hold it (`disputes.holding`) and whether a 판정 정정 waits — on a PROVISIONAL
 * market the waiting registration is one (#176, ADR-0105).
 */
export function judgementDelayDisplayState(
  market: Pick<
    AdminMarket,
    'status' | 'scheduledJudgementAt' | 'disputeDeadline' | 'disputes' | 'judgement'
  >,
): MarketDisplayState {
  return {
    status: market.status,
    scheduledJudgementAt: market.scheduledJudgementAt,
    disputeDeadline: market.disputeDeadline,
    disputeHoldCount: market.disputes.holding,
    correctionPending: market.status === 'provisional' && market.judgement.pending !== null,
  };
}

/**
 * Why 지연 기록 등록 is not offered at `now`, in the API's order (MARKET_JUDGEMENT_DELAY_REFUSALS
 * `status`, `judgementDelayStatusRefusal` — the server checks it again on its database clock):
 * - `status`: neither CLOSED nor PROVISIONAL — no button at all, the history alone;
 * - `unscheduled`: a CLOSED market with no scheduled judgement (opened before #22), which never
 *   reads '판정 지연';
 * - `early`: a CLOSED market before its scheduled judgement (#173 item 11: from it on, with no
 *   record needed);
 * - `unheld`: a PROVISIONAL market before its 이의 기한, or past it with nothing holding the
 *   confirmation (#173 item 7: a late review is the delay).
 * `null` when it is offered: the server's `judgementDelayed` at the read, or the market reads
 * '판정 지연' at `now` — the admin screens never render on the server, and a CLOSED market's
 * detail is not polled, so the section draws again at the instant (`judgementDelayStartsAt`). A
 * waiting judgement registration refuses nothing.
 */
export type JudgementDelayUnavailable = 'status' | 'unscheduled' | 'early' | 'unheld';

export function judgementDelayUnavailable(
  market: Pick<
    AdminMarket,
    | 'status'
    | 'judgementDelayed'
    | 'scheduledJudgementAt'
    | 'disputeDeadline'
    | 'disputes'
    | 'judgement'
  >,
  now: number,
): JudgementDelayUnavailable | null {
  if (market.status !== 'closed' && market.status !== 'provisional') return 'status';
  if (market.judgementDelayed) return null;
  if (judgementDelayStatusRefusal(judgementDelayDisplayState(market), now) === null) return null;
  if (market.status === 'provisional') return 'unheld';
  return market.scheduledJudgementAt === null ? 'unscheduled' : 'early';
}

/** What the section says under 지연 기록 등록, turned off (`judgementDelayUnavailable`). */
export const JUDGEMENT_DELAY_UNAVAILABLE_NOTE: Record<
  Exclude<JudgementDelayUnavailable, 'status'>,
  string
> = {
  unscheduled: copy.adminMarketJudgementDelayUnscheduled,
  early: copy.adminMarketJudgementDelayEarly,
  unheld: copy.adminMarketJudgementDelayUnheld,
};

/**
 * The instant the market starts to read '판정 지연' if nothing else changes — a CLOSED market's
 * scheduled judgement, a held PROVISIONAL one's 이의 기한 — or null (none, or nothing holds it).
 * The section waits for it to turn 지연 기록 등록 on by itself.
 */
export function judgementDelayStartsAt(
  market: Pick<
    AdminMarket,
    'status' | 'scheduledJudgementAt' | 'disputeDeadline' | 'disputes' | 'judgement'
  >,
): string | null {
  if (market.status === 'closed') return market.scheduledJudgementAt;
  if (market.status !== 'provisional') return null;
  const { disputeHoldCount, correctionPending } = judgementDelayDisplayState(market);
  return disputeHoldCount > 0 || correctionPending ? market.disputeDeadline : null;
}

/**
 * The market's current record (`AdminJudgementDelay.current`, the API's: the newest of the status
 * and judgement version the market has now), or null — before any, and once a judgement's
 * approval, a correction's approval or the confirmation made the records history.
 */
export function currentJudgementDelayRecord(
  market: Pick<AdminMarket, 'judgementDelays'>,
): AdminJudgementDelay | null {
  return market.judgementDelays.find((record) => record.current) ?? null;
}

/**
 * Whether the update is late at `now` (owner answer 2026-11-03 (2)): the market reads '판정 지연'
 * (`delayed`), it has a current record and that record's next review time has passed — the API's
 * `judgementDelay.nextReviewPassed` at the read, or `now`. The section warns then and marks the
 * record 갱신 대기, as the public detail does; nothing else follows (#173 item 11).
 */
export function judgementDelayLate(
  market: Pick<AdminMarket, 'judgementDelay'>,
  record: Pick<AdminJudgementDelay, 'nextReviewAt'> | null,
  delayed: boolean,
  now: number,
): boolean {
  if (!delayed || record === null) return false;
  if (
    market.judgementDelay?.nextReviewAt === record.nextReviewAt &&
    market.judgementDelay.nextReviewPassed
  ) {
    return true;
  }
  return judgementDelayReviewPassed(record.nextReviewAt, now);
}

/**
 * The 장기 지연 기한 the 판정 panel warns at (owner answer 2026-11-03 (3)): a CLOSED market's
 * `longDelayDeadline` (its scheduled judgement plus `longDelayDays` × 24 hours), or null — another
 * status (a PROVISIONAL market has a result), or either time not filled in.
 */
export function judgementLongDelayDeadline(
  market: Pick<AdminMarket, 'status' | 'scheduledJudgementAt' | 'longDelayDays'>,
): string | null {
  if (market.status !== 'closed') return null;
  return longDelayDeadline(market.scheduledJudgementAt, market.longDelayDays);
}

/**
 * Whether the long-delay warning stands at `now` (`isLongDelayDeadlineReached`): the panel tells
 * the admin to apply the rule's 지연·취소·무효 처리 through 판정 등록 — VOID too needs #152's
 * registration and another admin's approval; nothing happens by itself. Records and a waiting
 * registration change nothing of it.
 */
export function judgementLongDelayWarned(
  market: Pick<AdminMarket, 'status' | 'scheduledJudgementAt' | 'longDelayDays'>,
  now: number,
): boolean {
  return isLongDelayDeadlineReached(market, now);
}

/** How far past an instant the section draws again: a timer may fire a little early. */
const JUDGEMENT_DELAY_WAIT_MARGIN_MS = 1_000;

/**
 * How long from `now` until `at` has come — a scheduled judgement, a dispute deadline, a next
 * review time, a long-delay deadline — with a second's margin and at most a day (`instantWait`);
 * null once it has come (or for none). A CLOSED market's detail is not polled, so the section
 * waits this long and draws again by itself, as the waiting registration waits for the scheduled
 * judgement.
 */
export function judgementDelayInstantWait(at: string | null, now: number): number | null {
  return at === null ? null : instantWait(at, now, JUDGEMENT_DELAY_WAIT_MARGIN_MS);
}

/** Who recorded a delay: the nickname, or '탈퇴한 사용자' for an account closed since. */
export function judgementDelayActorName(actor: { nickname: string | null }): string {
  return nicknameShown(actor.nickname);
}

/**
 * One record of the 지연 기록 이력 as rows below its heading (the status it was made on, whether it
 * is the current one, who and when): the reason and the next review time. `time` renders an instant
 * (the admin's KST).
 */
export function judgementDelayRows(
  record: Pick<AdminJudgementDelay, 'reason' | 'nextReviewAt'>,
  time: (iso: string) => string,
): EventRow[] {
  return [
    { label: copy.adminMarketJudgementDelayReason, value: record.reason },
    { label: copy.adminMarketJudgementDelayNextReviewAt, value: time(record.nextReviewAt) },
  ];
}

// ---- what the record may send ----------------------------------------------------------------

/**
 * 지연 기록 등록 as the dialog holds it (`recordJudgementDelayBodySchema`): the reason typed — the
 * one public sentence, `approvalReasonSchema`'s 1..500 trimmed (decision 3: no classification) —
 * and the next review time as a KST `datetime-local` (ADR-0093 decision 3: entered in KST, sent in
 * UTC with seconds, `kstLocalToIso`):
 * - `nextReviewError`: what is said under the field as soon as it is wrong — an unreadable or
 *   unstorable date, a time not after `now`, or one more than JUDGEMENT_DELAY_REVIEW_MAX_DAYS × 24
 *   hours after it (`judgementDelayNextReviewRefusal`, owner answer (1), the server's own rule —
 *   it checks it again on its database clock at the record); a blank one says nothing, the
 *   confirm stays off;
 * - `reasonError`: the reason's, which the dialog says once something was sent or typed;
 * - `ready`: a reason and a good time.
 * `now` is read in render through the default, as `pauseDraft`'s is: the admin screens never render
 * on the server. Both bounds move with the clock, so the dialog draws again at the next edge
 * (`judgementDelayDraftWait`).
 */
export function judgementDelayDraft(
  reasonText: string,
  nextLocal: string,
  now: number = Date.now(),
): {
  ready: boolean;
  reason: string;
  nextReviewAt: string | null;
  reasonError: string | null;
  nextReviewError: string | null;
} {
  const reason = reviewReasonDraft(reasonText);
  const typed = kstLocalToIso(nextLocal);
  let nextReviewError: string | null = null;
  if (nextLocal !== '') {
    if (typed === null || Date.parse(typed) < Date.parse(STORABLE_INSTANT_MIN)) {
      nextReviewError = copy.errMarketJudgementDelayNextReviewTime;
    } else {
      const refusal = judgementDelayNextReviewRefusal(typed, now);
      if (refusal !== null) nextReviewError = NEXT_REVIEW_REFUSAL_MESSAGE[refusal];
    }
  }
  const nextReviewAt = nextReviewError === null ? typed : null;
  return {
    ready: reason.error === null && nextReviewAt !== null,
    reason: reason.reason,
    nextReviewAt,
    reasonError: reason.error === null ? null : copy.errMarketJudgementDelayReason,
    nextReviewError,
  };
}

/** The next review time's two bounds in the dialog's words, under the field. */
const NEXT_REVIEW_REFUSAL_MESSAGE: Readonly<Record<JudgementDelayNextReviewRefusal, string>> = {
  [MARKET_JUDGEMENT_DELAY_REFUSALS.nextReviewAt.notAfterNow]:
    copy.errMarketJudgementDelayNextReviewAfter,
  [MARKET_JUDGEMENT_DELAY_REFUSALS.nextReviewAt.tooFarAhead]:
    copy.errMarketJudgementDelayNextReviewTooFar,
};

/**
 * How long from `now` until the next review time typed (`nextLocal`) crosses its next bound — a
 * time within the bound becomes not after now at itself, a time too far ahead comes within it once
 * now is JUDGEMENT_DELAY_REVIEW_MAX_DAYS × 24 hours before it — with a second's margin and at most
 * a day; null for a time already not after now (it stays so), or an unreadable one. The dialog
 * waits this long and draws again, since `judgementDelayDraft` reads the clock only as it draws.
 */
export function judgementDelayDraftWait(nextLocal: string, now: number): number | null {
  const typed = kstLocalToIso(nextLocal);
  if (typed === null) return null;
  const at = Date.parse(typed);
  if (at <= now) return null;
  const edge =
    judgementDelayNextReviewRefusal(typed, now) === null ? at : at - JUDGEMENT_DELAY_REVIEW_MAX_MS;
  return instantWait(new Date(edge).toISOString(), now, JUDGEMENT_DELAY_WAIT_MARGIN_MS);
}

/**
 * What the record dialog opens with: the current record's reason, if any — a new record is the only
 * change there is (owner answer (4)), and the reason often stays while the time moves on — and no
 * next review time (it is always the admin's to set).
 */
export function judgementDelayDefaults(market: Pick<AdminMarket, 'judgementDelays'>): {
  reasonText: string;
  nextLocal: string;
} {
  return { reasonText: currentJudgementDelayRecord(market)?.reason ?? '', nextLocal: '' };
}

// ---- what a refusal says ---------------------------------------------------------------------

/** The fields of the record dialog a refusal can land under. */
export type JudgementDelayField = 'reason' | 'nextReviewAt';

/**
 * Where a refused record is said (#142):
 * - `field`: under the input it is about — the reason (missing or too long), the next review time
 *   (unreadable, not after now, more than JUDGEMENT_DELAY_REVIEW_MAX_DAYS days ahead — both bounds
 *   on the server's database clock at the record);
 * - `alert`: in the dialog, which stays — the market neither CLOSED nor PROVISIONAL
 *   (`notAwaitingJudgement`), or not reading '판정 지연' at the record (`notDelayed`: before its
 *   scheduled judgement, or a 잠정 결과 not held past its deadline — a judgement approved
 *   meanwhile), the market gone, a session ended or a role revoked, a request that never reached
 *   the API. `refresh` when the screen behind is out of date: the caller reads the detail again;
 * - `toast`: the cookie of another account (ADR-0092): nothing was recorded, the dialog closes and
 *   the session is asked again.
 * No APPROVAL_NOT_ALLOWED: a record is one admin's, with no approval (#173 item 2).
 */
export type JudgementDelayFailure =
  | { kind: 'field'; field: JudgementDelayField; message: string }
  | { kind: 'alert'; message: string; refresh: boolean }
  | { kind: 'toast'; message: string };

export function judgementDelayFailure(error: unknown): JudgementDelayFailure {
  const alert = (message: string, refresh = false): JudgementDelayFailure => ({
    kind: 'alert',
    message,
    refresh,
  });
  const field = (name: JudgementDelayField, message: string): JudgementDelayFailure => ({
    kind: 'field',
    field: name,
    message,
  });
  if (isForAnotherAccount(error)) return { kind: 'toast', message: copy.sessionChanged };
  if (isApiError(error, 'UNAUTHENTICATED')) return alert(copy.errUnauthenticated);
  // Not the account check above: AdminGuard's, once another admin revoked this one's role.
  if (isApiError(error, 'FORBIDDEN')) return alert(copy.adminOnly);
  if (isApiError(error, 'NOT_FOUND')) return alert(copy.adminMarketNotFound, true);
  if (!isApiError(error, 'VALIDATION_ERROR')) {
    return alert(isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown);
  }
  const message = validationMessage(error);
  const refused = MARKET_JUDGEMENT_DELAY_REFUSALS;
  switch (validationField(error)) {
    case 'status':
      return alert(
        message === refused.status.notAwaitingJudgement
          ? copy.errMarketJudgementDelayStatus
          : copy.errMarketJudgementDelayNotDelayed,
        true,
      );
    case 'nextReviewAt':
      switch (message) {
        case refused.nextReviewAt.notAfterNow:
          return field('nextReviewAt', copy.errMarketJudgementDelayNextReviewAfter);
        case refused.nextReviewAt.tooFarAhead:
          return field('nextReviewAt', copy.errMarketJudgementDelayNextReviewTooFar);
        default:
          // The body's own refusal: not a UTC instant from STORABLE_INSTANT_MIN on.
          return field('nextReviewAt', copy.errMarketJudgementDelayNextReviewTime);
      }
    case 'reason':
      return field('reason', copy.errMarketJudgementDelayReason);
    default:
      return alert(copy.errMarketInvalid);
  }
}
