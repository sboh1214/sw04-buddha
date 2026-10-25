'use client';

import { Button, Stack, Switch, Text } from '@chakra-ui/react';
import { useId, useState } from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useRecordConsents } from '@/hooks/use-onboarding';
import { useSettingsStep } from '@/hooks/use-settings-step';
import { ConsentTextRegion } from '@/legal/consent-text-view';
import { MARKETING_CONSENT_TEXT } from '@/legal/consent-texts';
import { resolveLegalDocument } from '@/legal/document';
import { type Me } from '@/lib/api';
import { consentFailure, marketingConsentBody, marketingSwitchOn } from '@/lib/consent';
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
 * consent step's. While that record is out the switch shows the answer asked, and after a refusal
 * the account's answer again (`marketingSwitchOn`, ADR-0090). The text agreed to opens in place
 * ('내용 보기'), and the time of the last change shows in the member's time zone. Nothing sends
 * marketing yet.
 *
 * An account facing a re-consent alone stays on MY 설정 to clear its public items (#41,
 * ONBOARDING_EXEMPT_PAGES); its consent record is taken only with the items its consent step asks
 * (`POST /me/consents`), so the switch takes it to that step rather than send a record the server
 * would refuse, coming back here (`useSettingsStep`, ADR-0078 7-24).
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
        <MarketingSwitch key={me.id} consents={me.onboarding.consents} accountId={me.id} />
      )}
    </SettingsSection>
  );
}

/**
 * The switch of the account drawn (`accountId`, its `Me`'s id), which the record names
 * (`expectedAccountId`) — never the session's, which already says another account in the render
 * before SessionCacheGuard's reset (use-onboarding.ts, ADR-0078 7-29).
 */
function MarketingSwitch({
  consents,
  accountId,
}: {
  consents: Me['onboarding']['consents'];
  accountId: string;
}) {
  const record = useRecordConsents();
  const step = useSettingsStep();
  const formatDate = useFormatDateTime();
  const [open, setOpen] = useState(false);
  const regionId = useId();
  // The answer a press asked, shown from the press until the record settles (`marketingSwitchOn`):
  // dropped on a refusal, and after a success once the answers it wrote reach the card — a new
  // `consents` — so the switch never shows the old answer for a render in between. React's way of
  // adjusting state to a prop, during render.
  const [asked, setAsked] = useState<boolean | null>(null);
  const [shownConsents, setShownConsents] = useState(consents);
  if (consents !== shownConsents) {
    setShownConsents(consents);
    setAsked(null);
  }
  const on = marketingSwitchOn(consents, asked);
  const newest = consents.find((answer) => answer.item === 'marketing');

  const onChange = async (agreed: boolean) => {
    if (step.stepLeft) {
      step.toStep();
      return;
    }
    setAsked(agreed);
    try {
      const me = await record.mutateAsync(marketingConsentBody(agreed, accountId));
      const answer = me.onboarding.consents.find((item) => item.item === 'marketing');
      toaster.create({
        type: 'success',
        title: agreed ? copy.marketingConsentOn : copy.marketingConsentOff,
        ...(answer === undefined ? {} : { description: formatDate(answer.recordedAt) }),
      });
    } catch (error) {
      // Nothing was recorded: the account's answer again, the switch's input with it (ADR-0090).
      setAsked(null);
      toaster.create({ type: 'error', title: consentFailure(error) });
    }
  };

  return (
    <Stack gap="3" align="flex-start">
      <Switch.Root
        checked={on}
        disabled={record.isPending}
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
