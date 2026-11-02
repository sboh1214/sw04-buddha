'use client';

import { Alert, Badge, Button, Card, Field, HStack, Input, Stack, Text } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { OperatorFieldset } from '@/components/ui/operator-fieldset';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { type AdminMarket, type MarketSupplementChanges, api, unwrap } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  type MarketFormValues,
  marketToFormValues,
  restoreFixedClose,
  supplementCloseFixed,
  supplementFormSchema,
  toSupplementChanges,
} from '@/lib/market-form';
import {
  SUPPLEMENT_FORM_UNAVAILABLE_NOTE,
  SUPPLEMENT_STATUS_LABEL,
  SUPPLEMENT_UNAPPROVABLE_NOTE,
  SUPPLEMENT_UNAVAILABLE_NOTE,
  adminRuleVersionRows,
  isSupplementRequester,
  showsSupplementPanel,
  supplementActorName,
  supplementBoundary,
  supplementChangeRows,
  supplementFailure,
  supplementLogRows,
  supplementRefocus,
  supplementRequestDraft,
  supplementUnapprovable,
  supplementUnavailable,
} from '@/lib/market-supplement';
import { type EventRow } from '@/lib/market-admin';
import { ruleVersionName } from '@/lib/rule-versions';
import { MarketRuleFields } from '../market-rule-fields';
import { MarketTimeFields } from '../market-time-fields';
import { ReasonField } from './market-review-dialogs';
import { type SupplementDialogKind, SupplementDialog } from './market-supplement-dialogs';

/** What the panel opened: the request form, or one of the waiting request's dialogs. */
export type SupplementAction = 'request' | SupplementDialogKind;

/**
 * 규칙 보충 (#80, ADR-0101; ADR-0093 decision 2 #172 items 14·15, decision 3 '#80 보충의 형태'), on a
 * market OPEN or PAUSED and on any that has a version or a request (`showsSupplementPanel`): what
 * it asks of the admin on screen (`SupplementPanelBody`) and what it opened — the request form or
 * a dialog — held for that admin (`useHeldForOperator`, ADR-0092 answer 1): once `['me']` turns
 * from A to B in place, it closes with what A typed. The form is drawn again for each admin on
 * screen (`key`), its fields off until that admin is known (`OperatorFieldset`). Held, the form
 * stays until the admin closes it (`SupplementPanelBody`), and focus comes back to the panel then
 * (`useSupplementRefocus`).
 */
export function MarketSupplementPanel({ market, readAt }: { market: AdminMarket; readAt: number }) {
  const operatorId = useOperatorId();
  const [action, setAction] = useHeldForOperator<SupplementAction>();
  const refocus = useSupplementRefocus(market, action);
  if (!showsSupplementPanel(market)) return null;
  const close = () => setAction(null);
  const closeForm = (sent: boolean) => {
    refocus.formClosed(sent);
    setAction(null);
  };
  return (
    <>
      <SupplementPanelBody
        market={market}
        readAt={readAt}
        operatorId={operatorId}
        onOpen={setAction}
        requestForm={
          action === 'request' ? (
            <SupplementRequestForm
              key={operatorId ?? ''}
              market={market}
              readAt={readAt}
              onClose={closeForm}
            />
          ) : null
        }
        targets={refocus.targets}
      />
      {action !== null && action !== 'request' && (
        <SupplementDialog kind={action} market={market} onClose={close} />
      )}
    </>
  );
}

/** The panel's elements focus comes back to once the request form closes (`supplementRefocus`). */
export interface SupplementFocusTargets {
  title: RefObject<HTMLParagraphElement | null>;
  request: RefObject<HTMLButtonElement | null>;
  pending: RefObject<HTMLParagraphElement | null>;
}

/**
 * Focus once the request form closes (WCAG 2.4.3; the form takes it as it opens): `formClosed`
 * marks the close — 취소, or a request sent (`sent`) — and the next draw puts focus where
 * `supplementRefocus` says: 보충 요청, or where that is not drawn the waiting request's heading or
 * the panel's own; after a request sent, once the market holding it is drawn. Only when focus went
 * with the form: an admin who has moved on keeps it where it is.
 */
function useSupplementRefocus(market: AdminMarket, action: SupplementAction | null) {
  const title = useRef<HTMLParagraphElement>(null);
  const request = useRef<HTMLButtonElement>(null);
  const pending = useRef<HTMLParagraphElement>(null);
  const closed = useRef<{ sent: boolean; market: AdminMarket } | null>(null);
  useEffect(() => {
    const from = closed.current;
    if (from === null || action === 'request') return;
    const target = supplementRefocus({
      waiting: from.sent && from.market === market,
      request: request.current !== null,
      pending: pending.current !== null,
    });
    if (target === null) return;
    closed.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const element = { title, request, pending }[target].current;
    element?.focus();
  }, [action, market]);
  return {
    targets: { title, request, pending } satisfies SupplementFocusTargets,
    formClosed: (sent: boolean) => {
      closed.current = { sent, market };
    },
  };
}

/**
 * The panel as drawn for `operatorId` (undefined until `GET /me` answers), read at `readAt` (the
 * query's `dataUpdatedAt`, what a close is judged at):
 * - the current version ('현재 규칙 버전 v3', or 규칙 버전 없음 for a market opened before #80);
 * - 보충 요청 while one may be asked for (`supplementUnavailable`), which opens the form in its place
 *   (`requestForm`) — or why not: not OPEN or PAUSED, no version, its close come. The form, once
 *   open, stays while it is held, whatever a refetch reads: it says itself why it cannot be sent
 *   now, and with what was typed in it goes only when the admin closes it;
 * - the waiting request: who asked and when, the version it was written against, each item's text
 *   now and after it, the reason and the 정산 영향 검토; 승인 and 반려 for any other admin (승인 only
 *   while it can still be approved, `supplementUnapprovable`, with the note why not), off for its
 *   requester with the note why, and 철회 for the requester alone;
 * - the 보충 기록, newest first, and the 규칙 버전 기록 with who asked for and made each version.
 * No button is live until the admin on screen is known. `targets` are what focus comes back to
 * (`useSupplementRefocus`).
 */
export function SupplementPanelBody({
  market,
  readAt,
  operatorId,
  onOpen,
  requestForm,
  targets,
}: {
  market: AdminMarket;
  readAt: number;
  operatorId: string | undefined;
  onOpen: (action: SupplementAction) => void;
  requestForm: ReactNode;
  targets?: SupplementFocusTargets;
}) {
  const unavailable = supplementUnavailable(market, readAt);
  return (
    <Card.Root data-testid="market-supplement" data-status={market.status}>
      <Card.Header>
        <Stack gap="1">
          <HStack gap="2" flexWrap="wrap" align="baseline">
            <Text
              ref={targets?.title}
              tabIndex={-1}
              fontWeight="semibold"
              data-testid="market-supplement-title"
            >
              {copy.adminMarketSupplement}
            </Text>
            <Badge variant="subtle" data-testid="market-supplement-version">
              {market.ruleVersion === null
                ? copy.adminMarketSupplementNoVersion
                : `${copy.adminMarketSupplementVersion} ${ruleVersionName(market.ruleVersion)}`}
            </Badge>
          </HStack>
          <Text fontSize="sm" color="fg.muted">
            {copy.adminMarketSupplementIntro}
          </Text>
        </Stack>
      </Card.Header>
      <Card.Body>
        <Stack gap="5">
          {market.supplement.pending !== null && (
            <PendingSupplement
              market={market}
              readAt={readAt}
              operatorId={operatorId}
              onOpen={onOpen}
              headingRef={targets?.pending}
            />
          )}
          {/* The form held open stays, unavailable or not: it says why itself (above). */}
          {requestForm ??
            (unavailable === null ? (
              <Button
                ref={targets?.request}
                size="sm"
                alignSelf="flex-start"
                disabled={operatorId === undefined}
                onClick={() => onOpen('request')}
                data-testid="market-supplement-request"
              >
                {copy.adminMarketSupplementRequest}
              </Button>
            ) : (
              unavailable !== 'pending' && (
                <Text
                  fontSize="sm"
                  color="fg.muted"
                  data-testid="market-supplement-unavailable"
                  data-reason={unavailable}
                >
                  {SUPPLEMENT_UNAVAILABLE_NOTE[unavailable]}
                </Text>
              )
            ))}
          <SupplementLog market={market} />
          {market.ruleVersions.length > 0 && <AdminRuleVersions market={market} />}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/** A heading inside the panel; one focus may come back to (`headingRef`) takes it from script. */
function PanelHeading({
  children,
  headingRef,
  testId,
}: {
  children: string;
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

/** Label/value rows in the panel's small print, one line each. */
function Rows({ rows, testId }: { rows: readonly EventRow[]; testId: string }) {
  return (
    <Stack gap="0" fontSize="sm" color="fg.muted" data-testid={testId}>
      {rows.map((row) => (
        <Text key={row.label} whiteSpace="pre-wrap" wordBreak="break-word">
          <Text as="span" fontWeight="medium">
            {row.label}
          </Text>{' '}
          {row.value}
        </Text>
      ))}
    </Stack>
  );
}

/**
 * The waiting request (`supplement.pending`) and what may be done with it: the reviewer reads every
 * item's text now and after it (`supplementChangeRows`), the reason and the 정산 영향 검토 (#172 item
 * 15) before deciding. 승인 is off with the note why while it cannot be approved
 * (`supplementUnapprovable`: the close come, or a close change on a PAUSED market).
 */
function PendingSupplement({
  market,
  readAt,
  operatorId,
  onOpen,
  headingRef,
}: {
  market: AdminMarket;
  readAt: number;
  operatorId: string | undefined;
  onOpen: (action: SupplementAction) => void;
  headingRef?: RefObject<HTMLParagraphElement | null>;
}) {
  const pending = market.supplement.pending;
  if (pending === null) return null;
  const requester = isSupplementRequester(pending, operatorId);
  const unapprovable = supplementUnapprovable(market, pending, readAt);
  const approvable = unapprovable === null;
  const changes = supplementChangeRows(market, pending, formatKst);
  return (
    <Stack
      gap="3"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid="market-supplement-pending"
    >
      <PanelHeading headingRef={headingRef} testId="market-supplement-pending-title">
        {copy.adminMarketSupplementPending}
      </PanelHeading>
      <Text fontSize="sm">
        {copy.adminMarketSupplementRequestedBy}{' '}
        <Text as="span" fontWeight="medium" data-testid="market-supplement-pending-by">
          {supplementActorName(pending.requestedBy)}
        </Text>{' '}
        · {copy.adminMarketSupplementRequestedAt}{' '}
        <Text as="span" data-testid="market-supplement-pending-at">
          {formatKst(pending.requestedAt)}
        </Text>{' '}
        · {copy.adminMarketSupplementBase}{' '}
        <Text as="span" data-testid="market-supplement-pending-base">
          {ruleVersionName(pending.baseVersion)}
        </Text>
      </Text>
      <Stack gap="3" data-testid="market-supplement-pending-changes">
        {changes.map((row) => (
          <Stack
            key={row.item}
            gap="0.5"
            fontSize="sm"
            ps="3"
            borderStartWidth="2px"
            data-testid={`market-supplement-pending-change-${row.item}`}
          >
            <Text fontWeight="medium">{row.label}</Text>
            <Text whiteSpace="pre-wrap" wordBreak="break-word" color="fg.muted">
              <Text as="span" fontWeight="medium">
                {copy.adminMarketSupplementBefore}
              </Text>{' '}
              <Text as="span" data-testid={`market-supplement-pending-change-${row.item}-before`}>
                {row.before}
              </Text>
            </Text>
            <Text whiteSpace="pre-wrap" wordBreak="break-word">
              <Text as="span" fontWeight="medium">
                {copy.adminMarketSupplementAfter}
              </Text>{' '}
              <Text as="span" data-testid={`market-supplement-pending-change-${row.item}-after`}>
                {row.after}
              </Text>
            </Text>
          </Stack>
        ))}
      </Stack>
      <Stack gap="1" fontSize="sm">
        <Text whiteSpace="pre-wrap" wordBreak="break-word">
          <Text as="span" fontWeight="medium">
            {copy.adminMarketSupplementReason}
          </Text>{' '}
          <Text as="span" data-testid="market-supplement-pending-reason">
            {pending.reason}
          </Text>
        </Text>
        <Text whiteSpace="pre-wrap" wordBreak="break-word">
          <Text as="span" fontWeight="medium">
            {copy.adminMarketSupplementImpact}
          </Text>{' '}
          <Text as="span" data-testid="market-supplement-pending-impact">
            {pending.settlementImpact}
          </Text>
        </Text>
      </Stack>
      {requester === true && (
        <Alert.Root status="warning" role="status" data-testid="market-supplement-requester-note">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminMarketSupplementExcludedRequester}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {unapprovable !== null && (
        <Alert.Root
          status="warning"
          role="status"
          data-testid={`market-supplement-pending-${unapprovable}`}
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{SUPPLEMENT_UNAPPROVABLE_NOTE[unapprovable]}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <HStack gap="2" flexWrap="wrap" data-testid="market-supplement-actions">
        <Button
          size="sm"
          disabled={operatorId === undefined || requester !== false || !approvable}
          onClick={() => onOpen('approve')}
          data-testid="market-supplement-approve"
        >
          {copy.adminMarketSupplementApprove}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={operatorId === undefined || requester !== false}
          onClick={() => onOpen('reject')}
          data-testid="market-supplement-reject"
        >
          {copy.adminMarketSupplementReject}
        </Button>
        {requester === true && (
          <Button
            size="sm"
            variant="outline"
            disabled={operatorId === undefined}
            onClick={() => onOpen('retract')}
            data-testid="market-supplement-retract"
          >
            {copy.adminMarketSupplementRetract}
          </Button>
        )}
      </HStack>
    </Stack>
  );
}

/**
 * 보충 기록 (`supplement.log`, newest first, the waiting request included): each its status, who
 * asked (by nickname) and when in KST, then its rows (`supplementLogRows`).
 * `market-supplement-log-<n>` counts from the newest and carries the status in `data-status`.
 */
function SupplementLog({ market }: { market: AdminMarket }) {
  const log = market.supplement.log;
  return (
    <Stack gap="2" data-testid="market-supplement-log">
      <PanelHeading>{copy.adminMarketSupplementLog}</PanelHeading>
      {log.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" data-testid="market-supplement-log-empty">
          {copy.adminMarketSupplementLogEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {log.map((entry, index) => (
            <Stack
              key={entry.requestId}
              gap="0.5"
              data-testid={`market-supplement-log-${String(index)}`}
              data-status={entry.status}
            >
              <HStack gap="2" flexWrap="wrap">
                <Badge
                  variant="subtle"
                  data-testid={`market-supplement-log-${String(index)}-status`}
                >
                  {SUPPLEMENT_STATUS_LABEL[entry.status]}
                </Badge>
                <Text
                  fontSize="sm"
                  fontWeight="medium"
                  data-testid={`market-supplement-log-${String(index)}-by`}
                >
                  {supplementActorName(entry.requestedBy)}
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  {formatKst(entry.requestedAt)}
                </Text>
              </HStack>
              <Rows
                rows={supplementLogRows(entry, formatKst)}
                testId={`market-supplement-log-${String(index)}-rows`}
              />
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * 규칙 버전 기록 (`AdminMarket.ruleVersions`, newest first): the public history's versions with what
 * it leaves out — who asked for each and who made it, and the 정산 영향 검토 (`adminRuleVersionRows`).
 * The texts themselves are the public detail's 규칙 버전 card's; the event log names each version's
 * items and reason only.
 */
function AdminRuleVersions({ market }: { market: AdminMarket }) {
  return (
    <Stack gap="2" data-testid="market-supplement-versions">
      <PanelHeading>{copy.adminMarketRuleVersions}</PanelHeading>
      <Stack gap="3">
        {market.ruleVersions.map((version) => (
          <Stack
            key={version.version}
            gap="0.5"
            data-testid={`market-supplement-version-${String(version.version)}`}
          >
            <HStack gap="2" flexWrap="wrap">
              <Text fontSize="sm" fontWeight="semibold">
                {ruleVersionName(version.version)}
              </Text>
              {version.version === market.ruleVersion && (
                <Badge size="sm" variant="outline">
                  {copy.ruleVersionsCurrent}
                </Badge>
              )}
              {version.version === 1 && (
                <Text fontSize="xs" color="fg.muted">
                  {copy.ruleVersionsFixedAtOpen}
                </Text>
              )}
            </HStack>
            <Rows
              rows={adminRuleVersionRows(version, formatKst)}
              testId={`market-supplement-version-${String(version.version)}-rows`}
            />
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

/** What a request sends, taken from the form when it is submitted; `by` is the admin. */
interface RequestVariables {
  baseVersion: number;
  changes: MarketSupplementChanges;
  reason: string;
  settlementImpact: string;
  by: string;
}

/**
 * 보충 요청's form (#172 item 15), in the panel: the question, the rule items (`MarketRuleFields`)
 * and the times (`MarketTimeFields`: the scheduled open and judgement fixed, the close locked while
 * PAUSED — `supplementCloseFixed` — and put back as the form opened on it, `restoreFixedClose`)
 * prefilled with the market as the form opened on it, the reason and the 정산 영향 검토, and the
 * boundary — a change of meaning is no supplement (#80 AC 8). Only what changed is sent
 * (`toSupplementChanges`), against the version the form opened on (`baseVersion`): once the market
 * holds another the form says so and sends nothing, and the server refuses it too ('stale'). Alike
 * once the market read at `readAt` takes no request (`supplementUnavailable`: another waiting, its
 * close come, neither OPEN nor PAUSED): the form stays with what was typed, says why and sends
 * nothing, until the admin closes it. Each item is checked as the API checks it
 * (`supplementFormSchema`); a refusal lands under its input, the reason's or the 정산 영향 검토's,
 * or above the buttons (`supplementFailure`). Sent, it closes and the market with its waiting
 * request goes on screen (`useApplyMarket`). Focus moves to its heading as it opens; `onClose`
 * says whether it was sent.
 */
export function SupplementRequestForm({
  market,
  readAt,
  onClose,
}: {
  market: AdminMarket;
  readAt: number;
  onClose: (sent: boolean) => void;
}) {
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  // The admin on screen, whom the request names (ADR-0092): it waits for `GET /me`.
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
  // The market as the form opened on it: the version the text is written against and the values
  // each change is taken from. Kept from the first draw — a refetch must not move either.
  const [opened] = useState(() => ({
    baseVersion: market.ruleVersion,
    original: marketToFormValues(market, []),
  }));
  const stale = market.ruleVersion !== opened.baseVersion;
  const unavailable = supplementUnavailable(market, readAt);
  const paused = market.status === 'paused';
  const closeFixed = supplementCloseFixed(paused);
  const gap = market.leadCloseGapMinutes;
  const schema = useMemo(
    () => supplementFormSchema({ original: opened.original, paused, leadCloseGapMinutes: gap }),
    [opened.original, paused, gap],
  );
  const form = useForm<MarketFormValues>({
    resolver: zodResolver(schema),
    defaultValues: opened.original,
  });
  const {
    register,
    formState: { errors },
  } = form;
  const [reasonText, setReasonText] = useState('');
  const [impactText, setImpactText] = useState('');
  // The reason and the 정산 영향 검토 say what they lack once the form has been sent once.
  const [tried, setTried] = useState(false);
  const [fieldError, setFieldError] = useState<{
    field: 'reason' | 'settlementImpact';
    message: string;
  } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const draft = supplementRequestDraft(reasonText, impactText);
  // Opened from 보충 요청: focus goes into the form, at its heading.
  const title = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  // The close locked while PAUSED — the market's now, or since the form opened — holds no edit.
  useEffect(() => {
    if (closeFixed) restoreFixedClose(form, opened.original, tried);
  }, [closeFixed, form, opened.original, tried]);

  const request = useMutation({
    mutationFn: async ({ baseVersion, changes, reason, settlementImpact, by }: RequestVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/supplements', {
          params: { path: { id: market.id } },
          body: { baseVersion, changes, reason, settlementImpact, expectedAccountId: by },
        }),
      ).data,
    onMutate: () => {
      setFieldError(null);
      setRefusal(null);
    },
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: copy.adminMarketSupplementRequested });
      onClose(true);
      await apply(fresh);
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = supplementFailure(error, form.getValues(), gap);
      if (failure.kind === 'toast') {
        // Another account's cookie: the page drops this form once the session names the admin
        // really signed in, so the refusal is a toast that outlives it.
        toaster.create({ type: 'error', title: failure.message });
        onClose(false);
        return;
      }
      if (failure.kind === 'item') {
        form.setError(failure.field, { message: failure.message });
      } else if (
        failure.kind === 'field' &&
        (failure.field === 'reason' || failure.field === 'settlementImpact')
      ) {
        setFieldError({ field: failure.field, message: failure.message });
      } else {
        setRefusal(failure.message);
      }
      if (failure.kind !== 'field' && failure.refresh) {
        void queryClient.invalidateQueries({ queryKey: adminMarketKey(market.id) });
      }
    },
  });

  const submit = form.handleSubmit(
    (values) => {
      setTried(true);
      setRefusal(null);
      const { baseVersion } = opened;
      if (operatorId === undefined || baseVersion === null || stale || unavailable !== null) {
        return;
      }
      const changes = toSupplementChanges(values, opened.original);
      if (Object.keys(changes).length === 0) {
        setRefusal(copy.adminMarketNoChanges);
        return;
      }
      if (!draft.ready) return;
      request.mutate({
        baseVersion,
        changes,
        reason: draft.reason,
        settlementImpact: draft.settlementImpact,
        by: operatorId,
      });
    },
    () => setTried(true),
  );
  const errorOf = (field: 'reason' | 'settlementImpact', drafted: string | null) =>
    fieldError?.field === field ? fieldError.message : tried ? drafted : null;

  return (
    <form onSubmit={(event) => void submit(event)} noValidate data-testid="market-supplement-form">
      <OperatorFieldset disabled={operatorId === undefined}>
        <Stack gap="4" borderWidth="1px" borderRadius="l2" p="3">
          <Stack gap="1">
            <HStack gap="2" flexWrap="wrap" align="baseline">
              <Text
                ref={title}
                tabIndex={-1}
                fontWeight="medium"
                data-testid="market-supplement-form-title"
              >
                {copy.adminMarketSupplementFormTitle}
              </Text>
              <Badge variant="subtle" data-testid="market-supplement-form-base">
                {copy.adminMarketSupplementBase}{' '}
                {opened.baseVersion === null ? '—' : ruleVersionName(opened.baseVersion)}
              </Badge>
            </HStack>
            <Text fontSize="sm" color="fg.muted">
              {copy.adminMarketSupplementFormHint}
            </Text>
          </Stack>
          {/* #80 AC 8: the request screen says a change of meaning goes to the pause, not here. */}
          <Alert.Root status="warning" role="status" data-testid="market-supplement-boundary">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{supplementBoundary(market.status)}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          {stale && (
            <Alert.Root status="warning" role="status" data-testid="market-supplement-form-stale">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.adminMarketSupplementFormStale}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
          )}
          {unavailable !== null && (
            <Alert.Root
              status="warning"
              role="status"
              data-testid="market-supplement-form-unavailable"
              data-reason={unavailable}
            >
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>
                  {SUPPLEMENT_FORM_UNAVAILABLE_NOTE[unavailable]}
                </Alert.Description>
              </Alert.Content>
            </Alert.Root>
          )}
          <Field.Root invalid={!!errors.title} required>
            <Field.Label>{copy.adminMarketTitle}</Field.Label>
            <Input autoComplete="off" data-testid="market-title" {...register('title')} />
            <Field.ErrorText>{errors.title?.message}</Field.ErrorText>
          </Field.Root>
          <MarketRuleFields
            form={form}
            disabled={false}
            hint={copy.adminMarketSupplementRuleItemsHint}
          />
          <MarketTimeFields
            form={form}
            disabled={false}
            fixed
            closeLocked={closeFixed}
            leadCloseGapMinutes={gap}
          />
          <ReasonField
            testId="market-supplement-reason"
            label={copy.adminMarketSupplementReason}
            hint={copy.adminMarketSupplementReasonHint}
            value={reasonText}
            onChange={setReasonText}
            error={errorOf('reason', draft.reasonError)}
            disabled={request.isPending}
          />
          <ReasonField
            testId="market-supplement-impact"
            label={copy.adminMarketSupplementImpact}
            hint={copy.adminMarketSupplementImpactHint}
            value={impactText}
            onChange={setImpactText}
            error={errorOf('settlementImpact', draft.impactError)}
            disabled={request.isPending}
          />
          {refusal !== null && (
            <Alert.Root status="error" role="alert" data-testid="market-supplement-form-refusal">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{refusal}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
          )}
          <HStack gap="2" flexWrap="wrap">
            <Button
              type="submit"
              size="sm"
              loading={request.isPending}
              disabled={operatorId === undefined || stale || unavailable !== null}
              data-testid="market-supplement-submit"
            >
              {copy.adminMarketSupplementRequest}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={request.isPending}
              onClick={() => onClose(false)}
              data-testid="market-supplement-cancel"
            >
              {copy.cancel}
            </Button>
          </HStack>
        </Stack>
      </OperatorFieldset>
    </form>
  );
}
