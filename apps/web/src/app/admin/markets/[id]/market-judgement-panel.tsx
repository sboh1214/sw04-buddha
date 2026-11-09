'use client';

import { MARKET_CONFLICTS_KEY, useMarketConflicts } from '@/hooks/use-market-conflicts';
import { NoConflictConfirmation } from './market-conflict-panel';

import {
  Alert,
  Badge,
  Button,
  Card,
  Link as ChakraLink,
  Field,
  HStack,
  Input,
  RadioGroup,
  Stack,
  Text,
} from '@chakra-ui/react';
import {
  JUDGEMENT_EVIDENCE_LINKS_MAX,
  JUDGEMENT_EVIDENCE_LINK_MAX,
  MARKET_RESULTS,
} from '@buddha/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { OperatorFieldset } from '@/components/ui/operator-fieldset';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import {
  type AdminMarket,
  type AdminMarketJudgement,
  type JudgementSource,
  api,
  unwrap,
} from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  type EventRow,
  MARKET_RESULT_LABEL,
  PAUSE_REVIEW_RESULT_LABEL,
  judgementVersionMove,
  judgementVersionName,
} from '@/lib/market-admin';
import { isHttpUrl } from '@/lib/market-form';
import {
  JUDGEMENT_SOURCE_NONE,
  JUDGEMENT_STATUS_LABEL,
  type JudgementField,
  type JudgementFormErrors,
  type JudgementFormValues,
  type JudgementRegistration,
  collectedAtWait,
  isJudgementRegistrant,
  judgementActorName,
  judgementCorrectionBase,
  judgementCorrectionDefaults,
  judgementCurrentRows,
  judgementDraft,
  judgementEarly,
  judgementFailure,
  judgementFormDefaults,
  judgementFormUnavailableNote,
  judgementLogRows,
  judgementRuleVersionText,
  judgementSourceChoices,
  judgementSourceLabel,
  judgementSourceText,
  judgementUnapprovable,
  judgementUnapprovableNote,
  judgementUnavailable,
  marketJudgementVoidOnly,
  scheduledJudgementWait,
  showsJudgementPanel,
} from '@/lib/market-judgement';
import { MarketDisputes } from './market-dispute-panel';
import { JudgementLongDelay, MarketJudgementDelays } from './market-judgement-delay-panel';
import { type JudgementDialogKind, JudgementDialog } from './market-judgement-dialogs';
import { ReasonField } from './market-review-dialogs';

/**
 * What the panel opened: the registration form — a first judgement's (`register`) or a 판정 정정's
 * (`correct`, #176) — or one of the waiting registration's dialogs.
 */
export type JudgementAction = 'register' | 'correct' | JudgementDialogKind;

/** Whether the action is one of the registration form's: a first judgement's or a correction's. */
function isFormAction(action: JudgementAction | null): action is 'register' | 'correct' {
  return action === 'register' || action === 'correct';
}

/**
 * 판정 (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·4·5·9·11–13, decision 3 the #152 rows) and
 * its 판정 정정 (#176, ADR-0105), on a market CLOSED or PROVISIONAL and on any that has a judgement
 * or a registration (`showsJudgementPanel`): what it asks of the admin on screen
 * (`JudgementPanelBody`) and what it opened — the registration form (a first judgement's, or a
 * correction's from the panel's 판정 정정 or an accepted dispute's 정정 등록) or a dialog — held for
 * that admin (`useHeldForOperator`, ADR-0092 answer 1): once `['me']` turns from A to B in place,
 * it closes with what A picked and typed. The form is drawn again for each admin on screen and for
 * each of its two kinds (`key`), its fields off until that admin is known (`OperatorFieldset`).
 * Held, the form stays until the admin closes it, and focus comes back to the panel then — to
 * what opened it, an accepted dispute's 정정 등록 included — and after a decision went through
 * (`useJudgementRefocus`). While the form is open the disputes' 정정 등록 are hidden (`formOpen`):
 * they would open nothing more, and would name the form's own submit a second time. The dialogs
 * judge a correction's deadline at `readAt`. Its 판정 지연 기록 (#142, ADR-0106) is a section of its
 * own (`MarketJudgementDelays`), which holds its dialog for its admin the same way.
 */
export function MarketJudgementPanel({ market, readAt }: { market: AdminMarket; readAt: number }) {
  const operatorId = useOperatorId();
  const [action, setAction] = useHeldForOperator<JudgementAction>();
  const refocus = useJudgementRefocus(market, action);
  if (!showsJudgementPanel(market)) return null;
  const open = (next: JudgementAction) => {
    if (isFormAction(next)) refocus.opened();
    setAction(next);
  };
  const close = (sent: boolean) => {
    refocus.closed(sent || isFormAction(action), sent);
    setAction(null);
  };
  return (
    <>
      <JudgementPanelBody
        market={market}
        readAt={readAt}
        operatorId={operatorId}
        onOpen={open}
        registerForm={
          isFormAction(action) ? (
            <JudgementRegisterForm
              key={`${action}:${operatorId ?? ''}`}
              market={market}
              correct={action === 'correct'}
              onClose={close}
            />
          ) : null
        }
        disputes={
          <MarketDisputes
            market={market}
            formOpen={isFormAction(action)}
            onCorrect={() => open('correct')}
          />
        }
        delays={<MarketJudgementDelays market={market} readAt={readAt} />}
        targets={refocus.targets}
      />
      {action !== null && !isFormAction(action) && (
        <JudgementDialog kind={action} market={market} readAt={readAt} onClose={close} />
      )}
    </>
  );
}

/** The panel's elements focus comes back to (`useJudgementRefocus`). */
export interface JudgementFocusTargets {
  title: RefObject<HTMLParagraphElement | null>;
  register: RefObject<HTMLButtonElement | null>;
  current: RefObject<HTMLParagraphElement | null>;
  pending: RefObject<HTMLParagraphElement | null>;
}

/**
 * Focus once the form closes or a write went through (WCAG 2.4.3): the form takes focus as it
 * opens and a write takes away the button that opened its dialog (a registration its 판정 등록, a
 * decision the waiting registration's), so the next draw — of the market the write answered, after
 * a write — puts focus on the waiting registration's heading, else the current judgement's, else
 * 판정 등록 (or 판정 정정), else the panel's own. A form closed unsent puts it back on what had focus
 * as it opened (`opened`) while that is still drawn and on — an accepted dispute's 정정 등록, kept
 * drawn (hidden) while the form was open — else, in the same order, with 판정 등록 or 판정 정정
 * (drawn anew where the form was) before the current judgement's heading. Only when focus went
 * with the form or the dialog: an admin who has moved on keeps it where it is. A dialog closed
 * unsent hands focus back itself.
 */
function useJudgementRefocus(market: AdminMarket, action: JudgementAction | null) {
  const title = useRef<HTMLParagraphElement>(null);
  const register = useRef<HTMLButtonElement>(null);
  const current = useRef<HTMLParagraphElement>(null);
  const pending = useRef<HTMLParagraphElement>(null);
  const closed = useRef<{ sent: boolean; market: AdminMarket } | null>(null);
  // What had focus as the form opened: 판정 등록, 판정 정정 or an accepted dispute's 정정 등록.
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const from = closed.current;
    if (from === null || action !== null) return;
    if (from.sent && from.market === market) return;
    closed.current = null;
    const back = opener.current;
    opener.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    // 판정 등록 and 판정 정정 gave their place to the form, so `back` is no longer drawn for them: the
    // ref below finds the one drawn anew. A 정정 등록 whose row went, or that turned off, is passed
    // over the same way.
    if (
      !from.sent &&
      back instanceof HTMLElement &&
      back.isConnected &&
      !back.matches(':disabled')
    ) {
      back.focus();
      return;
    }
    // 판정 등록 is skipped while it is off (the dispute window 미정): a disabled button takes no focus.
    // On a PROVISIONAL market the same ref is 판정 정정's, which a form closed unsent goes back to
    // before the current judgement's heading.
    const registerOn = register.current?.disabled === false ? register.current : null;
    const unsent = from.sent ? null : registerOn;
    (pending.current ?? unsent ?? current.current ?? registerOn ?? title.current)?.focus();
  }, [action, market]);
  return {
    targets: { title, register, current, pending } satisfies JudgementFocusTargets,
    /** Marks a form opening: what has focus then is where a close unsent puts it back. */
    opened: () => {
      const active = document.activeElement;
      opener.current = active === document.body ? null : active;
    },
    /** Marks a close to refocus after (`track`): the form's, or a write that went through. */
    closed: (track: boolean, sent: boolean) => {
      if (track) closed.current = { sent, market };
    },
  };
}

/**
 * The panel as drawn for `operatorId` (undefined until `GET /me` answers), read at `readAt` (the
 * query's `dataUpdatedAt`, what 'before the scheduled judgement' is judged at):
 * - on a CLOSED market past its 장기 지연 기한, the warning to apply the rule's 지연·취소·무효 처리
 *   through 판정 등록 (`JudgementLongDelay`, #142, owner answer 2026-11-03 (3)) — nothing is
 *   automatic;
 * - while the dispute window is undecided on a CLOSED market, why nothing can be registered or
 *   approved, and where to decide it (`/admin/settings`);
 * - the waiting registration, in any status: what it says, who registered it and when; 승인 and 반려
 *   for any other admin (승인 only while it can be approved, `judgementUnapprovable`, with the note
 *   why not), off for its registrant with the note why, and 철회 for the registrant alone — and,
 *   before the scheduled judgement, the warning that the approver confirms the event deadline;
 * - 판정 등록 on a CLOSED market with none waiting (off while the window is undecided), and 판정 정정
 *   on a PROVISIONAL one with none waiting (`judgementCorrectionBase`, #176), which open the form
 *   in their place (`registerForm`); the form, once open, stays while it is held, whatever a
 *   refetch reads: it says itself why it cannot be sent now;
 * - the current judgement from its 잠정 결과 on — its version, what it says, who registered and
 *   approved it, the publication, the window, the dispute deadline and a correction's reason —
 *   read-only;
 * - its version's 판정 이의 (`disputes`, market-dispute-panel.tsx, #175): their 기각 and 수용, and an
 *   accepted one's 정정 등록 (#176);
 * - the 판정 지연 기록 (`delays`, market-judgement-delay-panel.tsx, #142, ADR-0106): the late-update
 *   warning, the current record, 지연 기록 등록 while the market reads '판정 지연' and the records'
 *   history;
 * - the 판정 버전 이력 (`judgement.history`, #176), newest first, once a correction replaced one;
 * - the 판정 기록, newest first.
 * No market price, volume or count is drawn (#152 AC 8). No button is live until the admin on
 * screen is known. `targets` are what focus comes back to (`useJudgementRefocus`).
 */
export function JudgementPanelBody({
  market,
  readAt,
  operatorId,
  onOpen,
  registerForm,
  disputes,
  delays,
  targets,
}: {
  market: AdminMarket;
  readAt: number;
  operatorId: string | undefined;
  onOpen: (action: JudgementAction) => void;
  registerForm: ReactNode;
  /** The current version's 판정 이의 (`MarketDisputes`, #175), after the current judgement. */
  disputes?: ReactNode;
  /** The 판정 지연 기록 (`MarketJudgementDelays`, #142), after the disputes. */
  delays?: ReactNode;
  targets?: JudgementFocusTargets;
}) {
  const unavailable = judgementUnavailable(market);
  const correctable = judgementCorrectionBase(market) !== null;
  const { current } = market.judgement;
  return (
    <Card.Root data-testid="market-judgement" data-status={market.status}>
      <Card.Header>
        <Stack gap="1">
          <Text
            ref={targets?.title}
            tabIndex={-1}
            fontWeight="semibold"
            data-testid="market-judgement-title"
          >
            {copy.adminMarketJudgement}
          </Text>
          <Text fontSize="sm" color="fg.muted">
            {copy.adminMarketJudgementIntro}
          </Text>
        </Stack>
      </Card.Header>
      <Card.Body>
        <Stack gap="5">
          <JudgementLongDelay market={market} readAt={readAt} />
          {market.status === 'closed' && market.judgement.disputeWindowUndecided && (
            <WindowUndecided testId="market-judgement-window-undecided" />
          )}
          <PendingJudgement
            market={market}
            readAt={readAt}
            operatorId={operatorId}
            onOpen={onOpen}
            headingRef={targets?.pending}
          />
          {/* The form held open stays, unavailable or not: it says why itself. */}
          {registerForm ??
            (correctable ? (
              <Button
                ref={targets?.register}
                size="sm"
                variant="outline"
                alignSelf="flex-start"
                disabled={operatorId === undefined}
                onClick={() => onOpen('correct')}
                data-testid="market-judgement-correct"
              >
                {copy.adminMarketJudgementCorrect}
              </Button>
            ) : (
              unavailable !== 'status' &&
              unavailable !== 'pending' && (
                <Button
                  ref={targets?.register}
                  size="sm"
                  alignSelf="flex-start"
                  disabled={operatorId === undefined || unavailable !== null}
                  onClick={() => onOpen('register')}
                  data-testid="market-judgement-register"
                >
                  {copy.adminMarketJudgementRegister}
                </Button>
              )
            ))}
          {current !== null && (
            <CurrentJudgement market={market} judgement={current} headingRef={targets?.current} />
          )}
          {disputes}
          {delays}
          <JudgementHistory market={market} />
          <JudgementLog market={market} />
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/** The dispute window undecided: nothing is registered or approved until it is decided. */
function WindowUndecided({ testId }: { testId: string }) {
  return (
    <Alert.Root status="warning" role="status" data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>
          {copy.adminMarketJudgementWindowUndecided} <SettingsLink testId={`${testId}-link`} />
        </Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

/** Where the dispute window is decided: 출시 설정 (`/admin/settings`, ADR-0055). */
function SettingsLink({ testId }: { testId: string }) {
  return (
    <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
      <NextLink href="/admin/settings" data-testid={testId}>
        {copy.adminMarketJudgementSettingsLink}
      </NextLink>
    </ChakraLink>
  );
}

/** Before the scheduled judgement: the warning, with that time in KST (decision 3 '등록 시점'). */
function EarlyWarning({
  scheduledJudgementAt,
  testId,
}: {
  scheduledJudgementAt: string;
  testId: string;
}) {
  return (
    <Alert.Root status="warning" role="status" data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>
          {copy.adminMarketJudgementEarly} {copy.adminMarketScheduledJudgementAt}{' '}
          <Text as="span" fontWeight="medium" data-testid={`${testId}-at`}>
            {formatKst(scheduledJudgementAt)}
          </Text>
        </Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

/** A heading inside the panel; one focus may come back to (`headingRef`) takes it from script. */
function PanelHeading({
  children,
  headingRef,
  testId,
}: {
  children: ReactNode;
  headingRef?: RefObject<HTMLParagraphElement | null>;
  testId?: string;
}) {
  return (
    <Text
      ref={headingRef}
      tabIndex={headingRef === undefined ? undefined : -1}
      fontWeight="medium"
      fontSize="sm"
      data-testid={testId}
    >
      {children}
    </Text>
  );
}

/** One labelled value of the panel's small print, its value under `testId`. */
function Line({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <Text as="div" fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
      <Text as="span" fontWeight="medium">
        {label}
      </Text>{' '}
      <Text as="span" data-testid={testId}>
        {children}
      </Text>
    </Text>
  );
}

/** Label/value rows in the panel's small print, one line each. */
function Rows({ rows, testId }: { rows: readonly EventRow[]; testId: string }) {
  return (
    <Stack gap="0" fontSize="sm" color="fg.muted" data-testid={testId}>
      {rows.map((row, index) => (
        <Text key={`${String(index)}:${row.label}`} whiteSpace="pre-wrap" wordBreak="break-word">
          <Text as="span" fontWeight="medium">
            {row.label}
          </Text>{' '}
          {row.value}
        </Text>
      ))}
    </Stack>
  );
}

/** The evidence links, each opened in a new tab when it is an http(s) address. */
function EvidenceLinks({ links, testId }: { links: readonly string[]; testId: string }) {
  return (
    <Stack as="ol" gap="0.5" listStyleType="decimal" ps="5" fontSize="sm" data-testid={testId}>
      {links.map((link, index) => (
        <li key={index}>
          {isHttpUrl(link) ? (
            <ChakraLink
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              colorPalette="brand"
              color="colorPalette.fg"
              wordBreak="break-all"
            >
              {link}
            </ChakraLink>
          ) : (
            <Text as="span" wordBreak="break-all">
              {link}
            </Text>
          )}
        </li>
      ))}
    </Stack>
  );
}

/**
 * What a registration says, one line each under `prefix`: the result, the source, the fallback
 * and VOID reasons where it has them, the evidence links, the collection instant, what was
 * confirmed and the rule version it follows.
 */
function RegistrationLines({
  registration,
  prefix,
}: {
  registration: {
    result: AdminMarketJudgement['result'];
    source: JudgementSource | null;
    fallbackReason: string | null;
    voidReason: string | null;
    evidence: { links: string[]; collectedAt: string };
    description: string;
    ruleVersion: number | null;
  };
  prefix: string;
}) {
  return (
    <Stack gap="1">
      <Line label={copy.adminMarketJudgementResult} testId={`${prefix}-result`}>
        {MARKET_RESULT_LABEL[registration.result]}
      </Line>
      <Line label={copy.adminMarketJudgementSource} testId={`${prefix}-source`}>
        {judgementSourceText(registration.source)}
      </Line>
      {registration.fallbackReason !== null && (
        <Line label={copy.adminMarketJudgementFallbackReason} testId={`${prefix}-fallback-reason`}>
          {registration.fallbackReason}
        </Line>
      )}
      {registration.voidReason !== null && (
        <Line label={copy.adminMarketJudgementVoidReason} testId={`${prefix}-void-reason`}>
          {registration.voidReason}
        </Line>
      )}
      <Stack gap="0.5">
        <Text fontSize="sm" fontWeight="medium">
          {copy.adminMarketJudgementLinks}
        </Text>
        <EvidenceLinks links={registration.evidence.links} testId={`${prefix}-links`} />
      </Stack>
      <Line label={copy.adminMarketJudgementCollectedAt} testId={`${prefix}-collected-at`}>
        {formatKst(registration.evidence.collectedAt)}
      </Line>
      <Line label={copy.adminMarketJudgementDescription} testId={`${prefix}-description`}>
        {registration.description}
      </Line>
      <Line label={copy.adminMarketJudgementRuleVersion} testId={`${prefix}-rule-version`}>
        {judgementRuleVersionText(registration.ruleVersion)}
      </Line>
    </Stack>
  );
}

/**
 * The waiting registration (`judgement.pending`), in any status, and what may be done with it:
 * the reviewer reads the result, the source, the evidence and what was confirmed before deciding
 * — never a market price (#152 AC 8). A correction (#176) says so in its heading and adds the
 * version it replaces and the one its approval makes ('v1 → v2') and its reason. 승인 is off with
 * the note why while it cannot be approved (`judgementUnapprovable`). The scheduled judgement's
 * warning is a first judgement's on a CLOSED market and a correction's on a PROVISIONAL one (its
 * approver confirms the event deadline as a first judgement's does, decision 3 '등록 시점').
 */
function PendingJudgement({
  market,
  readAt,
  operatorId,
  onOpen,
  headingRef,
}: {
  market: AdminMarket;
  readAt: number;
  operatorId: string | undefined;
  onOpen: (action: JudgementAction) => void;
  headingRef?: RefObject<HTMLParagraphElement | null>;
}) {
  // 'Before the scheduled judgement' as the row was read (`readAt`), or later: a CLOSED market's
  // detail is not polled, so it draws again once that time has come and judges it at the clock.
  const [clock, setClock] = useState(readAt);
  const { scheduledJudgementAt } = market;
  const correction = market.judgement.pending?.correction ?? null;
  const decidable =
    correction === null ? market.status === 'closed' : market.status === 'provisional';
  const early = decidable && judgementEarly({ scheduledJudgementAt }, Math.max(readAt, clock));
  useEffect(() => {
    if (!early) return;
    const wait = scheduledJudgementWait({ scheduledJudgementAt }, Date.now()) ?? 0;
    const timer = setTimeout(() => setClock(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [early, scheduledJudgementAt, clock]);
  const pending = market.judgement.pending;
  if (pending === null) return null;
  const requester = isJudgementRegistrant(pending, operatorId);
  const unapprovable = judgementUnapprovable(market);
  const approvable = unapprovable === null;
  const unapprovableNote =
    unapprovable === null ? null : judgementUnapprovableNote(unapprovable, correction !== null);
  return (
    <Stack
      gap="3"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid="market-judgement-pending"
      data-correction={correction !== null}
    >
      <PanelHeading headingRef={headingRef} testId="market-judgement-pending-title">
        {correction === null
          ? copy.adminMarketJudgementPending
          : copy.adminMarketJudgementPendingCorrection}
      </PanelHeading>
      {correction !== null && (
        <Stack gap="1">
          <Line
            label={copy.adminMarketJudgementCorrectionVersion}
            testId="market-judgement-pending-correction"
          >
            {judgementVersionMove(correction.baseVersion)}
          </Line>
          <Line
            label={copy.adminMarketJudgementCorrectionReason}
            testId="market-judgement-pending-correction-reason"
          >
            {correction.reason}
          </Line>
          {correction.disputeIds.length > 0 && (
            <CorrectionDisputes
              label={copy.adminMarketJudgementCorrectionDisputesRegistered}
              count={correction.disputeIds.length}
              testId="market-judgement-pending-disputes"
            />
          )}
        </Stack>
      )}
      <Text fontSize="sm">
        {copy.adminMarketJudgementRegisteredBy}{' '}
        <Text as="span" fontWeight="medium" data-testid="market-judgement-pending-by">
          {judgementActorName(pending.requestedBy)}
        </Text>{' '}
        · {copy.adminMarketJudgementRegisteredAt}{' '}
        <Text as="span" data-testid="market-judgement-pending-at">
          {formatKst(pending.requestedAt)}
        </Text>
      </Text>
      <RegistrationLines registration={pending} prefix="market-judgement-pending" />
      {early && market.scheduledJudgementAt !== null && (
        <EarlyWarning
          scheduledJudgementAt={market.scheduledJudgementAt}
          testId="market-judgement-pending-early"
        />
      )}
      {requester === true && (
        <Alert.Root status="warning" role="status" data-testid="market-judgement-requester-note">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminMarketJudgementExcludedRequester}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {unapprovableNote !== null && (
        <Alert.Root
          status="warning"
          role="status"
          data-testid="market-judgement-pending-status"
          data-reason={unapprovable}
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{unapprovableNote}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <HStack gap="2" flexWrap="wrap" data-testid="market-judgement-actions">
        <Button
          size="sm"
          disabled={operatorId === undefined || requester !== false || !approvable}
          onClick={() => onOpen('approve')}
          data-testid="market-judgement-approve"
        >
          {copy.adminMarketJudgementApprove}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={operatorId === undefined || requester !== false}
          onClick={() => onOpen('reject')}
          data-testid="market-judgement-reject"
        >
          {copy.adminMarketJudgementReject}
        </Button>
        {requester === true && (
          <Button
            size="sm"
            variant="outline"
            disabled={operatorId === undefined}
            onClick={() => onOpen('retract')}
            data-testid="market-judgement-retract"
          >
            {copy.adminMarketJudgementRetract}
          </Button>
        )}
      </HStack>
    </Stack>
  );
}

/**
 * The current judgement (`judgement.current`, from its 잠정 결과 on): its version, what it says, who
 * registered and who approved it, when its 잠정 결과 was published, the dispute window read then and
 * the deadline it fixed (#173 item 5) — and, while PROVISIONAL, that the result is confirmed by
 * itself once that deadline passes with no 판정 이의 holding it (the block below says how many do,
 * #175). Read-only in every status.
 */
function CurrentJudgement({
  market,
  judgement,
  headingRef,
}: {
  market: AdminMarket;
  judgement: AdminMarketJudgement;
  headingRef?: RefObject<HTMLParagraphElement | null>;
}) {
  return (
    <Stack gap="3" borderWidth="1px" borderRadius="l2" p="3" data-testid="market-judgement-current">
      <HStack gap="2" flexWrap="wrap" align="baseline">
        <PanelHeading headingRef={headingRef} testId="market-judgement-current-title">
          {copy.adminMarketJudgementCurrent}
        </PanelHeading>
        <Badge variant="subtle" data-testid="market-judgement-current-badge">
          {MARKET_RESULT_LABEL[judgement.result]}
        </Badge>
      </HStack>
      {market.status === 'provisional' && (
        <Text fontSize="sm" data-testid="market-judgement-current-deadline-note">
          {copy.adminMarketJudgementDeadline}{' '}
          <Text as="span" fontWeight="medium" data-testid="market-judgement-current-deadline">
            {formatKst(judgement.disputeDeadline)}
          </Text>{' '}
          · {copy.adminMarketJudgementProvisionalNote}
        </Text>
      )}
      <RegistrationLines registration={judgement} prefix="market-judgement-current" />
      <Rows
        rows={judgementCurrentRows(judgement, formatKst)}
        testId="market-judgement-current-rows"
      />
    </Stack>
  );
}

/**
 * The accepted disputes a correction answers (#176) — '이 정정과 함께 등록되는 수용한 판정 이의 2건'
 * in the form, '… 등록된 …' once it waits (`label`) — and on its own line that they go back to 검토
 * 중 if it is rejected or retracted.
 */
function CorrectionDisputes({
  label,
  count,
  testId,
}: {
  label: string;
  count: number;
  testId: string;
}) {
  return (
    <Stack gap="0" fontSize="sm" data-testid={testId}>
      <Text fontWeight="medium">
        {`${label} ${count.toLocaleString('ko-KR')}${copy.adminMarketDisputesHoldingUnit}`}
      </Text>
      <Text color="fg.muted">{copy.adminMarketJudgementCorrectionDisputesNote}</Text>
    </Stack>
  );
}

/**
 * 판정 버전 이력 (`judgement.history`, #176, ADR-0105; #173 item 13 — kept, never wiped or
 * rewritten): every version a correction replaced, newest first, each as the current one reads —
 * what it says (the result, the source, the evidence, the collection instant), its version, who
 * registered and approved it, its publication, its window and deadline, and its correction
 * reason when a correction made it. Not drawn before a first correction. `market-judgement-history-
 * <n>` counts from the newest and carries the version in `data-version`.
 */
function JudgementHistory({ market }: { market: AdminMarket }) {
  const { history } = market.judgement;
  if (history.length === 0) return null;
  return (
    <Stack gap="2" data-testid="market-judgement-history">
      <PanelHeading testId="market-judgement-history-title">
        {copy.adminMarketJudgementHistory}
      </PanelHeading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminMarketJudgementHistoryIntro}
      </Text>
      <Stack gap="3">
        {history.map((version, index) => {
          const at = `market-judgement-history-${String(index)}`;
          return (
            <Stack
              key={version.version}
              gap="2"
              borderWidth="1px"
              borderRadius="l2"
              p="3"
              data-testid={at}
              data-version={version.version}
            >
              <HStack gap="2" flexWrap="wrap" align="baseline">
                <Text fontSize="sm" fontWeight="medium" data-testid={`${at}-version`}>
                  {copy.adminMarketJudgementVersion} {judgementVersionName(version.version)}
                </Text>
                <Badge variant="subtle" data-testid={`${at}-badge`}>
                  {MARKET_RESULT_LABEL[version.result]}
                </Badge>
              </HStack>
              <RegistrationLines registration={version} prefix={at} />
              {/* The heading names the version: its rows leave it out. */}
              <Rows
                rows={judgementCurrentRows(version, formatKst).filter(
                  (row) => row.label !== copy.adminMarketJudgementVersion,
                )}
                testId={`${at}-rows`}
              />
            </Stack>
          );
        })}
      </Stack>
    </Stack>
  );
}

/**
 * 판정 기록 (`judgement.log`, newest first, the waiting registration included): each its status,
 * who registered it (by nickname) and when in KST, then its rows (`judgementLogRows`).
 * `market-judgement-log-<n>` counts from the newest and carries the status in `data-status`.
 */
function JudgementLog({ market }: { market: AdminMarket }) {
  const { log } = market.judgement;
  return (
    <Stack gap="2" data-testid="market-judgement-log">
      <PanelHeading>{copy.adminMarketJudgementLog}</PanelHeading>
      {log.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" data-testid="market-judgement-log-empty">
          {copy.adminMarketJudgementLogEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {log.map((entry, index) => {
            const at = `market-judgement-log-${String(index)}`;
            return (
              <Stack key={entry.requestId} gap="0.5" data-testid={at} data-status={entry.status}>
                <HStack gap="2" flexWrap="wrap">
                  <Badge variant="subtle" data-testid={`${at}-status`}>
                    {JUDGEMENT_STATUS_LABEL[entry.status]}
                  </Badge>
                  <Text fontSize="sm" fontWeight="medium" data-testid={`${at}-by`}>
                    {judgementActorName(entry.requestedBy)}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    {formatKst(entry.requestedAt)}
                  </Text>
                </HStack>
                <Rows rows={judgementLogRows(entry, formatKst)} testId={`${at}-rows`} />
              </Stack>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

/** What a registration sends, taken from the form when it is submitted; `by` is the admin. */
interface RegisterVariables {
  registration: JudgementRegistration;
  by: string;
}

/** A refusal of the server's under one field, a link's by its index. */
interface FieldRefusal {
  field: JudgementField;
  index?: number;
  message: string;
}

/**
 * 판정 등록's form (#152; decision 3 the #152 rows), in the panel: the result (YES, NO or 무효), the
 * source picked from the rule's (`judgementSourceChoices`, with name and address) or — for 무효
 * alone — none, the reason the primary could not be used once a 대체 출처 is picked, the VOID reason
 * once 무효 is, 1..5 evidence links, the collection instant (KST, not after now — drawn again as
 * the minute typed comes, `collectedAtWait`) and what was confirmed. No market price, volume or
 * count is drawn (#152 AC 8). It warns before the scheduled judgement (with the time) and, on a
 * market closed early as 판정 불가, preselects 무효, turns YES and NO off and says why with the
 * pause's review. Each field is checked as the API checks it (`judgementDraft`), what it lacks said
 * once the form was sent once; a refusal lands under its input or above the buttons
 * (`judgementFailure`). Once the market read takes no registration (`judgementUnavailable`:
 * another waiting, not CLOSED, the dispute window undecided) the form stays with what was typed,
 * says why and sends nothing, until the admin closes it. Sent, it closes and the market with its
 * waiting registration goes on screen (`useApplyMarket`). Focus moves to its heading as it opens;
 * `onClose` says whether it was sent.
 *
 * With `correct` it is 판정 정정's (#176, ADR-0105; #173 items 2·5·7·8): opened on the current
 * judgement as the form first drew (`base`, kept — another correction approved meanwhile makes it
 * `stale`), prefilled with it (`judgementCorrectionDefaults`), it says the move it would make
 * ('v1 → v2') and how many of that version's accepted disputes it answers (the server registers
 * every one of them with it), asks a 정정 사유 and refuses — as the API does — a correction that
 * changes neither the result nor its grounds. It reads no dispute window: the approval gives the
 * first deadline's length again. Its registration is sent with `correction` set; a first
 * judgement's with `correction: null`.
 */
export function JudgementRegisterForm({
  market,
  correct = false,
  onClose,
}: {
  market: AdminMarket;
  correct?: boolean;
  onClose: (sent: boolean) => void;
}) {
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  // The admin on screen, whom the registration names (ADR-0092): it waits for `GET /me`.
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
  const voidOnly = marketJudgementVoidOnly(market);
  // The version a correction replaces, as the form opened: what it prefills and sends.
  const [base] = useState(() => (correct ? market.judgement.current : null));
  const [values, setValues] = useState<JudgementFormValues>(() =>
    base === null ? judgementFormDefaults(voidOnly) : judgementCorrectionDefaults(base),
  );
  const set = (patch: Partial<JudgementFormValues>) => setValues((held) => ({ ...held, ...patch }));
  const [tried, setTried] = useState(false);
  const [noConflict, setNoConflict] = useState(false);
  const conflicts = useMarketConflicts(market.id);
  const conflictBlocked = conflicts.data?.operator.conflicted === true;
  const [fieldError, setFieldError] = useState<FieldRefusal | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [sentLocal, setSentLocal] = useState<string | null>(null);
  // The clock is the draft's own default, read in render as `pauseDraft`'s is.
  const draft = judgementDraft(values, voidOnly, undefined, base);
  // A correction opened with no current judgement (none can: PROVISIONAL has one) takes none.
  const unavailable = !correct
    ? judgementUnavailable(market)
    : base === null
      ? 'status'
      : judgementUnavailable(market, base.version);
  const early = judgementEarly(market);
  // The base version's accepted disputes, which the server registers with the correction.
  const answered =
    base === null
      ? 0
      : market.disputes.items.filter(
          (dispute) => dispute.status === 'accepted' && dispute.judgementVersion === base.version,
        ).length;
  // `judgementDraft` reads the clock as the form draws: while 'after now' is said, draw again once
  // the minute typed has come, so the sentence goes by itself (as the pause dialog's instant).
  const [drawn, setDrawn] = useState(0);
  const afterNow = draft.errors.collectedAt === copy.errMarketJudgementCollectedAtAfter;
  useEffect(() => {
    if (!afterNow) return;
    const wait = collectedAtWait(values.collectedLocal, Date.now()) ?? 0;
    const timer = setTimeout(() => setDrawn((count) => count + 1), wait);
    return () => clearTimeout(timer);
  }, [afterNow, values.collectedLocal, drawn]);
  // Opened from 판정 등록: focus goes into the form, at its heading.
  const title = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);

  const register = useMutation({
    mutationFn: async ({ registration, by }: RegisterVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/judgements', {
          params: { path: { id: market.id } },
          body: { ...registration, expectedAccountId: by, noConflictConfirmed: true },
        }),
      ).data,
    onMutate: () => {
      setFieldError(null);
      setRefusal(null);
    },
    onSuccess: async (fresh) => {
      toaster.create({
        type: 'success',
        title: correct
          ? copy.adminMarketJudgementCorrectionRegistered
          : copy.adminMarketJudgementRegistered,
      });
      onClose(true);
      await apply(fresh);
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = judgementFailure(error, 'register');
      if (failure.kind === 'toast') {
        // Another account's cookie: the page drops this form once the session names the admin
        // really signed in, so the refusal is a toast that outlives it.
        toaster.create({ type: 'error', title: failure.message });
        onClose(false);
        return;
      }
      if (failure.kind === 'field') {
        setFieldError({ field: failure.field, index: failure.index, message: failure.message });
        return;
      }
      setRefusal(failure.message);
      if (failure.refresh) {
        void queryClient.invalidateQueries({ queryKey: [...MARKET_CONFLICTS_KEY, market.id] });
        void queryClient.invalidateQueries({ queryKey: adminMarketKey(market.id) });
      }
    },
  });

  const submit = () => {
    setTried(true);
    setRefusal(null);
    if (
      !noConflict ||
      conflictBlocked ||
      operatorId === undefined ||
      unavailable !== null ||
      draft.registration === null
    )
      return;
    setSentLocal(values.collectedLocal);
    register.mutate({ registration: draft.registration, by: operatorId });
  };
  const errorOf = (field: Exclude<keyof JudgementFormErrors, 'links'>) => {
    if (fieldError?.field === field) {
      // The server's refusal of the instant holds while the field holds what was sent.
      if (field !== 'collectedAt' || sentLocal === values.collectedLocal) return fieldError.message;
    }
    const drafted = draft.errors[field];
    // The instant's 'after now' is said at once, as the pause dialog's (what it typed is wrong).
    if (field === 'collectedAt' && drafted === copy.errMarketJudgementCollectedAtAfter) {
      return drafted;
    }
    return tried ? drafted : null;
  };
  const linkErrorOf = (index: number) => {
    if (fieldError?.field === 'links' && fieldError.index === index) return fieldError.message;
    return tried ? (draft.errors.links[index] ?? null) : null;
  };
  const linksError =
    fieldError?.field === 'links' && fieldError.index === undefined ? fieldError.message : null;
  const unchanged = errorOf('correction');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
      data-testid="market-judgement-form"
      data-correction={correct}
    >
      <OperatorFieldset disabled={operatorId === undefined}>
        <Stack gap="4" borderWidth="1px" borderRadius="l2" p="3">
          <Stack gap="1">
            <Text
              ref={title}
              tabIndex={-1}
              fontWeight="medium"
              data-testid="market-judgement-form-title"
            >
              {correct
                ? copy.adminMarketJudgementCorrectionFormTitle
                : copy.adminMarketJudgementFormTitle}
            </Text>
            <Text fontSize="sm" color="fg.muted">
              {correct
                ? copy.adminMarketJudgementCorrectionFormHint
                : copy.adminMarketJudgementFormHint}
            </Text>
          </Stack>
          {base !== null && (
            <Stack gap="1">
              <Line
                label={copy.adminMarketJudgementCorrectionVersion}
                testId="market-judgement-form-correction"
              >
                {judgementVersionMove(base.version)}
              </Line>
              {answered > 0 && (
                <CorrectionDisputes
                  label={copy.adminMarketJudgementCorrectionDisputes}
                  count={answered}
                  testId="market-judgement-form-disputes"
                />
              )}
            </Stack>
          )}
          {early && market.scheduledJudgementAt !== null && (
            <EarlyWarning
              scheduledJudgementAt={market.scheduledJudgementAt}
              testId="market-judgement-form-early"
            />
          )}
          {voidOnly && <VoidOnlyNote market={market} />}
          {unavailable !== null && (
            <Alert.Root
              status="warning"
              role="status"
              data-testid="market-judgement-form-unavailable"
              data-reason={unavailable}
            >
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>
                  {judgementFormUnavailableNote(unavailable, correct)}
                  {unavailable === 'undecided' && (
                    <>
                      {' '}
                      <SettingsLink testId="market-judgement-form-settings-link" />
                    </>
                  )}
                </Alert.Description>
              </Alert.Content>
            </Alert.Root>
          )}
          <JudgementFields
            market={market}
            values={values}
            onValues={set}
            voidOnly={voidOnly}
            needsFallbackReason={draft.needsFallbackReason}
            needsVoidReason={draft.needsVoidReason}
            errorOf={errorOf}
            linkErrorOf={linkErrorOf}
            linksError={linksError}
            disabled={register.isPending}
          />
          {correct && (
            <ReasonField
              testId="market-judgement-correction-reason"
              label={copy.adminMarketJudgementCorrectionReason}
              hint={copy.adminMarketJudgementCorrectionReasonHint}
              value={values.correctionReason}
              onChange={(correctionReason) => set({ correctionReason })}
              error={errorOf('correctionReason')}
              disabled={register.isPending}
            />
          )}
          {unchanged !== null && (
            <Text
              fontSize="sm"
              color="fg.error"
              role="alert"
              data-testid="market-judgement-unchanged"
            >
              {unchanged}
            </Text>
          )}
          {refusal !== null && (
            <Alert.Root status="error" role="alert" data-testid="market-judgement-form-refusal">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{refusal}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
          )}
          <NoConflictConfirmation
            blocked={conflictBlocked}
            checked={noConflict}
            onChecked={setNoConflict}
            disabled={register.isPending}
            testId="market-judgement-confirm-conflict"
          />
          <HStack gap="2" flexWrap="wrap">
            <Button
              type="submit"
              size="sm"
              loading={register.isPending}
              disabled={
                !noConflict || conflictBlocked || operatorId === undefined || unavailable !== null
              }
              data-testid="market-judgement-submit"
            >
              {correct
                ? copy.adminMarketJudgementCorrectionRegister
                : copy.adminMarketJudgementRegister}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={register.isPending}
              onClick={() => onClose(false)}
              data-testid="market-judgement-cancel"
            >
              {copy.cancel}
            </Button>
          </HStack>
        </Stack>
      </OperatorFieldset>
    </form>
  );
}

/** A market closed early as 판정 불가: 무효 alone, why, and the pause review that said so. */
function VoidOnlyNote({ market }: { market: AdminMarket }) {
  const review = market.pause.history[0]?.reviewResult ?? null;
  return (
    <Alert.Root status="info" role="status" data-testid="market-judgement-form-void-only">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>
          {copy.adminMarketJudgementVoidOnly}
          {review !== null && (
            <Text as="span" display="block">
              {copy.adminMarketJudgementVoidOnlyReview} {PAUSE_REVIEW_RESULT_LABEL[review]}
            </Text>
          )}
        </Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

/**
 * 판정 등록's fields, drawn from what the form holds: the result radio (YES·NO off on a market that
 * takes 무효 alone), the source radio — the rule's sources with name and address, and 규칙의 출처
 * 없음 while 무효 is picked (picking YES or NO again drops it) — the fallback reason while a 대체 출처
 * is picked, the VOID reason while 무효 is, the evidence links (add up to
 * JUDGEMENT_EVIDENCE_LINKS_MAX, take one out down to one), the collection instant as a KST
 * `datetime-local` and the description. Each radio's test id is on its label element, so a click
 * on it is the click that picks. No market price, volume or count (#152 AC 8).
 */
export function JudgementFields({
  market,
  values,
  onValues,
  voidOnly,
  needsFallbackReason,
  needsVoidReason,
  errorOf,
  linkErrorOf,
  linksError,
  disabled,
}: {
  market: AdminMarket;
  values: JudgementFormValues;
  onValues: (patch: Partial<JudgementFormValues>) => void;
  voidOnly: boolean;
  needsFallbackReason: boolean;
  needsVoidReason: boolean;
  errorOf: (field: Exclude<keyof JudgementFormErrors, 'links'>) => string | null;
  linkErrorOf: (index: number) => string | null;
  linksError: string | null;
  disabled: boolean;
}) {
  const choices = judgementSourceChoices(market);
  const resultError = errorOf('result');
  const sourceError = errorOf('source');
  return (
    <Stack gap="4">
      <Field.Root invalid={resultError !== null} required>
        {/* The group's accessible name is its own Label part: zag emits `role="radiogroup"` with
            `aria-labelledby` pointing at that id, so a `Field.Label` here would leave the group
            unnamed. */}
        <RadioGroup.Root
          name="judgement-result"
          value={values.result === '' ? null : values.result}
          onValueChange={(details) => {
            const result = details.value ?? '';
            onValues(
              result !== 'VOID' && values.source === JUDGEMENT_SOURCE_NONE
                ? { result, source: '' }
                : { result },
            );
          }}
          disabled={disabled}
          colorPalette="brand"
        >
          <RadioGroup.Label fontWeight="medium" mb="1">
            {copy.adminMarketJudgementResult}
          </RadioGroup.Label>
          <HStack gap="6" flexWrap="wrap">
            {MARKET_RESULTS.map((result) => (
              <RadioGroup.Item
                key={result}
                value={result}
                disabled={voidOnly && result !== 'VOID'}
                data-testid={`market-judgement-result-${result.toLowerCase()}`}
              >
                <RadioGroup.ItemHiddenInput />
                <RadioGroup.ItemIndicator />
                <RadioGroup.ItemText>{MARKET_RESULT_LABEL[result]}</RadioGroup.ItemText>
              </RadioGroup.Item>
            ))}
          </HStack>
        </RadioGroup.Root>
        <Field.ErrorText data-testid="market-judgement-result-error">{resultError}</Field.ErrorText>
      </Field.Root>
      <Field.Root invalid={sourceError !== null} required>
        <RadioGroup.Root
          name="judgement-source"
          value={values.source === '' ? null : values.source}
          onValueChange={(details) => onValues({ source: details.value ?? '' })}
          disabled={disabled}
          colorPalette="brand"
        >
          <RadioGroup.Label fontWeight="medium" mb="1">
            {copy.adminMarketJudgementSource}
          </RadioGroup.Label>
          <Text fontSize="sm" color="fg.muted" mb="2">
            {copy.adminMarketJudgementSourceHint}
          </Text>
          {choices.length === 0 && (
            <Text fontSize="sm" color="fg.muted" mb="2" data-testid="market-judgement-no-sources">
              {copy.adminMarketJudgementNoSources}
            </Text>
          )}
          <Stack gap="3">
            {choices.map(({ priority, source }) => (
              <RadioGroup.Item
                key={priority}
                value={String(priority)}
                alignItems="flex-start"
                data-testid={`market-judgement-source-${String(priority)}`}
              >
                <RadioGroup.ItemHiddenInput />
                <RadioGroup.ItemIndicator mt="0.5" />
                <Stack gap="0">
                  <RadioGroup.ItemText>
                    {judgementSourceLabel(priority)} · {source.name.trim() || '—'}
                  </RadioGroup.ItemText>
                  <Text fontSize="xs" color="fg.muted" fontFamily="mono" wordBreak="break-all">
                    {source.url}
                  </Text>
                </Stack>
              </RadioGroup.Item>
            ))}
            {values.result === 'VOID' && (
              <RadioGroup.Item
                value={JUDGEMENT_SOURCE_NONE}
                alignItems="flex-start"
                data-testid="market-judgement-source-none"
              >
                <RadioGroup.ItemHiddenInput />
                <RadioGroup.ItemIndicator mt="0.5" />
                <Stack gap="0">
                  <RadioGroup.ItemText>{copy.adminMarketJudgementSourceNone}</RadioGroup.ItemText>
                  <Text fontSize="sm" color="fg.muted">
                    {copy.adminMarketJudgementSourceNoneHint}
                  </Text>
                </Stack>
              </RadioGroup.Item>
            )}
          </Stack>
        </RadioGroup.Root>
        <Field.ErrorText data-testid="market-judgement-source-error">{sourceError}</Field.ErrorText>
      </Field.Root>
      {needsFallbackReason && (
        <ReasonField
          testId="market-judgement-fallback-reason"
          label={copy.adminMarketJudgementFallbackReason}
          hint={copy.adminMarketJudgementFallbackReasonHint}
          value={values.fallbackReason}
          onChange={(fallbackReason) => onValues({ fallbackReason })}
          error={errorOf('fallbackReason')}
          disabled={disabled}
        />
      )}
      {needsVoidReason && (
        <ReasonField
          testId="market-judgement-void-reason"
          label={copy.adminMarketJudgementVoidReason}
          hint={copy.adminMarketJudgementVoidReasonHint}
          value={values.voidReason}
          onChange={(voidReason) => onValues({ voidReason })}
          error={errorOf('voidReason')}
          disabled={disabled}
        />
      )}
      <Stack gap="2" data-testid="market-judgement-links">
        <Text fontWeight="medium">{copy.adminMarketJudgementLinks}</Text>
        <Text fontSize="sm" color="fg.muted">
          {copy.adminMarketJudgementLinksHint}
        </Text>
        {values.links.map((link, index) => {
          const error = linkErrorOf(index);
          const at = `market-judgement-link-${String(index)}`;
          return (
            <Field.Root key={index} invalid={error !== null} required>
              <HStack gap="2" width="full">
                <Input
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder={copy.adminMarketSourceUrlPlaceholder}
                  maxLength={JUDGEMENT_EVIDENCE_LINK_MAX}
                  aria-label={`${copy.adminMarketJudgementLinks} ${String(index + 1)}`}
                  value={link}
                  onChange={(event) =>
                    onValues({
                      links: values.links.map((other, position) =>
                        position === index ? event.target.value : other,
                      ),
                    })
                  }
                  disabled={disabled}
                  data-testid={at}
                />
                {values.links.length > 1 && (
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={`${copy.adminMarketJudgementLinkRemove} ${String(index + 1)}`}
                    disabled={disabled}
                    onClick={() =>
                      onValues({ links: values.links.filter((_, other) => other !== index) })
                    }
                    data-testid={`${at}-remove`}
                  >
                    {copy.adminMarketJudgementLinkRemove}
                  </Button>
                )}
              </HStack>
              <Field.ErrorText data-testid={`${at}-error`}>{error}</Field.ErrorText>
            </Field.Root>
          );
        })}
        {linksError !== null && (
          <Text fontSize="sm" color="fg.error" data-testid="market-judgement-links-error">
            {linksError}
          </Text>
        )}
        <Button
          size="xs"
          variant="outline"
          alignSelf="flex-start"
          disabled={disabled || values.links.length >= JUDGEMENT_EVIDENCE_LINKS_MAX}
          onClick={() => onValues({ links: [...values.links, ''] })}
          data-testid="market-judgement-link-add"
        >
          {copy.adminMarketJudgementLinkAdd}
        </Button>
      </Stack>
      <Field.Root invalid={errorOf('collectedAt') !== null} required>
        <Field.Label>{copy.adminMarketJudgementCollectedAt}</Field.Label>
        <Input
          type="datetime-local"
          value={values.collectedLocal}
          onChange={(event) => onValues({ collectedLocal: event.target.value })}
          disabled={disabled}
          data-testid="market-judgement-collected-at"
        />
        <Field.HelperText>{copy.adminMarketJudgementCollectedAtHint}</Field.HelperText>
        <Field.ErrorText data-testid="market-judgement-collected-at-error">
          {errorOf('collectedAt')}
        </Field.ErrorText>
      </Field.Root>
      <ReasonField
        testId="market-judgement-description"
        label={copy.adminMarketJudgementDescription}
        hint={copy.adminMarketJudgementDescriptionHint}
        value={values.description}
        onChange={(description) => onValues({ description })}
        error={errorOf('description')}
        disabled={disabled}
      />
    </Stack>
  );
}
