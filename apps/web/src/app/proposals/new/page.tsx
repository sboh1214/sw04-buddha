import { Container, Heading, Stack, Text } from '@chakra-ui/react';
import type { Metadata, Route } from 'next';
import { redirect } from 'next/navigation';
import { copy } from '@/copy';
import { NEW_PROPOSAL_LOGIN_PATH } from '@/lib/proposals';
import { getServerSession } from '@/lib/session.server';
import { ProposalForm } from './proposal-form';

export const metadata: Metadata = { title: `${copy.proposalNewTitle} | ${copy.appName}` };

/**
 * 시장 제안 양식 (`/proposals/new`, #77, ADR-0089; ADR-0069 decision 4 #77). No session → the login
 * screen, told to come back here (a fixed `next`: nothing of the request travels). An account with
 * an onboarding step left meets the onboarding gate here like on every page (#57-8: proposing is
 * for an account that finished it — the server's `OnboardedGuard` keeps the action); a restricted
 * account (#185, #139) is refused by the server when it submits (RESTRICTED, ProposalRestrictions —
 * ADR-0085 결과 5), the form naming the restriction and its end.
 * Reading `cookies()` through `getServerSession()` marks the route dynamic.
 */
export default async function NewProposalPage() {
  if (!(await getServerSession())) redirect(NEW_PROPOSAL_LOGIN_PATH as Route);
  return (
    <Container maxW="2xl" py={{ base: '6', md: '10' }}>
      <Stack gap="6">
        <Stack gap="2">
          <Heading as="h2" size="2xl">
            {copy.proposalNewTitle}
          </Heading>
          <Text color="fg.muted">{copy.proposalNewIntro}</Text>
        </Stack>
        <ProposalForm />
      </Stack>
    </Container>
  );
}
