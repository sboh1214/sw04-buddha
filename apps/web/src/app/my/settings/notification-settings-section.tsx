'use client';

import { Link as ChakraLink, Skeleton, Stack, Switch, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useState } from 'react';
import { ProfileUnavailable } from '@/components/my/profile-unavailable';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useNotificationSettings, useUpdateNotificationSetting } from '@/hooks/use-notifications';
import {
  NOTIFICATION_SETTINGS_ANCHOR,
  NOTIFICATION_SETTINGS_HISTORY_PATH,
  type NotificationSettingRow,
  notificationSettingFailure,
  notificationSettingRows,
  notificationSettingSaved,
} from '@/lib/notifications';
import { LoadFailed } from '../portfolio';
import { SettingsSection } from './section';

/**
 * 알림 수신 (#56, ADR-0162; owner answers 52-21·52-22·52-23, 56-1…56-5): one switch per category
 * that has a type (거래·시장·커뮤니티 — 56-2), all on until the member turns one off and none
 * locked (52-21). While a category is off nothing of it is made (52-22) and what the inbox holds
 * stays (56-1) — the card's hint says both. Under the switches the 56-3 line and its way to the
 * record 52-23 names: 거래·정산 이력's 정산 list. On MY › 설정 after 화면 모드 and before 조치·신고
 * 내역, not beside the email '마케팅 정보 수신' card (56-4; #56 AC 9: no channel choice), with
 * MY › 알림's '수신 설정' link to its anchor.
 *
 * A private setting: never disabled by a writing or an account restriction (ADR-0157 결과 6) —
 * the card stays usable under the page's `SanctionBanner`.
 */
export function NotificationSettingsSection() {
  const { data: me, isPending } = useMe();
  return (
    <SettingsSection
      id={NOTIFICATION_SETTINGS_ANCHOR}
      title={copy.settingsNotifications}
      hint={copy.settingsNotificationsHint}
      testId="settings-notifications"
    >
      {isPending || !me ? (
        <ProfileUnavailable />
      ) : (
        // Keyed by account: a tab that switched accounts starts from the new one's settings.
        <NotificationSettingsBody key={me.id} accountId={me.id} />
      )}
    </SettingsSection>
  );
}

/**
 * The switches of the account drawn (`accountId`, its `Me`'s id) — a skeleton while they are
 * read, the error with 다시 시도 when the first read failed — then the 56-3 line and its link.
 */
export function NotificationSettingsBody({ accountId }: { accountId: string }) {
  const settings = useNotificationSettings(accountId);
  return (
    <Stack gap="5" align="stretch">
      {settings.data !== undefined ? (
        <Stack gap="4" data-testid="settings-notifications-list">
          {notificationSettingRows(settings.data).map((row) => (
            <NotificationSettingSwitch key={row.category} row={row} accountId={accountId} />
          ))}
        </Stack>
      ) : settings.isError ? (
        <LoadFailed message={copy.errUnknown} onRetry={() => void settings.refetch()} />
      ) : (
        <Skeleton height="24" data-testid="settings-notifications-pending" />
      )}
      <Stack gap="1" align="flex-start">
        <Text textStyle="bodySm" color="fg.muted" data-testid="settings-notifications-note">
          {copy.notificationSettingsHistoryNote}
        </Text>
        <ChakraLink asChild textStyle="bodySm" color="brand.fg">
          <NextLink
            href={NOTIFICATION_SETTINGS_HISTORY_PATH as Route}
            data-testid="settings-notifications-history-link"
          >
            {copy.notificationSettingsHistoryLink}
          </NextLink>
        </ChakraLink>
      </Stack>
    </Stack>
  );
}

/**
 * One category's switch, saved on each press (the 마케팅 정보 수신 switch's way — no 저장 button).
 * From the press until the write settles it shows the value asked: dropped on a refusal, and after
 * a success once the answer reaches the row — React's way of adjusting state to a prop, during
 * render — so it never shows the old value for a render in between. The write names the account
 * the card was drawn for (`accountId`), never the session's (ADR-0090).
 */
function NotificationSettingSwitch({
  row,
  accountId,
}: {
  row: NotificationSettingRow;
  accountId: string;
}) {
  const update = useUpdateNotificationSetting();
  const [asked, setAsked] = useState<boolean | null>(null);
  const [shownEnabled, setShownEnabled] = useState(row.enabled);
  if (row.enabled !== shownEnabled) {
    setShownEnabled(row.enabled);
    setAsked(null);
  }
  const on = asked ?? row.enabled;

  const onChange = async (enabled: boolean) => {
    setAsked(enabled);
    try {
      await update.mutateAsync({ category: row.category, enabled, expectedAccountId: accountId });
      // The answer is in the cache by now (the mutation's `onSuccess` is awaited).
      setAsked(null);
      toaster.create({ type: 'success', title: notificationSettingSaved(row.label, enabled) });
    } catch (error) {
      // Nothing was written: the held value again, the switch's input with it.
      setAsked(null);
      toaster.create({ type: 'error', title: notificationSettingFailure(error) });
    }
  };

  return (
    <Stack gap="1" align="flex-start">
      <Switch.Root
        checked={on}
        disabled={update.isPending}
        onCheckedChange={(details) => void onChange(details.checked)}
        colorPalette="brand"
        data-testid={`settings-notifications-${row.category}-switch`}
      >
        <Switch.HiddenInput />
        <Switch.Control />
        <Switch.Label>{row.label}</Switch.Label>
      </Switch.Root>
      <Text
        textStyle="bodySm"
        color="fg.muted"
        data-testid={`settings-notifications-${row.category}-hint`}
      >
        {row.hint}
      </Text>
    </Stack>
  );
}
