import { Container, Heading, Stack } from '@chakra-ui/react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { copy } from '@/copy';
import { getServerSession } from '@/lib/session.server';
import { LinkedAccounts } from './linked-accounts';
import { NicknameForm } from './nickname-form';
import { PasswordForm } from './password-form';
import { ThemeSection } from './theme-section';

export const metadata: Metadata = { title: `${copy.settingsTitle} | ${copy.appName}` };

/**
 * Server component: no session -> /login?next=/settings. Sections are client components.
 * `?error=<code>` is where better-auth sends the browser when a 연결 (linkSocial) round-trip
 * fails (`errorCallbackURL` in linked-accounts.tsx); the code is shown as Korean copy there.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  if (!(await getServerSession())) redirect('/login?next=/settings');
  const { error } = await searchParams;
  const linkError = Array.isArray(error) ? error.join(',') : error;
  return (
    <Container maxW="2xl" py={{ base: '6', md: '10' }}>
      <Stack gap="8">
        <Heading as="h2" size="2xl">
          {copy.settingsTitle}
        </Heading>
        <NicknameForm />
        <LinkedAccounts linkError={linkError} />
        <PasswordForm />
        <ThemeSection />
      </Stack>
    </Container>
  );
}
