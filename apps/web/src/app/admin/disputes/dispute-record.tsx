'use client';

import { Badge, HStack, Link as ChakraLink, Stack, Text } from '@chakra-ui/react';
import { type ReactNode } from 'react';
import { copy } from '@/copy';
import { nicknameShown } from '@/lib/account-closure';
import { disputeSubmitterName } from '@/lib/admin-disputes';
import { type AdminMarketDispute } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { DISPUTE_STATUS_LABEL, DISPUTE_STATUS_PALETTE } from '@/lib/disputes';
import { judgementVersionName } from '@/lib/market-admin';

/**
 * One 판정 이의 as the operators read it (#175, ADR-0104), in 이의 접수 and in the admin detail's 판정
 * panel: its status, the judgement version it disputes, who submitted it — by nickname, '탈퇴한
 * 사용자' for a closed account (ADR-0069 decision 4 #140: its pending dispute is still decided) —
 * and when (KST), its 근거 링크 (each opened in a new tab) and reason, and how it ended: who decided
 * it, when and why, or when it was retracted. A closed account's decided or retracted dispute whose
 * links and reason the retention emptied (`purgedAt`) says so in their place. No market price,
 * majority or position (N03 §5). Test ids under `prefix`; `actions` (the panel's 기각 and 수용) last.
 */
export function DisputeRecord({
  dispute,
  prefix,
  heading,
  actions,
}: {
  dispute: AdminMarketDispute;
  prefix: string;
  /** What heads the record beside its status (the queue's market link). */
  heading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Stack
      gap="2"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={prefix}
      data-status={dispute.status}
    >
      <HStack gap="2" flexWrap="wrap" align="center">
        <Badge
          colorPalette={DISPUTE_STATUS_PALETTE[dispute.status]}
          variant="subtle"
          data-testid={`${prefix}-status`}
        >
          {DISPUTE_STATUS_LABEL[dispute.status]}
        </Badge>
        {heading}
        <Text fontSize="sm" color="fg.muted" data-testid={`${prefix}-version`}>
          {copy.adminDisputeVersion} {judgementVersionName(dispute.judgementVersion)}
        </Text>
      </HStack>
      <Text fontSize="sm">
        {copy.adminDisputeSubmitter}{' '}
        <Text as="span" fontWeight="medium" data-testid={`${prefix}-submitter`}>
          {disputeSubmitterName(dispute)}
        </Text>{' '}
        · {copy.adminDisputeSubmittedAt}{' '}
        <Text as="span" data-testid={`${prefix}-submitted-at`}>
          {formatKst(dispute.submittedAt)}
        </Text>
      </Text>
      {dispute.purgedAt !== null ? (
        <Text fontSize="sm" color="fg.muted" data-testid={`${prefix}-purged`}>
          {copy.adminDisputePurged}
        </Text>
      ) : (
        <>
          <Stack gap="0.5">
            <Text fontSize="sm" fontWeight="medium">
              {copy.adminDisputeLinks}
            </Text>
            <Stack
              as="ol"
              gap="0.5"
              listStyleType="decimal"
              ps="5"
              fontSize="sm"
              data-testid={`${prefix}-links`}
            >
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
          </Stack>
          <Text as="div" fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
            <Text as="span" fontWeight="medium">
              {copy.adminDisputeReason}
            </Text>{' '}
            <Text as="span" data-testid={`${prefix}-reason`}>
              {dispute.reason}
            </Text>
          </Text>
        </>
      )}
      {dispute.decidedAt !== null && (
        <Stack gap="0.5" fontSize="sm" data-testid={`${prefix}-decision`}>
          <Text>
            {copy.adminDisputeDecidedBy}{' '}
            <Text as="span" fontWeight="medium" data-testid={`${prefix}-decided-by`}>
              {dispute.decidedBy === null ? '—' : nicknameShown(dispute.decidedBy.nickname)}
            </Text>{' '}
            · {copy.adminDisputeDecidedAt}{' '}
            <Text as="span" data-testid={`${prefix}-decided-at`}>
              {formatKst(dispute.decidedAt)}
            </Text>
          </Text>
          {dispute.decisionReason !== null && (
            <Text whiteSpace="pre-wrap" wordBreak="break-word">
              <Text as="span" fontWeight="medium">
                {copy.adminDisputeDecisionReason}
              </Text>{' '}
              <Text as="span" data-testid={`${prefix}-decision-reason`}>
                {dispute.decisionReason}
              </Text>
            </Text>
          )}
        </Stack>
      )}
      {dispute.retractedAt !== null && (
        <Text fontSize="sm" data-testid={`${prefix}-retracted-at`}>
          {copy.adminDisputeRetractedAt} {formatKst(dispute.retractedAt)}
        </Text>
      )}
      {actions}
    </Stack>
  );
}
