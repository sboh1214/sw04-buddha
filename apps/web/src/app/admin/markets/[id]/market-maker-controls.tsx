'use client';
import { Alert, Button, Card, Field, HStack, Input, Skeleton, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import NextLink from 'next/link';
import { type MarketMakerControlChange } from '@buddha/shared';
import { copy } from '@/copy';
import { toaster } from '@/components/ui/toaster';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { useAdminMarketMaker } from '@/hooks/use-admin-market-maker';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import {
  CONTROL_KEY,
  applyControlWrite,
  useMarketMakerControl,
  useMarketMakerControlHistory,
  useMarketMakerControlRequests,
} from '@/hooks/use-market-maker-controls';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import {
  api,
  unwrap,
  type AdminMarket,
  type AdminMarketMaker,
  type MarketMakerControlRequest,
  type MarketMakerControlWrite,
} from '@/lib/api';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';
import { readFailed } from '@/lib/query-client';
import {
  CONTROL_LABEL,
  CONTROL_EFFECT,
  CONTROL_STATUS,
  controlForm,
  controlDraft,
  controlStanding,
  controlBaseChanged,
  controlFailure,
  type ControlForm,
} from '@/lib/market-maker-controls';
import { ReviewDialogShell, ReasonField } from './market-review-dialogs';

type Decision = 'approve' | 'reject' | 'retract';
type Target =
  | { kind: 'request'; action: MarketMakerControlChange['action']; maker: AdminMarketMaker }
  | { kind: 'decision'; action: Decision; id: string; marketId: string };
const decisionLabel = (action: Decision) =>
  action === 'approve'
    ? copy.makerControlsApprove
    : action === 'reject'
      ? copy.makerControlsReject
      : copy.makerControlsRetract;
function ReadFailure({ retry, busy }: { retry: () => void; busy: boolean }) {
  return (
    <Stack>
      <Alert.Root status="error">
        <Alert.Indicator />
        <Alert.Description>{copy.makerControlsReadFailed}</Alert.Description>
      </Alert.Root>
      <Button type="button" variant="outline" loading={busy} disabled={busy} onClick={retry}>
        {copy.retry}
      </Button>
    </Stack>
  );
}
export function ControlRequestFacts({ request }: { request: MarketMakerControlRequest }) {
  const { payload } = request;
  const change = payload.change;
  const evidence = payload.demandSnapshot;
  return (
    <Stack gap="2" overflowWrap="anywhere">
      <Text fontWeight="semibold">
        {CONTROL_LABEL[change.action]} · {CONTROL_STATUS[request.status]}
      </Text>
      <Text>
        {copy.makerControlsVersion}: {payload.baseVersion} · {copy.makerControlsGeneration}:{' '}
        {payload.baseControlGeneration}
      </Text>
      <Text>
        {copy.makerControlsRequester}: {nicknameShown(request.requestedBy.nickname)}
      </Text>
      <Text fontSize="sm">{formatKst(request.requestedAt)}</Text>
      <Text>
        {copy.makerControlsBefore}: {copy.makerControlsBudget} {payload.beforeConfig.budgetCoin} ·{' '}
        {copy.makerControlsMaxLoss} {payload.beforeConfig.maxLossCoin} · {copy.makerControlsCurve}{' '}
        {payload.beforeConfig.b} · {copy.makerControlsLevels} {payload.beforeConfig.levels} ·{' '}
        {copy.makerControlsQuantity} {payload.beforeConfig.quantity} · {copy.makerControlsSafety}{' '}
        {payload.beforeConfig.safetyTicks}
      </Text>
      {change.action === 'settings' && (
        <Text>
          {copy.makerControlsMaxLoss}: {change.settings.maxLossCoin} · {copy.makerControlsLevels}:{' '}
          {change.settings.levels} · {copy.makerControlsQuantity}: {change.settings.quantity} ·{' '}
          {copy.makerControlsSafety}: {change.settings.safetyTicks}
        </Text>
      )}
      {change.action === 'increase' && (
        <>
          <Text>
            {copy.makerControlsAdditional}: {change.additionalCoin}
          </Text>
          <Text>
            {formatKst(change.demand.from)} — {formatKst(change.demand.to)}
          </Text>
          {(['independentParticipants', 'bidirectionalTrading', 'actualDemand'] as const).map(
            (key, index) => (
              <Text key={key} whiteSpace="pre-wrap">
                {
                  [
                    copy.makerControlsIndependent,
                    copy.makerControlsBidirectional,
                    copy.makerControlsDemand,
                  ][index]
                }
                : {change.demand[key]}
              </Text>
            ),
          )}
        </>
      )}
      {evidence && (
        <Stack borderWidth="1px" p="3">
          <Text fontWeight="semibold">{copy.makerControlsEvidence}</Text>
          <Text>{copy.makerControlsEvidenceHelp}</Text>
          <Text>
            {copy.makerControlsHumanAccounts}: {evidence.distinctHumanAccounts}
          </Text>
          <Text>
            {copy.makerControlsHumanFills}: {evidence.humanInvolvedFillCount}
          </Text>
          <Text>
            {copy.makerControlsBuy}: {evidence.humanBuyQty} / {evidence.humanBuyCoin}
          </Text>
          <Text>
            {copy.makerControlsSell}: {evidence.humanSellQty} / {evidence.humanSellCoin}
          </Text>
        </Stack>
      )}
      <Text whiteSpace="pre-wrap">{request.reason}</Text>
      {request.decisionReason && <Text whiteSpace="pre-wrap">{request.decisionReason}</Text>}
      {request.execution && (
        <Text>
          {copy.makerControlsCompleted}: {formatKst(request.execution.performedAt)}
        </Text>
      )}
    </Stack>
  );
}
function useWrite(send: (by: string) => Promise<MarketMakerControlWrite>, close: () => void) {
  const client = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [refusal, setRefusal] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: send,
    onMutate: () => setRefusal(null),
    onSuccess: async (fresh, by) => {
      // A late response belonging to the old screen never enters the next operator's cache.
      if (client.getQueryData<{ id: string }>(ME_QUERY_KEY)?.id !== by) return;
      if (!(await applyControlWrite(client, by, fresh))) return;
      toaster.create({ type: 'success', title: copy.makerControlsSaved });
      close();
      void client.invalidateQueries({ queryKey: CONTROL_KEY });
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = controlFailure(error);
      if (failure.close) {
        toaster.create({ type: 'error', title: failure.message });
        close();
      } else setRefusal(failure.message);
      void client.invalidateQueries({ queryKey: CONTROL_KEY });
    },
  });
  return { mutation, refusal };
}
function RequestDialog({
  target,
  onClose,
}: {
  target: Extract<Target, { kind: 'request' }>;
  onClose: () => void;
}) {
  const operator = useOperatorId();
  const [base] = useState(target.maker);
  const [form, setForm] = useState(() => controlForm(base));
  const current = useAdminMarketMaker(base.marketId);
  const action = target.action;
  const draft = controlDraft(base, action, form, operator);
  const changed =
    !current.data ||
    controlBaseChanged(current.data, {
      baseVersion: base.config!.version,
      baseControlGeneration: base.runtime!.controlGeneration,
    });
  const { mutation, refusal } = useWrite(async (by) => {
    const body = controlDraft(base, action, form, by);
    if (!body) throw new Error('invalid control');
    return unwrap(
      await api.POST('/api/v1/admin/markets/{marketId}/market-maker/control-requests', {
        params: { path: { marketId: base.marketId } },
        body,
      }),
    ).data;
  }, onClose);
  const field = (key: keyof ControlForm, label: string, type = 'text') => (
    <Field.Root key={key}>
      <Field.Label>{label}</Field.Label>
      <Input
        data-testid={`maker-control-${key}`}
        type={type}
        value={form[key]}
        disabled={mutation.isPending}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </Field.Root>
  );
  return (
    <ReviewDialogShell
      testId="maker-control-request-dialog"
      title={CONTROL_LABEL[action]}
      body={CONTROL_EFFECT[action]}
      confirmLabel={copy.makerControlsRequest}
      pending={mutation.isPending}
      confirmDisabled={!draft || changed || current.isError || mutation.isPending}
      refusal={refusal ?? (changed ? copy.makerControlsChanged : null)}
      onClose={onClose}
      onConfirm={() => {
        if (operator && draft && !changed && !current.isError && !mutation.isPending)
          mutation.mutate(operator);
      }}
    >
      <Stack>
        <Text>{copy.makerControlsFixed}</Text>
        {current.isError && (
          <ReadFailure retry={() => void current.refetch()} busy={current.isFetching} />
        )}
        {action === 'settings' && (
          <>
            {field('maxLossCoin', copy.makerControlsMaxLoss)}
            {field('levels', copy.makerControlsLevels)}
            {field('quantity', copy.makerControlsQuantity)}
            {field('safetyTicks', copy.makerControlsSafety)}
          </>
        )}
        {action === 'increase' && (
          <>
            {field('additionalCoin', copy.makerControlsAdditional)}
            {field('from', copy.makerControlsFrom, 'datetime-local')}
            {field('to', copy.makerControlsTo, 'datetime-local')}
            {(['independentParticipants', 'bidirectionalTrading', 'actualDemand'] as const).map(
              (key, i) => (
                <ReasonField
                  error={null}
                  key={key}
                  testId={`maker-control-${key}`}
                  label={
                    [
                      copy.makerControlsIndependent,
                      copy.makerControlsBidirectional,
                      copy.makerControlsDemand,
                    ][i]!
                  }
                  value={form[key]}
                  onChange={(value) => setForm({ ...form, [key]: value })}
                  disabled={mutation.isPending}
                />
              ),
            )}
          </>
        )}
        <ReasonField
          error={null}
          testId="maker-control-reason"
          label={copy.makerControlsReason}
          value={form.reason}
          onChange={(reason) => setForm({ ...form, reason })}
          disabled={mutation.isPending}
        />
      </Stack>
    </ReviewDialogShell>
  );
}
export function ControlDecisionDialog({
  marketId,
  id,
  action,
  onClose,
}: {
  marketId: string;
  id: string;
  action: Decision;
  onClose: () => void;
}) {
  const operator = useOperatorId();
  const query = useMarketMakerControl(operator, marketId, id);
  const [pinned, setPinned] = useState<MarketMakerControlRequest | null>(null);
  const [reason, setReason] = useState('');
  if (!pinned && query.data) setPinned(query.data.request);
  const request = pinned;
  const latest = query.data?.request;
  const stale =
    !!request && !!query.data && controlBaseChanged(query.data.marketMaker, request.payload);
  const changed =
    !!request && !!latest && (request.id !== latest.id || latest.status !== 'pending');
  const standing = request ? controlStanding(request, operator) : null;
  const allowed = standing?.[action] === true && !changed && (action !== 'approve' || !stale);
  const { mutation, refusal } = useWrite(async (by) => {
    const params = { path: { marketId, requestId: id } };
    if (action === 'retract')
      return unwrap(
        await api.POST(
          '/api/v1/admin/markets/{marketId}/market-maker/control-requests/{requestId}/retract',
          { params, body: { expectedAccountId: by } },
        ),
      ).data;
    if (action === 'reject')
      return unwrap(
        await api.POST(
          '/api/v1/admin/markets/{marketId}/market-maker/control-requests/{requestId}/reject',
          { params, body: { expectedAccountId: by, reason: reason.trim() } },
        ),
      ).data;
    return unwrap(
      await api.POST(
        '/api/v1/admin/markets/{marketId}/market-maker/control-requests/{requestId}/approve',
        { params, body: { expectedAccountId: by, reason: reason.trim() } },
      ),
    ).data;
  }, onClose);
  const ready =
    allowed &&
    !query.isError &&
    !!request &&
    (action === 'retract' || (reason.trim().length > 0 && reason.trim().length <= 500));
  return (
    <ReviewDialogShell
      testId={`maker-control-${action}-dialog`}
      title={decisionLabel(action)}
      body={request ? CONTROL_EFFECT[request.payload.change.action] : copy.makerControlsFixed}
      confirmLabel={decisionLabel(action)}
      pending={mutation.isPending}
      confirmDisabled={!ready || mutation.isPending}
      refusal={refusal ?? (changed || stale ? copy.makerControlsChanged : null)}
      onClose={onClose}
      onConfirm={() => {
        if (operator && ready && !mutation.isPending) mutation.mutate(operator);
      }}
    >
      <Stack>
        {query.isError && (
          <ReadFailure retry={() => void query.refetch()} busy={query.isFetching} />
        )}
        {query.isPending && <Skeleton height="24" />}
        {!request && query.isSuccess && <Text>{copy.makerControlsNotFound}</Text>}
        {request && <ControlRequestFacts request={request} />}{' '}
        {action !== 'retract' && (
          <ReasonField
            error={null}
            testId="maker-control-decision-reason"
            label={copy.makerControlsDecisionReason}
            value={reason}
            onChange={setReason}
            disabled={mutation.isPending}
          />
        )}
      </Stack>
    </ReviewDialogShell>
  );
}
export function MarketMakerControlsPanel({ market }: { market: AdminMarket }) {
  const operator = useOperatorId();
  const maker = useAdminMarketMaker(market.id);
  const [all, setAll] = useState(false);
  const list = useMarketMakerControlRequests(operator, market.id, all);
  const history = useMarketMakerControlHistory(operator, market.id);
  const [target, hold] = useHeldForOperator<Target>();
  const allocated = !!maker.data?.runtime && !!maker.data.config;
  const held = maker.data?.readiness.blockers.includes('ledger_hold');
  return (
    <Card.Root data-testid="maker-controls">
      <Card.Header>
        <Card.Title>{copy.makerControlsTitle}</Card.Title>
        <Card.Description>{copy.makerControlsHelp}</Card.Description>
      </Card.Header>
      <Card.Body>
        <Stack gap="4">
          {maker.isError && (
            <ReadFailure retry={() => void maker.refetch()} busy={maker.isFetching} />
          )}
          {!allocated && <Text>{copy.makerControlsUnavailable}</Text>}
          <HStack flexWrap="wrap">
            {(['stop', 'resume', 'settings', 'increase'] as const).map((action) => (
              <Button
                type="button"
                key={action}
                data-testid={`maker-control-open-${action}`}
                variant="outline"
                disabled={
                  !operator ||
                  !allocated ||
                  maker.isError ||
                  !!held ||
                  (action === 'stop'
                    ? !['open', 'paused'].includes(market.status) ||
                      !maker.data?.runtime?.desiredEnabled
                    : market.status !== 'open' ||
                      (action === 'resume' && maker.data?.runtime?.desiredEnabled === true))
                }
                onClick={() => {
                  if (maker.data) hold({ kind: 'request', action, maker: maker.data });
                }}
              >
                {CONTROL_LABEL[action]}
              </Button>
            ))}
          </HStack>
          <HStack>
            <Button type="button" variant={all ? 'outline' : 'solid'} onClick={() => setAll(false)}>
              {copy.makerControlsPending}
            </Button>
            <Button type="button" variant={all ? 'solid' : 'outline'} onClick={() => setAll(true)}>
              {copy.makerControlsAll}
            </Button>
          </HStack>
          {readFailed(list) && (
            <ReadFailure retry={() => void list.refetch()} busy={list.isFetching} />
          )}
          {list.data?.pages
            .flatMap((p) => p.items)
            .map((request) => (
              <Card.Root key={request.id}>
                <Card.Body>
                  <Stack>
                    <ControlRequestFacts request={request} />
                    <HStack flexWrap="wrap">
                      {(['approve', 'reject', 'retract'] as const).map(
                        (action) =>
                          controlStanding(request, operator)[action] && (
                            <Button
                              type="button"
                              key={action}
                              variant="outline"
                              data-testid={`maker-control-${action}-${request.id}`}
                              onClick={() =>
                                hold({
                                  kind: 'decision',
                                  action,
                                  id: request.id,
                                  marketId: market.id,
                                })
                              }
                            >
                              {decisionLabel(action)}
                            </Button>
                          ),
                      )}
                    </HStack>
                  </Stack>
                </Card.Body>
              </Card.Root>
            ))}
          {list.isSuccess && !list.data.pages.some((p) => p.items.length) && (
            <Text>{copy.makerControlsEmpty}</Text>
          )}
          {list.hasNextPage && (
            <>
              <LoadMoreFailed
                list={list}
                message={copy.makerControlsReadFailed}
                data-testid="maker-controls-requests-more-failed"
              />
              <Button
                type="button"
                loading={list.isFetchingNextPage}
                disabled={list.isFetching}
                onClick={() => void list.fetchNextPage()}
              >
                {copy.loadMore}
              </Button>
            </>
          )}
          <Text fontWeight="semibold">{copy.makerControlsHistory}</Text>
          {readFailed(history) && (
            <ReadFailure retry={() => void history.refetch()} busy={history.isFetching} />
          )}
          {history.data?.pages
            .flatMap((p) => p.items)
            .map((row) => (
              <Text key={row.approvalId}>
                {CONTROL_LABEL[row.action]} · {formatKst(row.performedAt)} ·{' '}
                {copy.makerControlsGeneration} {row.beforeControlGeneration} →{' '}
                {row.afterControlGeneration}
                {row.additionalCoin !== null ? ` · +${row.additionalCoin} Coin` : ''}
              </Text>
            ))}
          {history.isSuccess && !history.data.pages.some((p) => p.items.length) && (
            <Text>{copy.makerControlsHistoryEmpty}</Text>
          )}
          {history.hasNextPage && (
            <>
              <LoadMoreFailed
                list={history}
                message={copy.makerControlsReadFailed}
                data-testid="maker-controls-history-more-failed"
              />
              <Button
                type="button"
                loading={history.isFetchingNextPage}
                disabled={history.isFetching}
                onClick={() => void history.fetchNextPage()}
              >
                {copy.loadMore}
              </Button>
            </>
          )}
          {target?.kind === 'request' && (
            <RequestDialog target={target} onClose={() => hold(null)} />
          )}
          {target?.kind === 'decision' && (
            <ControlDecisionDialog {...target} onClose={() => hold(null)} />
          )}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/** One inbox for cleanup and independent decisions across markets, without exposing it publicly. */
export function MarketMakerControlInbox() {
  const operator = useOperatorId();
  const [all, setAll] = useState(false);
  const list = useMarketMakerControlRequests(operator, undefined, all);
  const [target, hold] = useHeldForOperator<Extract<Target, { kind: 'decision' }>>();
  return (
    <Card.Root data-testid="maker-controls-inbox">
      <Card.Header>
        <Card.Title>{copy.makerControlsTitle}</Card.Title>
        <Card.Description>{copy.makerControlsHelp}</Card.Description>
      </Card.Header>
      <Card.Body>
        <Stack gap="4">
          <HStack>
            <Button type="button" variant={all ? 'outline' : 'solid'} onClick={() => setAll(false)}>
              {copy.makerControlsPending}
            </Button>
            <Button type="button" variant={all ? 'solid' : 'outline'} onClick={() => setAll(true)}>
              {copy.makerControlsAll}
            </Button>
          </HStack>
          {readFailed(list) && (
            <ReadFailure retry={() => void list.refetch()} busy={list.isFetching} />
          )}
          {list.data?.pages
            .flatMap((p) => p.items)
            .map((request) => (
              <Card.Root key={request.id}>
                <Card.Body>
                  <Stack>
                    <Button asChild variant="outline" alignSelf="start">
                      <NextLink href={`/admin/markets/${request.marketId}`}>
                        {copy.makerMetricsMarket}
                      </NextLink>
                    </Button>
                    <ControlRequestFacts request={request} />
                    <HStack flexWrap="wrap">
                      {(['approve', 'reject', 'retract'] as const).map(
                        (action) =>
                          controlStanding(request, operator)[action] && (
                            <Button
                              type="button"
                              variant="outline"
                              key={action}
                              onClick={() =>
                                hold({
                                  kind: 'decision',
                                  id: request.id,
                                  marketId: request.marketId,
                                  action,
                                })
                              }
                            >
                              {decisionLabel(action)}
                            </Button>
                          ),
                      )}
                    </HStack>
                  </Stack>
                </Card.Body>
              </Card.Root>
            ))}
          {list.isSuccess && !list.data.pages.some((p) => p.items.length) && (
            <Text>{copy.makerControlsEmpty}</Text>
          )}
          {list.hasNextPage && (
            <>
              <LoadMoreFailed
                list={list}
                message={copy.makerControlsReadFailed}
                data-testid="maker-controls-inbox-more-failed"
              />
              <Button
                type="button"
                loading={list.isFetchingNextPage}
                disabled={list.isFetching}
                onClick={() => void list.fetchNextPage()}
              >
                {copy.loadMore}
              </Button>
            </>
          )}
          {target && <ControlDecisionDialog {...target} onClose={() => hold(null)} />}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}
