'use client';

import { Button, Stack, Switch, Text } from '@chakra-ui/react';
import { useId, useState } from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useRecordConsents } from '@/hooks/use-onboarding';
import { ConsentTextRegion } from '@/legal/consent-text-view';
import { MARKETING_CONSENT_TEXT } from '@/legal/consent-texts';
import { resolveLegalDocument } from '@/legal/document';
import { type Me } from '@/lib/api';
import { consentFailure, marketingConsentBody, marketingConsentOn } from '@/lib/consent';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

/** The marketing consent text, business facts filled in once. */
const MARKETING_TEXT = resolveLegalDocument(MARKETING_CONSENT_TEXT);

/**
 * 마케팅 정보 수신 (#58, 오너 결정 2026-10-19 (2차) 4, ADR-0072): the optional consent item the
 * onboarding's consent step asked, by email only, turned on and off here at any time. The switch is
 * the account's newest marketing answer — on while it is an agreement to a version that still
 * holds (`marketingConsentOn`) — and every change is `POST /me/consents` with that answer alone
 * (`marketingConsentBody`): a record of its own, with the time, the address and the browser, as the
 * consent step's. The text agreed to opens in place ('내용 보기'), and the time of the last change
 * shows in the member's time zone. Nothing sends marketing yet.
 */
export function MarketingSection() {
  const { data: me, isPending } = useMe();
  return (
    <SettingsSection
      title={copy.settingsMarketing}
      hint={copy.settingsMarketingHint}
      testId="settings-marketing"
    >
      {isPending || !me ? (
        <ProfileUnavailable />
      ) : (
        // Keyed by account: a tab that switched accounts starts from the new one's answer.
        <MarketingSwitch key={me.id} consents={me.onboarding.consents} />
      )}
    </SettingsSection>
  );
}

function MarketingSwitch({ consents }: { consents: Me['onboarding']['consents'] }) {
  const record = useRecordConsents();
  const formatDate = useFormatDateTime();
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const on = marketingConsentOn(consents);
  const newest = consents.find((answer) => answer.item === 'marketing');

  const onChange = async (agreed: boolean) => {
    // Unreachable while the switch honours `ready`.
    const accountId = record.accountId;
    if (accountId === undefined) return;
    try {
      const me = await record.mutateAsync(marketingConsentBody(agreed, accountId));
      const answer = me.onboarding.consents.find((item) => item.item === 'marketing');
      toaster.create({
        type: 'success',
        title: agreed ? copy.marketingConsentOn : copy.marketingConsentOff,
        ...(answer === undefined ? {} : { description: formatDate(answer.recordedAt) }),
      });
    } catch (error) {
      toaster.create({ type: 'error', title: consentFailure(error) });
    }
  };

  return (
    <Stack gap="3" align="flex-start">
      <Switch.Root
        checked={on}
        disabled={!record.ready || record.isPending}
        onCheckedChange={(details) => void onChange(details.checked)}
        colorPalette="brand"
        data-testid="settings-marketing-switch"
      >
        <Switch.HiddenInput />
        <Switch.Control />
        <Switch.Label>{copy.consentMarketing}</Switch.Label>
      </Switch.Root>
      {newest !== undefined && (
        <Text fontSize="sm" color="fg.muted" data-testid="settings-marketing-changed-at">
          {copy.marketingConsentChangedAt} {formatDate(newest.recordedAt)}
        </Text>
      )}
      <Button
        variant="plain"
        size="xs"
        px="0"
        color="fg.muted"
        textDecoration="underline"
        // Named after the text, as the consent step's button.
        aria-label={`${MARKETING_TEXT.title} ${open ? copy.consentHideText : copy.consentShowText}`}
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
        onClick={() => setOpen((previous) => !previous)}
        data-testid="settings-marketing-toggle"
      >
        {open ? copy.consentHideText : copy.consentShowText}
      </Button>
      {open && (
        <ConsentTextRegion id={regionId} text={MARKETING_TEXT} testId="settings-marketing-text" />
      )}
    </Stack>
  );
}
