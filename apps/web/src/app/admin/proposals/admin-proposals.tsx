'use client';

import {
  Alert,
  Badge,
  Button,
  Field,
  HStack,
  Link as ChakraLink,
  NativeSelect,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { PROPOSAL_STATUSES, type ProposalStatus } from '@buddha/shared';
import NextLink from 'next/link';
import { useState } from 'react';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useAdminProposals } from '@/hooks/use-admin-proposals';
import { formatKst } from '@/lib/datetime';
import {
  PROPOSAL_STATUS_LABEL,
  PROPOSAL_STATUS_PALETTE,
  formatProposalDate,
  proposalActorName,
} from '@/lib/proposals';

/**
 * 시장 제안 목록 (#77, ADR-0089): every proposal, newest first, with a status filter (모든 상태 or one
 * of the five), 20 per page with 더 보기. Each row: the question (to its detail), the status, the
 * proposer's nickname, the date its result is known and when it was proposed — in KST, as every
 * admin time (ADR-0063). The proposer is named here and on the detail only: the operators see who
 * proposed, nobody else does (ADR-0069 decision 4 #77 공개 범위). A 더 보기 that failed keeps the
 * proposals read so far and says so above its button (`LoadMoreFailed`, the first read's
 * `copy.errUnknown` — owner decision 2026-10-20 7, ADR-0075 5-14, as every 더 보기 list); only a
 * first read that failed (`isLoadingError`) shows the error.
 */
export function AdminProposals() {
  const [status, setStatus] = useState<ProposalStatus | ''>('');
  const proposals = useAdminProposals(status);
  const rows = proposals.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Stack gap="4">
      {/* A Field, so the label's `htmlFor` names the select (admin-markets.tsx). */}
      <Field.Root orientation="horizontal" w="auto" gap="2">
        <Field.Label flex="0 0 auto">{copy.adminMarketStatusFilter}</Field.Label>
        <NativeSelect.Root maxW="48" size="sm">
          <NativeSelect.Field
            value={status}
            onChange={(event) => setStatus(event.target.value as ProposalStatus | '')}
            data-testid="admin-proposal-status-filter"
          >
            <option value="">{copy.adminProposalStatusAll}</option>
            {PROPOSAL_STATUSES.map((value) => (
              <option key={value} value={value}>
                {PROPOSAL_STATUS_LABEL[value]}
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
      </Field.Root>

      {proposals.isPending ? (
        <Skeleton height="24" />
      ) : proposals.isLoadingError ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : rows.length === 0 ? (
        <Text color="fg.muted" data-testid="admin-proposals-empty">
          {copy.adminNoProposals}
        </Text>
      ) : (
        <Stack gap="2" data-testid="admin-proposals-list">
          {proposals.isRefetchError && (
            <Alert.Root status="warning" role="status" data-testid="admin-proposals-stale">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
              </Alert.Content>
              <Button
                size="xs"
                variant="outline"
                ml="auto"
                onClick={() => void proposals.refetch()}
              >
                {copy.retry}
              </Button>
            </Alert.Root>
          )}
          {rows.map((proposal) => (
            <Stack
              key={proposal.id}
              gap="0.5"
              borderWidth="1px"
              borderRadius="l2"
              p="3"
              data-testid={`admin-proposal-${proposal.id}`}
            >
              <HStack gap="2" flexWrap="wrap">
                <Badge colorPalette={PROPOSAL_STATUS_PALETTE[proposal.status]} variant="subtle">
                  {PROPOSAL_STATUS_LABEL[proposal.status]}
                </Badge>
                <ChakraLink asChild fontWeight="semibold" wordBreak="break-word">
                  <NextLink href={`/admin/proposals/${proposal.id}`}>{proposal.question}</NextLink>
                </ChakraLink>
              </HStack>
              <Text fontSize="xs" color="fg.muted">
                {copy.adminProposalProposer} {proposalActorName(proposal.proposer)} ·{' '}
                {copy.proposalDeadline} {formatProposalDate(proposal.deadline)} ·{' '}
                {copy.proposalSubmittedAt} {formatKst(proposal.createdAt)}
              </Text>
            </Stack>
          ))}
          {proposals.hasNextPage && (
            <>
              <LoadMoreFailed
                list={proposals}
                message={copy.errUnknown}
                data-testid="admin-proposals-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={proposals.isFetchingNextPage}
                onClick={() => void proposals.fetchNextPage()}
                data-testid="admin-proposals-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
}
