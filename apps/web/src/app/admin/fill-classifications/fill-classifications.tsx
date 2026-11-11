'use client';
import {
  Alert,
  Button,
  Card,
  Field,
  Heading,
  HStack,
  Input,
  Link,
  NativeSelect,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import {
  useMutation,
  useQueryClient,
  type MutationOptions,
  type QueryClient,
} from '@tanstack/react-query';
import { classificationFillIdSchema, approvalReasonSchema, formatCoin } from '@buddha/shared';
import { useState } from 'react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import {
  CLASSIFICATIONS_KEY,
  applyClassificationWrite,
  useClassifiableFill,
  useClassificationRequest,
  useClassificationRequests,
  useClassificationHistory,
} from '@/hooks/use-fill-classifications';
import {
  api,
  unwrap,
  isApiError,
  type AdminClassifiableFill,
  type FillClassificationRequest,
  type FillClassificationWrite,
} from '@/lib/api';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';
import { toaster } from '@/components/ui/toaster';
import { readFailed } from '@/lib/query-client';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { ReviewDialogShell, ReasonField } from '../markets/[id]/market-review-dialogs';

type Decision = 'approve' | 'reject' | 'retract';
type Target =
  | { kind: 'request'; action: 'mark' | 'clear'; fill: AdminClassifiableFill }
  | { kind: 'decision'; action: Decision; fillId: string; id: string };
const ACTION = { mark: copy.classificationsMarkAction, clear: copy.classificationsClearAction };
const STATUS = {
  pending: copy.classificationsPending,
  approved: copy.classificationsApproved,
  rejected: copy.classificationsRejected,
  retracted: copy.classificationsRetracted,
};
const DECISION = {
  approve: copy.classificationsApprove,
  reject: copy.classificationsReject,
  retract: copy.classificationsRetract,
};
function ReadFailure({ retry, busy }: { retry: () => void; busy: boolean }) {
  return (
    <Stack>
      <Alert.Root status="error">
        <Alert.Indicator />
        <Alert.Description>{copy.classificationsReadFailed}</Alert.Description>
      </Alert.Root>
      <Button type="button" variant="outline" loading={busy} disabled={busy} onClick={retry}>
        {copy.retry}
      </Button>
    </Stack>
  );
}
export function ClassifiableFillFacts({ fill }: { fill: AdminClassifiableFill }) {
  return (
    <Stack gap="2" data-testid="classification-fill-facts">
      <Link asChild>
        <NextLink href={`/admin/markets/${fill.marketId}`}>{fill.marketTitle}</NextLink>
      </Link>
      <Text overflowWrap="anywhere">
        {copy.classificationsFillId}: {fill.id}
      </Text>
      <Text>
        {fill.outcome} · {fill.priceCoin} Coin · {fill.qty} · {formatCoin(BigInt(fill.amountCoin))}{' '}
        Coin
      </Text>
      <Text>{formatKst(fill.createdAt)}</Text>
      <Text fontWeight="medium">
        {fill.excluded ? copy.classificationsExcluded : copy.classificationsNormal}
      </Text>
    </Stack>
  );
}
function RequestFacts({ request }: { request: FillClassificationRequest }) {
  return (
    <Stack gap="2">
      <Text>
        {ACTION[request.payload.action]} · {STATUS[request.status]}
      </Text>
      <Text overflowWrap="anywhere">
        {copy.classificationsFillId}: {request.payload.fillId}
      </Text>
      <Text>
        {copy.classificationsRequester}: {nicknameShown(request.requestedBy.nickname)} ·{' '}
        {formatKst(request.requestedAt)}
      </Text>
      <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
        {request.reason}
      </Text>
      {request.decisionReason && (
        <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
          {request.decisionReason}
        </Text>
      )}
    </Stack>
  );
}
/** Shared by both dialogs; exported so the actual callbacks run under MutationObserver tests. */
export function classificationWriteOptions(
  client: QueryClient,
  send: (operator: string) => Promise<FillClassificationWrite>,
  close: () => void,
  sessionChanged: (error: unknown) => boolean,
  setRefusal: (message: string | null) => void,
): MutationOptions<FillClassificationWrite, unknown, string> {
  return {
    mutationFn: send,
    onMutate: () => setRefusal(null),
    onSuccess: async (fresh, operator) => {
      if (client.getQueryData<{ id: string }>(['me'])?.id !== operator) return;
      if (!(await applyClassificationWrite(client, operator, fresh))) return;
      if (client.getQueryData<{ id: string }>(['me'])?.id !== operator) return;
      toaster.create({ type: 'success', title: copy.classificationsSaved });
      close();
      void client.invalidateQueries({ queryKey: [...CLASSIFICATIONS_KEY, operator] });
    },
    onError: (error, operator) => {
      if (client.getQueryData<{ id: string }>(['me'])?.id !== operator) return;
      if (sessionChanged(error)) {
        close();
        return;
      }
      if (isApiError(error, 'FORBIDDEN') || isApiError(error, 'UNAUTHENTICATED')) {
        close();
        return;
      }
      setRefusal(copy.classificationsFailure);
      void client.invalidateQueries({ queryKey: CLASSIFICATIONS_KEY });
    },
  };
}
function useWrite(send: (operator: string) => Promise<FillClassificationWrite>, close: () => void) {
  const client = useQueryClient(),
    sessionChanged = useSessionChanged();
  const [refusal, setRefusal] = useState<string | null>(null);
  const mutation = useMutation(
    classificationWriteOptions(client, send, close, sessionChanged, setRefusal),
  );
  return { mutation, refusal };
}
export function RequestDialog({
  target,
  onClose,
}: {
  target: Extract<Target, { kind: 'request' }>;
  onClose: () => void;
}) {
  const operator = useOperatorId();
  const [base] = useState(target.fill);
  const [reason, setReason] = useState('');
  const query = useClassifiableFill(operator, base.id);
  const stale = !query.data || query.data.classificationRevision !== base.classificationRevision;
  const ready =
    !!operator && !query.isError && !stale && approvalReasonSchema.safeParse(reason).success;
  const { mutation, refusal } = useWrite(
    async (by) =>
      unwrap(
        await api.POST('/api/v1/admin/fills/{fillId}/classification-requests', {
          params: { path: { fillId: base.id } },
          body: {
            expectedAccountId: by,
            action: target.action,
            baseRevision: base.classificationRevision,
            reason: reason.trim(),
          },
        }),
      ).data,
    onClose,
  );
  return (
    <ReviewDialogShell
      testId="classification-request-dialog"
      title={ACTION[target.action]}
      body={copy.classificationsFixed}
      confirmLabel={copy.classificationsRequest}
      pending={mutation.isPending}
      confirmDisabled={!ready || mutation.isPending}
      refusal={refusal ?? (stale && query.isSuccess ? copy.classificationsStale : null)}
      onClose={onClose}
      onConfirm={() => {
        if (ready && operator && !mutation.isPending) mutation.mutate(operator);
      }}
    >
      <ClassifiableFillFacts fill={base} />
      <Text>{copy.classificationsEffect}</Text>
      {query.isError && <ReadFailure retry={() => void query.refetch()} busy={query.isFetching} />}
      <ReasonField
        testId="classification-reason"
        label={copy.classificationsReason}
        hint={copy.classificationsPrivacy}
        value={reason}
        onChange={setReason}
        error={null}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}
export function DecisionDialog({
  target,
  onClose,
}: {
  target: Extract<Target, { kind: 'decision' }>;
  onClose: () => void;
}) {
  const operator = useOperatorId(),
    query = useClassificationRequest(operator, target.fillId, target.id);
  const [request, setRequest] = useState<FillClassificationRequest | null>(null),
    [reason, setReason] = useState('');
  if (!request && query.data) setRequest(query.data.request);
  const current = query.data?.request,
    action = target.action;
  const stale =
    !!request &&
    !!query.data &&
    request.payload.baseRevision !== query.data.fill.classificationRevision;
  const own = !!operator && request?.requestedBy.id === operator;
  const allowed =
    !!request &&
    current?.status === 'pending' &&
    (action === 'retract' ? own : !own) &&
    (action !== 'approve' || !stale);
  const ready =
    !!operator &&
    allowed &&
    !query.isError &&
    (action === 'retract' || approvalReasonSchema.safeParse(reason).success);
  const { mutation, refusal } = useWrite(async (by) => {
    const params = { path: { fillId: target.fillId, requestId: target.id } };
    if (action === 'retract')
      return unwrap(
        await api.POST('/api/v1/admin/fills/{fillId}/classification-requests/{requestId}/retract', {
          params,
          body: { expectedAccountId: by },
        }),
      ).data;
    if (action === 'reject')
      return unwrap(
        await api.POST('/api/v1/admin/fills/{fillId}/classification-requests/{requestId}/reject', {
          params,
          body: { expectedAccountId: by, reason: reason.trim() },
        }),
      ).data;
    return unwrap(
      await api.POST('/api/v1/admin/fills/{fillId}/classification-requests/{requestId}/approve', {
        params,
        body: { expectedAccountId: by, reason: reason.trim() },
      }),
    ).data;
  }, onClose);
  return (
    <ReviewDialogShell
      testId={`classification-${action}-dialog`}
      title={DECISION[action]}
      body={copy.classificationsFixed}
      confirmLabel={DECISION[action]}
      pending={mutation.isPending}
      confirmDisabled={!ready || mutation.isPending}
      refusal={refusal ?? (stale && action === 'approve' ? copy.classificationsStale : null)}
      onClose={onClose}
      onConfirm={() => {
        if (ready && operator && !mutation.isPending) mutation.mutate(operator);
      }}
    >
      {query.isError && <ReadFailure retry={() => void query.refetch()} busy={query.isFetching} />}
      {request ? (
        <RequestFacts request={request} />
      ) : query.isSuccess ? (
        <Text>{copy.classificationsNotFound}</Text>
      ) : (
        <Skeleton height="20" />
      )}
      <Text>{copy.classificationsEffect}</Text>
      {action !== 'retract' && (
        <ReasonField
          testId="classification-decision-reason"
          label={copy.classificationsDecisionReason}
          hint={copy.classificationsPrivacy}
          value={reason}
          onChange={setReason}
          error={null}
          disabled={mutation.isPending}
        />
      )}
    </ReviewDialogShell>
  );
}
export function FillClassificationScreen({ fillId }: { fillId?: string }) {
  const operator = useOperatorId(),
    [all, setAll] = useState(false),
    [lookup, setLookup] = useState('');
  const valid = fillId === undefined || classificationFillIdSchema.safeParse(fillId).success;
  const fill = useClassifiableFill(operator, valid ? (fillId ?? '') : '');
  const requests = useClassificationRequests(valid ? operator : undefined, fillId, all);
  const history = useClassificationHistory(valid ? operator : undefined, fillId ?? '');
  const [target, setTarget] = useHeldForOperator<Target>();
  const records = requests.data?.pages.flatMap((p) => p.items) ?? [];
  const lookupValid = classificationFillIdSchema.safeParse(lookup.trim()).success;
  return (
    <Stack gap="6" data-testid="fill-classification-screen">
      <Heading>{copy.classificationsTitle}</Heading>
      <Text>{copy.classificationsPolicy}</Text>
      <Text>{copy.classificationsEffect}</Text>
      <Text color="fg.muted">{copy.classificationsPrivacy}</Text>
      <Field.Root>
        <Field.Label>{copy.classificationsFillId}</Field.Label>
        <HStack align="stretch">
          <Input inputMode="numeric" value={lookup} onChange={(e) => setLookup(e.target.value)} />
          {lookupValid ? (
            <Button asChild>
              <NextLink href={`/admin/fills/${lookup.trim()}`}>{copy.classificationsFind}</NextLink>
            </Button>
          ) : (
            <Button disabled>{copy.classificationsFind}</Button>
          )}
        </HStack>
      </Field.Root>
      {!valid && <Text>{copy.classificationsNotFound}</Text>}
      {fillId && valid && (
        <Card.Root>
          <Card.Body>
            <Stack gap="3">
              {fill.isError && (
                <ReadFailure retry={() => void fill.refetch()} busy={fill.isFetching} />
              )}
              {fill.data ? (
                <>
                  <ClassifiableFillFacts fill={fill.data} />
                  <Button
                    alignSelf="start"
                    disabled={!operator || fill.isError}
                    onClick={() =>
                      setTarget({
                        kind: 'request',
                        action: fill.data.excluded ? 'clear' : 'mark',
                        fill: fill.data,
                      })
                    }
                  >
                    {fill.data.excluded ? copy.classificationsClear : copy.classificationsMark}
                  </Button>
                </>
              ) : (
                !fill.isError && <Skeleton height="20" />
              )}
            </Stack>
          </Card.Body>
        </Card.Root>
      )}
      <NativeSelect.Root maxW="xs">
        <NativeSelect.Field
          aria-label={copy.classificationsTitle}
          value={all ? 'all' : 'pending'}
          onChange={(e) => setAll(e.target.value === 'all')}
        >
          <option value="pending">{copy.classificationsPending}</option>
          <option value="all">{copy.classificationsAll}</option>
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
      {readFailed(requests) && (
        <ReadFailure retry={() => void requests.refetch()} busy={requests.isFetching} />
      )}
      {requests.isPending && valid && <Skeleton height="20" />}
      {requests.isSuccess && records.length === 0 && <Text>{copy.classificationsEmpty}</Text>}
      {records.map((request) => (
        <Card.Root key={request.id} data-testid={`classification-request-${request.id}`}>
          <Card.Body>
            <Stack gap="3">
              <RequestFacts request={request} />
              <Link asChild>
                <NextLink href={`/admin/fills/${request.payload.fillId}`}>
                  {copy.classificationsFind}
                </NextLink>
              </Link>
              {request.status === 'pending' && operator && (
                <HStack flexWrap="wrap">
                  {(request.requestedBy.id === operator
                    ? ['retract']
                    : (['approve', 'reject'] as Decision[])
                  ).map((action) => (
                    <Button
                      key={action}
                      type="button"
                      onClick={() =>
                        setTarget({
                          kind: 'decision',
                          action: action as Decision,
                          fillId: request.payload.fillId,
                          id: request.id,
                        })
                      }
                    >
                      {DECISION[action as Decision]}
                    </Button>
                  ))}
                </HStack>
              )}
            </Stack>
          </Card.Body>
        </Card.Root>
      ))}
      {requests.hasNextPage && (
        <>
          <LoadMoreFailed
            list={requests}
            message={copy.classificationsReadFailed}
            data-testid="classifications-more-failed"
          />
          <Button
            loading={requests.isFetchingNextPage}
            onClick={() => void requests.fetchNextPage()}
          >
            {copy.loadMore}
          </Button>
        </>
      )}
      {fillId && valid && (
        <Stack>
          <Heading size="md">{copy.classificationsHistory}</Heading>
          {readFailed(history) && (
            <ReadFailure retry={() => void history.refetch()} busy={history.isFetching} />
          )}
          {history.data?.pages
            .flatMap((p) => p.items)
            .map((item) => (
              <Card.Root key={item.revision}>
                <Card.Body>
                  <Stack>
                    <Text>
                      {ACTION[item.action]} · {formatKst(item.performedAt)}
                    </Text>
                    <Text>
                      {copy.classificationsRequester}: {nicknameShown(item.requestedBy.nickname)} /{' '}
                      {copy.classificationsApprover}: {nicknameShown(item.approvedBy.nickname)}
                    </Text>
                    <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
                      {item.reason}
                    </Text>
                    <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
                      {item.decisionReason}
                    </Text>
                  </Stack>
                </Card.Body>
              </Card.Root>
            ))}
          {history.isSuccess && history.data.pages.every((p) => p.items.length === 0) && (
            <Text>{copy.classificationsEmpty}</Text>
          )}
          {history.hasNextPage && (
            <>
              <LoadMoreFailed
                list={history}
                message={copy.classificationsReadFailed}
                data-testid="classification-history-more-failed"
              />
              <Button
                loading={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </Stack>
      )}
      {target?.kind === 'request' && (
        <RequestDialog target={target} onClose={() => setTarget(null)} />
      )}
      {target?.kind === 'decision' && (
        <DecisionDialog target={target} onClose={() => setTarget(null)} />
      )}
    </Stack>
  );
}
