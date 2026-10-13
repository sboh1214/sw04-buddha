import { Stack } from '@chakra-ui/react';
import type { Metadata } from 'next';
import { copy } from '@/copy';
import { AccountSection } from './account-section';
import { ContactSection } from './contact-section';
import { LinkedAccounts } from './linked-accounts';
import { NicknameForm } from './nickname-form';
import { PasswordForm } from './password-form';
import { SettingsNotice } from './settings-notice';
import { ThemeSection } from './theme-section';

export const metadata: Metadata = { title: `${copy.settingsTitle} | ${copy.appName}` };

/**
 * MY's 설정 (`/my/settings`, #16). Server component; the session gate is the MY layout's and the
 * sections are client components. `?error=<code>` is where better-auth sends the browser when a
 * 연결 round-trip or a verification / change-email link fails (see settings-notice.tsx).
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return (
    // The settings' own measure from before the move, inside MY's wider column.
    <Stack gap="8" maxW="2xl">
      {error !== undefined && <SettingsNotice code={error} />}
      <NicknameForm />
      <AccountSection />
      <ContactSection />
      <LinkedAccounts />
      <PasswordForm />
      <ThemeSection />
    </Stack>
  );
}
