'use client';

import { Alert, Button, Skeleton, Stack, Text } from '@chakra-ui/react';
import { useState } from 'react';
import { DisputeItem, DisputeRetractDialog } from '@/components/disputes/dispute-item';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMyDisputes, useRetractDispute } from '@/hooks/use-disputes';
import { useMe } from '@/hooks/use-me';
import { type MyDispute } from '@/lib/api';
import { disputeRetractFailureMessage } from '@/lib/disputes';
import { listSection } from '@/lib/query-client';
import { watchlistRows } from '@/lib/watchlist';
import { LoadFailed, Section, SessionEnded, useSessionEnded } from '../portfolio';
import { ProfileUnavailable } from '../settings/profile-unavailable';

/** What the list's body reads of `useMyDisputes` (a test draws it from a list of its own). */
export type Disputes = Pick<
  ReturnType<typeof useMyDisputes>,
  | 'data'
  | 'hasNextPage'
  | 'isPending'
  | 'isLoadingError'
  | 'isRefetchError'
  | 'error'
  | 'isFetchNextPageError'
  | 'isFetchingNextPage'
  | 'failureReason'
  | 'refetch'
  | 'fetchNextPage'
>;

/**
 * `/my/disputes`: MY '판정 이의' (#175, ADR-0104). The member's own 판정 이의, newest first, each
 * with its market (to its detail), its status (검토 중 · 기각 · 수용 · 철회 · 정정으로 종결, #176), the
 * decision's reason and time (#173 item 7), a line once the market's judgement was corrected past
 * its version (`disputeNote`, #176, ADR-0105), what it submitted (folded) and 철회 while it is
 * pending and its deadline ahead (`retractable`). Never who decided it: the API does not send it
 * (#173 item 13). Personal and client-only like every MY list.
 */
export function MyDisputes() {
  const ended = useSessionEnded();
  const accountId = useMe().data?.id;
  // The list of the account MY shows (ADR-0091, `myDisputesKey`): it waits for `GET /me`.
  const disputes = useMyDisputes(accountId);
  if (ended) return <SessionEnded />;
  return (
    <Section title={copy.myDisputes} testId="my-disputes">
      <Stack gap="4">
        <Text fontSize="sm" color="fg.muted" data-testid="my-disputes-intro">
          {copy.myDisputesIntro}
        </Text>
        {/* Keyed by MY's account (`DisputesBody`); the list waits for it, and a failed `GET /me`
            says so with 다시 시도 rather than a skeleton that never ends. */}
        {accountId === undefined ? (
          <ProfileUnavailable height="24" />
        ) : (
          <DisputesBody key={accountId} disputes={disputes} accountId={accountId} />
        )}
      </Stack>
    </Section>
  );
}

/**
 * The list's body: the other MY lists' ladder (`listSection`) — skeleton, error and 다시 시도,
 * empty, rows, and a refresh that failed after the rows exist keeps them under a notice — and 더
 * 보기 while there is a next page, a 더 보기 that failed keeping the rows read so far and saying so
 * above its button (`LoadMoreFailed`, the first read's `copy.errUnknown`).
 *
 * A 철회 names the account of MY's `Me` (`accountId`, the screen's), never the session's
 * (ADR-0091), and the body is keyed by it: `['me']` can turn from A to B in place (ADR-0090 결정
 * 4-2), and a dispute picked from A's list for the 철회 dialog is not B's to confirm. The list can
 * come before `GET /me`, so 철회 and its confirmation are off until that account is known.
 */
export function DisputesBody({
  disputes,
  accountId,
}: {
  disputes: Disputes;
  /** MY's account, once `GET /me` has answered. */
  accountId: string | undefined;
}) {
  const { rows, more } = watchlistRows(disputes.data?.pages, disputes.hasNextPage, undefined);
  const section = listSection(disputes, rows.length);
  const retract = useRetractDispute();
  const [retracting, setRetracting] = useState<MyDispute | null>(null);

  const confirmRetract = () => {
    if (retracting === null || accountId === undefined) return;
    retract.mutate(
      // The account the list was drawn for rides along (`expectedAccountId`, A-PG-24).
      { id: retracting.id, marketId: retracting.market.id, expectedAccountId: accountId },
      {
        onSuccess: () => {
          toaster.create({ type: 'success', title: copy.disputeRetracted });
          setRetracting(null);
        },
        onError: (error) => {
          toaster.create({ type: 'error', title: disputeRetractFailureMessage(error) });
          setRetracting(null);
        },
      },
    );
  };

  return (
    <>
      {section.stale && (
        <Alert.Root status="warning" role="status" data-testid="my-disputes-stale" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void disputes.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {section.body === 'pending' ? (
        <Skeleton height="24" />
      ) : section.body === 'failed' ? (
        <LoadFailed message={copy.errUnknown} onRetry={() => void disputes.refetch()} />
      ) : section.body === 'empty' ? (
        <EmptyState message={copy.myDisputesEmpty} data-testid="my-disputes-empty" />
      ) : (
        <Stack gap="3" data-testid="my-disputes-list">
          {rows.map((dispute) => (
            <DisputeItem
              key={dispute.id}
              dispute={dispute}
              showMarket
              accountKnown={accountId !== undefined}
              onRetract={() => setRetracting(dispute)}
            />
          ))}
          {more && (
            <>
              <LoadMoreFailed
                list={disputes}
                message={copy.errUnknown}
                data-testid="my-disputes-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={disputes.isFetchingNextPage}
                onClick={() => void disputes.fetchNextPage()}
                data-testid="my-disputes-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </Stack>
      )}
      <DisputeRetractDialog
        dispute={retracting}
        pending={retract.isPending}
        confirmDisabled={accountId === undefined}
        onClose={() => setRetracting(null)}
        onConfirm={confirmRetract}
      />
    </>
  );
}
