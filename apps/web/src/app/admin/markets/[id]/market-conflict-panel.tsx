'use client';

import { Alert, Button, Card, Checkbox, Heading, Skeleton, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  applyMarketConflictWrite,
  marketConflictsKey,
  useMarketConflicts,
} from '@/hooks/use-market-conflicts';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { nicknameShown } from '@/lib/account-closure';
import {
  api,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  unwrap,
  validationMessage,
} from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { reviewReasonDraft } from '@/lib/market-review';
import { ReasonField, ReviewDialogShell } from './market-review-dialogs';

/** Every substantive decision asks anew; no checked value survives a form or operator change. */
export function NoConflictConfirmation({
  checked,
  onChecked,
  disabled,
  testId,
  blocked = false,
}: {
  checked: boolean;
  onChecked: (checked: boolean) => void;
  disabled?: boolean;
  testId: string;
  blocked?: boolean;
}) {
  return (
    <Stack gap="2">
      {blocked && (
        <Text role="status" color="fg.error">
          {copy.marketConflictRefused}
        </Text>
      )}
      <Checkbox.Root
        checked={checked && !blocked}
        onCheckedChange={(value) => onChecked(value.checked === true)}
        disabled={disabled || blocked}
        data-testid={testId}
        alignItems="start"
      >
        <Checkbox.HiddenInput />
        <Checkbox.Control />
        <Checkbox.Label>{copy.marketConflictConfirm}</Checkbox.Label>
      </Checkbox.Root>
    </Stack>
  );
}

export function MarketConflictPanel({ marketId }: { marketId: string }) {
  const operatorId = useOperatorId();
  const result = useMarketConflicts(marketId);
  const [declaring, setDeclaring] = useHeldForOperator<boolean>();
  const data = result.data;
  return (
    <Card.Root data-testid="market-conflicts">
      <Card.Header>
        <Heading size="md">{copy.marketConflictTitle}</Heading>
      </Card.Header>
      <Card.Body>
        <Stack gap="3">
          <Text fontSize="sm">{copy.marketConflictPolicy}</Text>
          {result.isPending ? (
            <Skeleton height="12" />
          ) : data === undefined ? (
            <Alert.Root status="error" role="alert">
              <Alert.Content>
                <Alert.Description>{copy.errUnknown}</Alert.Description>
              </Alert.Content>
              <Button size="xs" onClick={() => void result.refetch()}>
                {copy.retry}
              </Button>
            </Alert.Root>
          ) : (
            <>
              {result.isRefetchError && (
                <Text role="status" color="fg.error">
                  {copy.adminMarketRefreshFailed}
                </Text>
              )}
              <Text data-testid="market-conflict-status">
                {data.operator.hasFill
                  ? copy.marketConflictFill
                  : data.operator.declaration !== null
                    ? copy.marketConflictDeclared
                    : copy.marketConflictNone}
              </Text>
              <Button
                size="sm"
                alignSelf="start"
                variant="outline"
                data-testid="market-conflict-declare"
                disabled={
                  operatorId === undefined ||
                  data.operator.userId !== operatorId ||
                  data.operator.declaration !== null
                }
                onClick={() => setDeclaring(true)}
              >
                {copy.marketConflictDeclare}
              </Button>
              <Text fontWeight="medium">{copy.marketConflictDeclarations}</Text>
              {data.declarations.length === 0 ? (
                <Text color="fg.muted">{copy.marketConflictEmpty}</Text>
              ) : (
                data.declarations.map((item) => (
                  <Stack key={item.id} gap="1" borderWidth="1px" borderRadius="l2" p="3">
                    <Text fontSize="sm">
                      {nicknameShown(item.declaredBy.nickname)} · {formatKst(item.declaredAt)}
                    </Text>
                    <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
                      {item.reason}
                    </Text>
                  </Stack>
                ))
              )}
            </>
          )}
          {declaring && (
            <ConflictDeclarationDialog marketId={marketId} onClose={() => setDeclaring(null)} />
          )}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

function ConflictDeclarationDialog({
  marketId,
  onClose,
}: {
  marketId: string;
  onClose: () => void;
}) {
  const operatorId = useOperatorId();
  const client = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [reason, setReason] = useState('');
  const draft = reviewReasonDraft(reason);
  const [refusal, setRefusal] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async ({ by, reason }: { by: string; reason: string }) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/conflicts', {
          params: { path: { id: marketId } },
          body: { expectedAccountId: by, reason },
        }),
      ).data,
    onSuccess: async (fresh) => {
      const refreshed = applyMarketConflictWrite(client, fresh);
      toaster.create({ type: 'success', title: copy.marketConflictDeclaredDone });
      onClose();
      await refreshed;
    },
    onError: (error) => {
      sessionChanged(error);
      if (isForAnotherAccount(error)) {
        onClose();
        toaster.create({ type: 'error', title: copy.sessionChanged });
        return;
      }
      setRefusal(
        isApiError(error, 'FORBIDDEN')
          ? copy.adminOnly
          : isApiError(error) && validationMessage(error) === 'already_declared'
            ? copy.marketConflictAlreadyDeclared
            : isApiUnreachable(error)
              ? copy.errNetwork
              : copy.errUnknown,
      );
      void client.invalidateQueries({ queryKey: marketConflictsKey(marketId, operatorId) });
    },
  });
  return (
    <ReviewDialogShell
      testId="market-conflict-declare-dialog"
      title={copy.marketConflictDeclare}
      body={copy.marketConflictDeclareHint}
      confirmLabel={copy.marketConflictDeclare}
      pending={mutation.isPending}
      confirmDisabled={operatorId === undefined || draft.error !== null}
      refusal={refusal}
      onClose={onClose}
      onConfirm={() => {
        if (operatorId !== undefined && draft.error === null)
          mutation.mutate({ by: operatorId, reason: draft.reason });
      }}
    >
      <ReasonField
        testId="market-conflict-reason"
        label={copy.marketConflictReason}
        hint={copy.marketConflictReasonHint}
        value={reason}
        onChange={setReason}
        error={reason !== '' ? draft.error : null}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}
