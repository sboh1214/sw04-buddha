import { Stack } from '@chakra-ui/react';
import type { Metadata } from 'next';
import { SanctionBanner } from '@/components/moderation/sanction-banner';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
import { AccountSection } from './account-section';
import { BioSection } from './bio-section';
import { ClosureSection } from './closure-section';
import { InterestsSection } from './interests-section';
import { LinkedAccounts } from './linked-accounts';
import { MarketingSection } from './marketing-section';
import { ModerationSection } from './moderation-section';
import { NicknameForm } from './nickname-form';
import { PasswordForm } from './password-form';
import { ProfileImageSection } from './profile-image-section';
import { ProposalsSection } from './proposals-section';
import { SettingsNotice } from './settings-notice';
import { ThemeSection } from './theme-section';
import { TimeZoneSection } from './time-zone-section';
import { VerificationSection } from './verification-section';

export const metadata: Metadata = { title: `${copy.settingsTitle} | ${copy.appName}` };

/**
 * MY's 설정 (`/my/settings`, #16). The public profile's items come first — the nickname (#58), the
 * image (#141), the 소개 and the interest categories (#41, ADR-0069 decision 4 #41: «MY 설정») —
 * then the account's own settings, the way to 조치·신고 내역 (#50, ADR-0081 — a MY page of its own,
 * linked from here, ADR-0069 decision 4 #50), and last the way to 탈퇴 (#140, ADR-0086 — its
 * confirmation screen under this one, `/my/settings/closure`). Above them all, while a writing or an
 * account restriction stands, its banner (`SanctionBanner`, #185, ADR-0082; #139, ADR-0085 — the
 * restriction state ADR-0078 결과 5 left to #185 and #139 for MY 설정: each end and the way to
 * 조치·신고 내역): the public items below take no new value until it ends (ADR-0069 decision 3
 * #37-9). Server component: no session -> the login page, on every navigation to it
 * (`requireMySession`); the sections are client components.
 * `?error=<code>` is where better-auth sends the browser when a 연결 round-trip or a verification /
 * change-email link fails (see settings-notice.tsx).
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  await requireMySession();
  const { error } = await searchParams;
  return (
    // The settings' own measure from before the move, inside MY's wider column.
    <Stack gap="8" maxW="2xl">
      {error !== undefined && <SettingsNotice code={error} />}
      <SanctionBanner testId="settings-sanction-banner" />
      <NicknameForm />
      <ProfileImageSection />
      <BioSection />
      <InterestsSection />
      <AccountSection />
      <VerificationSection />
      <LinkedAccounts />
      <PasswordForm />
      <MarketingSection />
      <TimeZoneSection />
      <ThemeSection />
      <ModerationSection />
      {/* 내 제안 (#77): linked from 설정 as from the summary, since it has no tab. */}
      <ProposalsSection />
      <ClosureSection />
    </Stack>
  );
}
