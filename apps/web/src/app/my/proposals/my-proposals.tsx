'use client';

import {
  Alert,
  Badge,
  Box,
  Button,
  DataList,
  HStack,
  Heading,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useState } from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useMyProposals, useRetractProposal } from '@/hooks/use-proposals';
import { type Proposal } from '@/lib/api';
import {
  MY_PROPOSALS_PATH,
  NEW_PROPOSAL_PATH,
  PROPOSAL_REJECTION_REASON_LABEL,
  PROPOSAL_STATUS_LABEL,
  PROPOSAL_STATUS_PALETTE,
  PROPOSAL_STATUS_TIME_LABEL,
  canRetractProposal,
  formatProposalDate,
  retractFailureMessage,
} from '@/lib/proposals';
import { listSection } from '@/lib/query-client';
import { watchlistRows } from '@/lib/watchlist';
import { LoadFailed, Section, SessionEnded, useSessionEnded } from '../portfolio';

type Proposals = ReturnType<typeof useMyProposals>;

/**
 * `/my/proposals`: 내 제안 (#77, ADR-0089). The member's own proposals, newest first, each with its
 * status (접수·검토·채택·반려·철회) and what the operators said — the 반려's reason and explanation
 * (with the existing market of a 중복, once it is public), the 채택's memo and the market it led to,
 * once that market is public (ADR-0069 decision 4 #77). Never who decided it, never the operators'
 * internal memo: the API does not send them. The notice that a 채택 opens nothing and pays nothing
 * (N05 §6) heads the list, and 철회 is offered on a 접수 proposal only (`canRetractProposal`).
 * Personal and client-only like every MY list.
 */
export function MyProposals() {
  const ended = useSessionEnded();
  const proposals = useMyProposals();
  const accountId = useMe().data?.id;
  if (ended) return <SessionEnded />;
  return (
    <Section title={copy.myProposals} testId="my-proposals">
      <Stack gap="4">
        <Alert.Root status="info" data-testid="my-proposals-notice">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.proposalNotice}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
        <Button asChild size="sm" alignSelf="flex-start" data-testid="my-proposals-new">
          <NextLink href={NEW_PROPOSAL_PATH}>{copy.proposeMarket}</NextLink>
        </Button>
        {/* Keyed by MY's account (`ProposalsBody`). */}
        <ProposalsBody key={accountId} proposals={proposals} accountId={accountId} />
      </Stack>
    </Section>
  );
}

/**
 * The 내 제안 card on the MY summary: the newest `MY_PREVIEW_ROWS` proposals, each its status and
 * question, and 전체 보기 to the page (ADR-0069 decision 4 #77: '내 제안' is linked from the summary).
 * Last on the summary: it is not one of the tabs, whose previews run in the tab bar's order.
 */
export function MyProposalsPreview({ limit }: { limit: number }) {
  const proposals = useMyProposals();
  const accountId = useMe().data?.id;
  return (
    <Section title={copy.myProposals} testId="my-preview-proposals" href={MY_PROPOSALS_PATH}>
      <ProposalsBody key={accountId} proposals={proposals} accountId={accountId} limit={limit} />
    </Section>
  );
}

/**
 * The list's body, for the page and for its preview (`limit`) — one body, so the preview cannot
 * read differently from the page (ADR-0054). The rows and 더 보기 are `watchlistRows`' rule: the
 * page has every proposal with 더 보기 while there is a next page, the preview the newest `limit`
 * and no 더 보기. The ladder is the other MY lists' (`listSection`): skeleton, error and 다시 시도,
 * empty, rows, and a refresh that failed after the rows exist keeps them under a notice. A 더 보기
 * that failed keeps the proposals read so far and says so above its button (`LoadMoreFailed`, the
 * first read's `copy.errUnknown` — owner decision 2026-10-20 7, ADR-0075 5-14, as every 더 보기
 * list); the preview has no 더 보기, so it says nothing of one.
 *
 * A 철회 names the account of MY's `Me` (`accountId`, the screen's — `GET /me/proposals` names no
 * owner), never the session's: in the render between the session naming another account and
 * SessionCacheGuard's reset the session already says B while the list is still A's (ADR-0091).
 * The server refuses it as another account's. Keyed by that account: `['me']` can also turn from A
 * to B in place, before the session does (ADR-0090 결정 4-2), and a proposal picked from A's list
 * for the 철회 dialog is not B's to confirm. The list can come before `GET /me` (both wait for the
 * session alone), so 철회 and its confirmation are off until that account is known: a dialog opened
 * then could only send nothing, and would close as the key turns to the account.
 */
function ProposalsBody({
  proposals,
  accountId,
  limit,
}: {
  proposals: Proposals;
  /** MY's account, once `GET /me` has answered. */
  accountId: string | undefined;
  limit?: number;
}) {
  const { rows, more } = watchlistRows(proposals.data?.pages, proposals.hasNextPage, limit);
  const section = listSection(proposals, rows.length);
  const compact = limit !== undefined;
  const retract = useRetractProposal();
  const [retracting, setRetracting] = useState<Proposal | null>(null);

  const confirmRetract = () => {
    if (retracting === null || accountId === undefined) return;
    retract.mutate(
      // The account the list was drawn for rides along (`expectedAccountId`, A-PG-24).
      { id: retracting.id, expectedAccountId: accountId },
      {
        onSuccess: () => {
          toaster.create({ type: 'success', title: copy.proposalRetracted });
          setRetracting(null);
        },
        onError: (error) => {
          toaster.create({ type: 'error', title: retractFailureMessage(error) });
          setRetracting(null);
        },
      },
    );
  };

  return (
    <>
      {section.stale && (
        <Alert.Root status="warning" role="status" data-testid="my-proposals-stale" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void proposals.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {section.body === 'pending' ? (
        <Skeleton height="24" />
      ) : section.body === 'failed' ? (
        <LoadFailed message={copy.errUnknown} onRetry={() => void proposals.refetch()} />
      ) : section.body === 'empty' ? (
        <EmptyState
          message={copy.myProposalsEmpty}
          action={
            compact ? (
              <Button asChild size="sm" variant="outline">
                <NextLink href={NEW_PROPOSAL_PATH}>{copy.proposeMarket}</NextLink>
              </Button>
            ) : undefined
          }
          data-testid="my-proposals-empty"
        />
      ) : (
        <Stack gap="3" data-testid="my-proposals-list">
          {rows.map((proposal) => (
            <ProposalItem
              key={proposal.id}
              proposal={proposal}
              compact={compact}
              retractable={accountId !== undefined}
              onRetract={() => setRetracting(proposal)}
            />
          ))}
          {more && (
            <>
              <LoadMoreFailed
                list={proposals}
                message={copy.errUnknown}
                data-testid="my-proposals-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={proposals.isFetchingNextPage}
                onClick={() => void proposals.fetchNextPage()}
                data-testid="my-proposals-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </Stack>
      )}
      <ConfirmDialog
        testId="my-proposal-retract"
        open={retracting !== null}
        onClose={() => setRetracting(null)}
        title={copy.proposalRetractTitle}
        confirmLabel={copy.proposalRetract}
        loading={retract.isPending}
        confirmDisabled={accountId === undefined}
        onConfirm={confirmRetract}
      >
        <Stack gap="2">
          <Text fontWeight="medium">{retracting?.question}</Text>
          <Text>{copy.proposalRetractBody}</Text>
        </Stack>
      </ConfirmDialog>
    </>
  );
}

/** A public market a proposal points at: its detail, by its address. */
function MarketLink({
  market,
  testId,
}: {
  market: { slug: string; title: string };
  testId: string;
}) {
  return (
    <ChakraLink asChild colorPalette="brand" color="colorPalette.fg" data-testid={testId}>
      <NextLink href={`/markets/${market.slug}` as Route}>{market.title}</NextLink>
    </ChakraLink>
  );
}

/**
 * One proposal. `compact` (the summary's preview) is the status, the question and the times; the
 * page adds what the operators said, the submitted content (folded, so a long YES condition does
 * not push the next proposal away) and 철회 for a 접수 one. The heading is `h4`, under the section's
 * `h3` on the page and on the summary alike.
 */
function ProposalItem({
  proposal,
  compact,
  retractable,
  onRetract,
}: {
  proposal: Proposal;
  compact: boolean;
  /** Whether the account a 철회 names is known yet (MY's `GET /me`). */
  retractable: boolean;
  onRetract: () => void;
}) {
  const format = useFormatDateTime();
  const { id, status, rejection, adoption } = proposal;
  return (
    <Box
      as="article"
      borderWidth="1px"
      borderRadius="l2"
      p="4"
      data-testid={`my-proposal-${id}`}
      data-status={status}
    >
      <Stack gap="3">
        <Stack gap="1">
          <HStack gap="2" flexWrap="wrap" align="center">
            <Badge
              colorPalette={PROPOSAL_STATUS_PALETTE[status]}
              variant="subtle"
              data-testid={`my-proposal-status-${id}`}
            >
              {PROPOSAL_STATUS_LABEL[status]}
            </Badge>
            <Heading as="h4" size="sm" wordBreak="break-word">
              {proposal.question}
            </Heading>
          </HStack>
          <Text fontSize="xs" color="fg.muted">
            {copy.proposalDeadline} {formatProposalDate(proposal.deadline)} ·{' '}
            {copy.proposalSubmittedAt} {format(proposal.createdAt)}
            {status !== 'submitted' &&
              ` · ${PROPOSAL_STATUS_TIME_LABEL[status]} ${format(proposal.statusChangedAt)}`}
          </Text>
        </Stack>

        {!compact && rejection !== null && (
          <Stack gap="1" fontSize="sm" data-testid={`my-proposal-rejection-${id}`}>
            <Text>
              <Text as="span" fontWeight="semibold">
                {copy.proposalRejectionReason}
              </Text>{' '}
              <Text as="span" data-testid={`my-proposal-reason-${id}`}>
                {PROPOSAL_REJECTION_REASON_LABEL[rejection.reason]}
              </Text>
            </Text>
            <Text whiteSpace="pre-wrap" data-testid={`my-proposal-explanation-${id}`}>
              {rejection.explanation}
            </Text>
            {rejection.duplicateMarket !== null && (
              <Text>
                <Text as="span" fontWeight="semibold">
                  {copy.proposalDuplicateMarket}
                </Text>{' '}
                <MarketLink
                  market={rejection.duplicateMarket}
                  testId={`my-proposal-duplicate-${id}`}
                />
              </Text>
            )}
          </Stack>
        )}

        {!compact && adoption !== null && (adoption.memo !== null || adoption.market !== null) && (
          <Stack gap="1" fontSize="sm" data-testid={`my-proposal-adoption-${id}`}>
            {adoption.memo !== null && (
              <Text>
                <Text as="span" fontWeight="semibold">
                  {copy.proposalAdoptionMemo}
                </Text>{' '}
                <Text as="span" whiteSpace="pre-wrap" data-testid={`my-proposal-memo-${id}`}>
                  {adoption.memo}
                </Text>
              </Text>
            )}
            {adoption.market !== null && (
              <Text>
                <Text as="span" fontWeight="semibold">
                  {copy.proposalMarket}
                </Text>{' '}
                <MarketLink market={adoption.market} testId={`my-proposal-market-${id}`} />
              </Text>
            )}
          </Stack>
        )}

        {!compact && (
          <Box as="details" fontSize="sm" data-testid={`my-proposal-content-${id}`}>
            <Box as="summary" cursor="pointer" color="fg.muted" width="fit-content">
              {copy.proposalContent}
            </Box>
            <DataList.Root orientation="vertical" size="sm" mt="3">
              <ContentItem label={copy.proposalYesCondition} value={proposal.yesCondition} />
              <ContentItem label={copy.proposalExpectedSources} value={proposal.expectedSources} />
              {proposal.background !== null && (
                <ContentItem label={copy.proposalBackground} value={proposal.background} />
              )}
              {proposal.category !== null && (
                <ContentItem label={copy.proposalCategory} value={proposal.category.nameKo} />
              )}
            </DataList.Root>
          </Box>
        )}

        {!compact && canRetractProposal(status) && (
          <Button
            size="sm"
            variant="outline"
            alignSelf="flex-start"
            disabled={!retractable}
            onClick={onRetract}
            // One 철회 per 접수 proposal: named after its question, so a list of buttons says which.
            aria-label={`${proposal.question} ${copy.proposalRetract}`}
            data-testid={`my-proposal-retract-${id}`}
          >
            {copy.proposalRetract}
          </Button>
        )}
      </Stack>
    </Box>
  );
}

function ContentItem({ label, value }: { label: string; value: string }) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue whiteSpace="pre-wrap" wordBreak="break-word">
        {value}
      </DataList.ItemValue>
    </DataList.Item>
  );
}
