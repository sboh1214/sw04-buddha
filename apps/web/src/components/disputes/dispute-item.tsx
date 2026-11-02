'use client';

import {
  Badge,
  Box,
  Button,
  DataList,
  HStack,
  Heading,
  Link as ChakraLink,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { copy } from '@/copy';
import { type MyDispute } from '@/lib/api';
import { DISPUTE_STATUS_LABEL, DISPUTE_STATUS_PALETTE, disputeStatusTime } from '@/lib/disputes';
import { judgementVersionName } from '@/lib/market-admin';

/**
 * One of the member's 판정 이의 (#175, ADR-0104), on the submission screen and in MY '판정 이의':
 * its status (검토 중 · 기각 · 수용 · 철회) and the instant it took it, the judgement version it
 * disputes, the decision's reason once decided — the submitter reads it (#173 item 7) — and, for an
 * accepted one, that a correction follows (#176); what it submitted, folded (so a long reason does
 * not push the next one away); and 철회 while the API says it may still be (`retractable`: pending
 * and the deadline ahead). Never who decided it — the API sends no decider (#173 item 13). With
 * `showMarket` (MY) its market's title is the heading, a link to its detail; on the market's own
 * submission screen the heading is '낸 판정 이의'. Test ids under `my-dispute-<id>`.
 */
export function DisputeItem({
  dispute,
  showMarket,
  accountKnown,
  deadlineOpen = true,
  onRetract,
}: {
  dispute: MyDispute;
  showMarket: boolean;
  /** Whether the account a 철회 names is known yet (`GET /me`). */
  accountKnown: boolean;
  /**
   * Whether the 이의 기한 is still ahead on the screen's clock (the submission screen's timer): 철회
   * goes with the deadline without a reload, as the submission does. MY has no deadline to time.
   */
  deadlineOpen?: boolean;
  onRetract: () => void;
}) {
  const format = useFormatDateTime();
  const { id, status } = dispute;
  const time = disputeStatusTime(dispute);
  const at = `my-dispute-${id}`;
  return (
    <Box
      as="article"
      borderWidth="1px"
      borderRadius="l2"
      p="4"
      data-testid={at}
      data-status={status}
    >
      <Stack gap="3">
        <Stack gap="1">
          <HStack gap="2" flexWrap="wrap" align="center">
            <Badge
              colorPalette={DISPUTE_STATUS_PALETTE[status]}
              variant="subtle"
              data-testid={`${at}-status`}
            >
              {DISPUTE_STATUS_LABEL[status]}
            </Badge>
            <Heading as="h4" size="sm" wordBreak="break-word">
              {showMarket ? (
                <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
                  <NextLink
                    href={`/markets/${dispute.market.slug}` as Route}
                    data-testid={`${at}-market`}
                  >
                    {dispute.market.title}
                  </NextLink>
                </ChakraLink>
              ) : (
                copy.disputeMine
              )}
            </Heading>
          </HStack>
          <Text fontSize="xs" color="fg.muted" data-testid={`${at}-times`}>
            {copy.disputeJudgementVersion} {judgementVersionName(dispute.judgementVersion)} ·{' '}
            {copy.disputeSubmittedAt} {format(dispute.submittedAt)}
            {status !== 'pending' && ` · ${time.label} ${format(time.at)}`}
          </Text>
        </Stack>

        {dispute.decisionReason !== null && (
          <Text fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
            <Text as="span" fontWeight="semibold">
              {copy.disputeDecisionReason}
            </Text>{' '}
            <Text as="span" data-testid={`${at}-decision-reason`}>
              {dispute.decisionReason}
            </Text>
          </Text>
        )}
        {status === 'accepted' && (
          <Text fontSize="sm" color="fg.muted" data-testid={`${at}-accepted-note`}>
            {copy.disputeAcceptedNote}
          </Text>
        )}

        <Box as="details" fontSize="sm" data-testid={`${at}-content`}>
          <Box as="summary" cursor="pointer" color="fg.muted" width="fit-content">
            {copy.disputeContent}
          </Box>
          <DataList.Root orientation="vertical" size="sm" mt="3">
            <DataList.Item>
              <DataList.ItemLabel>{copy.disputeLinks}</DataList.ItemLabel>
              <DataList.ItemValue display="block">
                <Stack as="ol" gap="0.5" listStyleType="decimal" ps="5">
                  {dispute.links.map((link, index) => (
                    <li key={index}>
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
                    </li>
                  ))}
                </Stack>
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>{copy.disputeReason}</DataList.ItemLabel>
              <DataList.ItemValue whiteSpace="pre-wrap" wordBreak="break-word">
                {dispute.reason}
              </DataList.ItemValue>
            </DataList.Item>
          </DataList.Root>
        </Box>

        {dispute.retractable && deadlineOpen && (
          <Button
            size="sm"
            variant="outline"
            alignSelf="flex-start"
            disabled={!accountKnown}
            onClick={onRetract}
            // One 철회 per retractable dispute: named after its market, so a list says which.
            aria-label={`${dispute.market.title} ${copy.disputeRetract}`}
            data-testid={`${at}-retract`}
          >
            {copy.disputeRetract}
          </Button>
        )}
      </Stack>
    </Box>
  );
}

/**
 * The 철회's confirmation, for MY and the submission screen alike: the dispute's market and what
 * the 철회 means — it is the one of its version still (#173 item 6: 고칠 수는 없다).
 */
export function DisputeRetractDialog({
  dispute,
  pending,
  confirmDisabled,
  onClose,
  onConfirm,
}: {
  dispute: MyDispute | null;
  pending: boolean;
  confirmDisabled: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      testId="my-dispute-retract"
      open={dispute !== null}
      onClose={onClose}
      title={copy.disputeRetractTitle}
      confirmLabel={copy.disputeRetract}
      loading={pending}
      confirmDisabled={confirmDisabled}
      onConfirm={onConfirm}
    >
      <Stack gap="2">
        <Text fontWeight="medium">{dispute?.market.title}</Text>
        <Text>{copy.disputeRetractBody}</Text>
      </Stack>
    </ConfirmDialog>
  );
}
