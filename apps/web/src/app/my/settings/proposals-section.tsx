'use client';

import { Button } from '@chakra-ui/react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { MY_PROPOSALS_PATH } from '@/lib/proposals';
import { SettingsSection } from './section';

/**
 * 설정's way to 내 제안 (#77, ADR-0089): '내 제안' is a MY sub-page with no tab of its own, linked
 * from the MY summary and from here (ADR-0069 decision 4 #77 위치). A link only — nothing about a
 * proposal is set here.
 */
export function ProposalsSection() {
  return (
    <SettingsSection
      title={copy.myProposals}
      hint={copy.myProposalsSettingsHint}
      testId="settings-proposals"
    >
      <Button asChild size="sm" variant="outline">
        <NextLink href={MY_PROPOSALS_PATH}>{copy.myProposalsOpen}</NextLink>
      </Button>
    </SettingsSection>
  );
}
