'use client';

import { Alert, Link as ChakraLink } from '@chakra-ui/react';
import NextLink from 'next/link';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { useMyModerationActions } from '@/hooks/use-reports';
import {
  MY_MODERATION_PATH,
  moderationRows,
  sanctionInForce,
  warningInWindow,
} from '@/lib/moderation';

/**
 * The banner of a sanction in force (ADR-0069 decision 4 #50: «진행 중인 제재가 있으면 MY 요약·
 * 글쓰기 화면의 안내 띠»): that there is one, when it ends, and the way to 조치·신고 내역, where its
 * type, reason and the appeal are (#45-13). An information banner (blue), not the app's caution
 * yellow (ADR-0070): it reports a state, it asks nothing.
 *
 * A sanction is a restriction — #185's writing restriction, #139's account restriction (#45-12) —
 * which those issues add with their end (`sanctionInForce`); none of #50's actions is one, so with
 * #50 alone the banner never shows (ADR-0081 7-8). It reads the member's first page of actions
 * (`GET /me/moderation/actions`, newest first), and draws nothing while that is read, failed or
 * holds no sanction in force.
 */
export function SanctionBanner({ testId }: { testId: string }) {
  const actions = useMyModerationActions();
  const format = useFormatDateTime();
  const sanction = sanctionInForce(moderationRows(actions.data?.pages.slice(0, 1)));
  if (sanction === null || sanction.endsAt === null) return null;
  return (
    <Alert.Root status="info" data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{copy.sanctionInForce}</Alert.Title>
        <Alert.Description>
          {copy.moderationEndsAt} {format(sanction.endsAt)} ·{' '}
          <ChakraLink asChild color="brand.fg">
            <NextLink href={MY_MODERATION_PATH}>{copy.myModerationOpen}</NextLink>
          </ChakraLink>
        </Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

/**
 * The banner of a warning received (owner decision 2026-10-21: «경고 → 이의 기한 14일 동안 MY 요약에만
 * 안내 띠('경고를 받았습니다'와 내역 링크)»): that one was received, and the way to 조치·신고 내역, where
 * its reason and the appeal are. Shown from the warning for its appeal window (`warningInWindow`,
 * APPEAL_WINDOW_DAYS), and no more once an operator cancelled it. On the MY summary only — a
 * warning restricts nothing (#45-11), so the write page keeps its banner for restrictions
 * (`SanctionBanner`). The same first page of actions as that banner, drawn in the browser alone;
 * nothing while it is read, failed or holds no such warning.
 */
export function WarningBanner({ testId }: { testId: string }) {
  const actions = useMyModerationActions();
  const warning = warningInWindow(moderationRows(actions.data?.pages.slice(0, 1)));
  if (warning === null) return null;
  return (
    <Alert.Root status="info" data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{copy.moderationWarningReceived}</Alert.Title>
        <Alert.Description>
          <ChakraLink asChild color="brand.fg">
            <NextLink href={MY_MODERATION_PATH}>{copy.myModerationOpen}</NextLink>
          </ChakraLink>
        </Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}
