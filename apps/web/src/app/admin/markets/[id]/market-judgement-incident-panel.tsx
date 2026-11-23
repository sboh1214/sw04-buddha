'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  Link as ChakraLink,
  HStack,
  Heading,
  Stack,
  Text,
} from '@chakra-ui/react';
import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { copy } from '@/copy';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { type AdminMarket } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { MARKET_RESULT_LABEL } from '@/lib/market-admin';
import { isHttpUrl } from '@/lib/market-form';
import {
  INCIDENT_STATUS_LABEL,
  type IncidentDecision,
  incidentPaidText,
  incidentReviewUnavailable,
  incidentUnregistrable,
  incidentUnregistrableNote,
  showsJudgementIncidentPanel,
} from '@/lib/market-judgement-incident';
import { nicknameShown } from '@/lib/account-closure';
import { JudgementIncidentDialog } from './market-judgement-incident-dialogs';

/** What the panel opened: the registration's dialog, or a decision's on the waiting incident. */
export type IncidentAction = 'register' | IncidentDecision;

/**
 * 판정 오류 사건 (#144 part 1, ADR-0165; owner answers 144-3·144-4·144-8·144-13·144-14·144-19;
 * ADR-0093 decision 1 #173 items 8·12·13·15; ADR-0120 decisions 5·6) on the admin detail, after the
 * judgement it corrects, from 결과 확정 on and on any market with an incident
 * (`showsJudgementIncidentPanel`): what it asks of the admin on screen
 * (`MarketJudgementIncidentBody`) and the dialog it opened — the registration's, or the waiting
 * incident's 오류 확인, 기각 or 철회 — held for that admin (`useHeldForOperator`, ADR-0092 answer 1):
 * once `['me']` turns from A to B in place, the dialog closes with what A picked and typed. Focus
 * comes back to the heading once a write went through and took its button away (WCAG 2.4.3).
 */
export function MarketJudgementIncidentPanel({ market }: { market: AdminMarket }) {
  const operatorId = useOperatorId();
  const [action, setAction] = useHeldForOperator<IncidentAction>();
  const heading = useRef<HTMLHeadingElement>(null);
  const closed = useRef<{ market: AdminMarket } | null>(null);
  useEffect(() => {
    const from = closed.current;
    // Wait for the market the write answered: the button goes with it.
    if (from === null || action !== null || from.market === market) return;
    closed.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    heading.current?.focus();
  }, [action, market]);
  if (!showsJudgementIncidentPanel(market)) return null;
  return (
    <>
      <MarketJudgementIncidentBody
        market={market}
        operatorId={operatorId}
        onOpen={setAction}
        headingRef={heading}
      />
      {action !== null && (
        <JudgementIncidentDialog
          kind={action}
          market={market}
          onClose={(sent) => {
            if (sent) closed.current = { market };
            setAction(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The panel as drawn for `operatorId` (undefined until `GET /me` answers):
 * - 사건 등록, off with the note why while the market takes none (`incidentUnregistrable`: before
 *   결과 확정, legacy, a confirmed incident — 144-14 — or one waiting);
 * - the waiting incident: the paid result it corrects, the correct result, 오류 내용, the evidence
 *   and its collection instant, who registered it and when. Its registrant sees no 오류 확인 or 기각
 *   — another admin decides it (#171) — and alone may retract it. For anyone else both are drawn,
 *   off with the note why for the paid version's registrant (144-4, the shared
 *   `judgementIncidentDecisionRefusal`) and 오류 확인 off with '지급이 끝난 뒤 확인할 수 있습니다'
 *   before 지급 완료 (144-13);
 * - the confirmed incident (at most one, 144-14) with who registered and who confirmed it, when,
 *   and the reviewer's reason (admins only);
 * - the log of every registration, the newest first, and how each ended.
 * No market price, volume or count is drawn (the judgement follows the rule's source, #152 AC 8).
 */
export function MarketJudgementIncidentBody({
  market,
  operatorId,
  onOpen,
  headingRef,
}: {
  market: AdminMarket;
  operatorId: string | undefined;
  onOpen: (action: IncidentAction) => void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const { pending, confirmed } = market.judgementIncident;
  const unregistrable = incidentUnregistrable(market);
  return (
    <Card.Root
      data-testid="market-judgement-incident"
      data-status={market.status}
      data-registrable={market.judgementIncident.registrable}
    >
      <Card.Header>
        <Heading
          ref={headingRef}
          tabIndex={headingRef === undefined ? undefined : -1}
          size="md"
          data-testid="market-judgement-incident-title"
        >
          {copy.adminMarketJudgementIncident}
        </Heading>
      </Card.Header>
      <Card.Body>
        <Stack gap="4">
          <Text fontSize="sm" color="fg.muted">
            {copy.adminMarketJudgementIncidentIntro}
          </Text>
          <Stack gap="2" align="flex-start">
            <Button
              size="sm"
              disabled={operatorId === undefined || unregistrable !== null}
              onClick={() => onOpen('register')}
              data-testid="market-judgement-incident-register"
            >
              {copy.adminMarketJudgementIncidentRegister}
            </Button>
            {unregistrable !== null && (
              <Text
                fontSize="sm"
                color="fg.muted"
                data-testid="market-judgement-incident-unregistrable"
                data-reason={unregistrable}
              >
                {incidentUnregistrableNote(unregistrable)}
              </Text>
            )}
          </Stack>
          {pending !== null && (
            <PendingIncident market={market} operatorId={operatorId} onOpen={onOpen} />
          )}
          {confirmed !== null && <ConfirmedIncident market={market} />}
          <IncidentLog market={market} />
        </Stack>
      </Card.Body>
    </Card.Root>
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

/** What a registration says, one line each under `prefix`. */
function RegistrationLines({
  registration,
  paid,
  prefix,
}: {
  registration: {
    correctedResult: AdminMarket['judgementIncident']['log'][number]['correctedResult'];
    description: string;
    evidence: { links: string[]; collectedAt: string };
  };
  paid: string;
  prefix: string;
}) {
  return (
    <Stack gap="1">
      <Line label={copy.adminMarketJudgementIncidentPaidResult} testId={`${prefix}-paid`}>
        {paid}
      </Line>
      <Line label={copy.adminMarketJudgementIncidentCorrectedResult} testId={`${prefix}-result`}>
        {MARKET_RESULT_LABEL[registration.correctedResult]}
      </Line>
      <Line label={copy.adminMarketJudgementIncidentDescription} testId={`${prefix}-description`}>
        {registration.description}
      </Line>
      <Stack gap="0.5">
        <Text fontSize="sm" fontWeight="medium">
          {copy.adminMarketJudgementIncidentEvidence}
        </Text>
        <EvidenceLinks links={registration.evidence.links} testId={`${prefix}-links`} />
      </Stack>
      <Line label={copy.adminMarketJudgementIncidentCollectedAt} testId={`${prefix}-collected-at`}>
        {formatKst(registration.evidence.collectedAt)}
      </Line>
    </Stack>
  );
}

/** A warning note of the waiting incident's, under `testId`. */
function Note({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <Alert.Root status="warning" role="status" data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{children}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

function PendingIncident({
  market,
  operatorId,
  onOpen,
}: {
  market: AdminMarket;
  operatorId: string | undefined;
  onOpen: (action: IncidentAction) => void;
}) {
  const pending = market.judgementIncident.pending;
  if (pending === null) return null;
  const confirm = incidentReviewUnavailable(market, 'confirm', operatorId);
  const dismiss = incidentReviewUnavailable(market, 'dismiss', operatorId);
  const own = confirm === 'own';
  return (
    <Stack
      gap="3"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid="market-judgement-incident-pending"
      data-request={pending.requestId}
    >
      <Text fontWeight="medium" fontSize="sm">
        {copy.adminMarketJudgementIncidentPending}
      </Text>
      <RegistrationLines
        registration={pending}
        paid={incidentPaidText(market.judgementVersion, market.resolvedResult)}
        prefix="market-judgement-incident-pending"
      />
      <Line
        label={copy.adminMarketJudgementIncidentRegisteredBy}
        testId="market-judgement-incident-pending-by"
      >
        {nicknameShown(pending.requestedBy.nickname)}
      </Line>
      <Line
        label={copy.adminMarketJudgementIncidentRegisteredAt}
        testId="market-judgement-incident-pending-at"
      >
        {formatKst(pending.requestedAt)}
      </Line>
      {own && (
        <Note testId="market-judgement-incident-own-note">
          {copy.adminMarketJudgementIncidentOwnNote}
        </Note>
      )}
      {confirm === 'registrant' && (
        <Note testId="market-judgement-incident-registrant-note">
          {copy.adminMarketJudgementIncidentRegistrantNote}
        </Note>
      )}
      {!own && confirm === 'status' && (
        <Text fontSize="sm" color="fg.muted" data-testid="market-judgement-incident-confirm-waits">
          {copy.adminMarketJudgementIncidentConfirmWaits}
        </Text>
      )}
      <HStack gap="2" flexWrap="wrap">
        {own ? (
          <Button
            size="sm"
            variant="outline"
            disabled={operatorId === undefined}
            onClick={() => onOpen('retract')}
            data-testid="market-judgement-incident-retract"
          >
            {copy.adminMarketJudgementIncidentRetract}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              disabled={operatorId === undefined || confirm !== null}
              onClick={() => onOpen('confirm')}
              data-testid="market-judgement-incident-confirm"
            >
              {copy.adminMarketJudgementIncidentConfirm}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={operatorId === undefined || dismiss !== null}
              onClick={() => onOpen('dismiss')}
              data-testid="market-judgement-incident-dismiss"
            >
              {copy.adminMarketJudgementIncidentDismiss}
            </Button>
          </>
        )}
      </HStack>
    </Stack>
  );
}

function ConfirmedIncident({ market }: { market: AdminMarket }) {
  const confirmed = market.judgementIncident.confirmed;
  if (confirmed === null) return null;
  const at = 'market-judgement-incident-confirmed';
  return (
    <Stack
      gap="3"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={at}
      data-incident={confirmed.incidentId}
    >
      <Text fontWeight="medium" fontSize="sm">
        {copy.adminMarketJudgementIncidentConfirmed}
      </Text>
      <RegistrationLines
        registration={confirmed}
        paid={incidentPaidText(confirmed.judgementVersion, confirmed.originalResult)}
        prefix={at}
      />
      <Line label={copy.adminMarketJudgementIncidentRegisteredBy} testId={`${at}-registered-by`}>
        {nicknameShown(confirmed.registeredBy.nickname)} · {formatKst(confirmed.registeredAt)}
      </Line>
      <Line label={copy.adminMarketJudgementIncidentConfirmedBy} testId={`${at}-confirmed-by`}>
        {nicknameShown(confirmed.confirmedBy.nickname)} · {formatKst(confirmed.confirmedAt)}
      </Line>
      <Line label={copy.adminMarketJudgementIncidentReviewReason} testId={`${at}-reason`}>
        {confirmed.reason}
      </Line>
    </Stack>
  );
}

/**
 * 사건 기록 (`judgementIncident.log`, newest first, the waiting one included): each its status, who
 * registered it and when, the correct result, and — once decided — who decided it, when and why,
 * or when it was retracted. `market-judgement-incident-log-<n>` counts from the newest and carries
 * the status in `data-status`.
 */
function IncidentLog({ market }: { market: AdminMarket }) {
  const { log } = market.judgementIncident;
  return (
    <Stack gap="2" data-testid="market-judgement-incident-log">
      <Text fontWeight="medium" fontSize="sm">
        {copy.adminMarketJudgementIncidentLog}
      </Text>
      {log.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" data-testid="market-judgement-incident-log-empty">
          {copy.adminMarketJudgementIncidentLogEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {log.map((entry, index) => {
            const at = `market-judgement-incident-log-${String(index)}`;
            return (
              <Stack key={entry.requestId} gap="0.5" data-testid={at} data-status={entry.status}>
                <HStack gap="2" flexWrap="wrap">
                  <Badge variant="subtle" data-testid={`${at}-status`}>
                    {INCIDENT_STATUS_LABEL[entry.status]}
                  </Badge>
                  <Text fontSize="sm" fontWeight="medium" data-testid={`${at}-by`}>
                    {nicknameShown(entry.requestedBy.nickname)}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    {formatKst(entry.requestedAt)}
                  </Text>
                </HStack>
                <Stack gap="0" fontSize="sm" color="fg.muted">
                  <Text>
                    {copy.adminMarketJudgementIncidentCorrectedResult}{' '}
                    {MARKET_RESULT_LABEL[entry.correctedResult]}
                  </Text>
                  {entry.decidedBy !== null && entry.decidedAt !== null && (
                    <Text data-testid={`${at}-decided`}>
                      {copy.adminMarketJudgementIncidentDecidedBy}{' '}
                      {nicknameShown(entry.decidedBy.nickname)} · {formatKst(entry.decidedAt)}
                    </Text>
                  )}
                  {entry.decisionReason !== null && (
                    <Text whiteSpace="pre-wrap" wordBreak="break-word" data-testid={`${at}-reason`}>
                      {copy.adminMarketJudgementIncidentReviewReason} {entry.decisionReason}
                    </Text>
                  )}
                  {entry.retractedAt !== null && (
                    <Text data-testid={`${at}-retracted`}>
                      {copy.adminMarketJudgementIncidentRetractedAt} {formatKst(entry.retractedAt)}
                    </Text>
                  )}
                </Stack>
              </Stack>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
