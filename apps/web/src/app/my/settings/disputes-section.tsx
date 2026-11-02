'use client';

import { Button } from '@chakra-ui/react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { MY_DISPUTES_PATH } from '@/lib/disputes';
import { SettingsSection } from './section';

/**
 * 설정's way to MY '판정 이의' (#175, ADR-0104): a MY sub-page with no tab of its own, linked from
 * here and from a market's submission screen, as 내 제안 is (ADR-0089). A link only — nothing about
 * a dispute is set here. Its hint keeps the two 이의 apart: a sanction appeal (제재 이의, ADR-0084) is
 * 조치·신고 내역's.
 */
export function DisputesSection() {
  return (
    <SettingsSection
      title={copy.myDisputes}
      hint={copy.myDisputesSettingsHint}
      testId="settings-disputes"
    >
      <Button asChild size="sm" variant="outline">
        <NextLink href={MY_DISPUTES_PATH}>{copy.myDisputesOpen}</NextLink>
      </Button>
    </SettingsSection>
  );
}
