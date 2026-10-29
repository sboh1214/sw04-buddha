'use client';

import { Alert, Link as ChakraLink, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { useMyModerationActions, useMyRestriction } from '@/hooks/use-reports';
import { MY_MODERATION_PATH, moderationRows, warningInWindow } from '@/lib/moderation';
import { restrictionEndText, restrictionShown } from '@/lib/restriction';

/**
 * The banner of a sanction in force (ADR-0069 decision 4 #50: «진행 중인 제재가 있으면 MY 요약·
 * 글쓰기 화면의 안내 띠»): the writing restriction (#185, ADR-0082) that governs — 무기한 over any
 * term, else the latest end, the end a refused write names — said by its title, its end in the
 * member's zone or '무기한', and the way to 조치·신고 내역, and nothing more (owner decision
 * 2026-10-22 evening, via #186 — ADR-0084 답 3: «경고·제재 띠 → 이의 안내를 빼고 … 끝나는 시각(제한)과
 * 조치·신고 내역 링크만»): the reason and how to appeal it — the guidance above the list and its
 * card's '이의 기한' (#186) — are 조치·신고 내역's, so several restrictions standing at once (#185
 * keeps each as an action; a writing and an account restriction may run together, #45-12·#57-12)
 * never make it give one's deadline for another's. An information banner (blue), not the app's
 * caution yellow (ADR-0070): it reports a state, it asks nothing. #139's account restriction adds
 * its own words here.
 *
 * It reads the member's restriction on its own (`GET /me/moderation/restriction`), not the first
 * page of their actions, so no number of later actions keeps a standing one off it; and draws
 * nothing while that is read, failed or holds none, nor once its end has passed by the browser's
 * clock. A write the server refuses with RESTRICTED reads it again (query-client.ts), so a
 * restriction given while the page was open shows here as soon as it refuses something.
 */
export function SanctionBanner({ testId }: { testId: string }) {
  const restriction = useMyRestriction();
  const format = useFormatDateTime();
  const shown = restrictionShown(restriction.data);
  if (shown === null) return null;
  return (
    <Alert.Root status="info" data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{copy.restrictionWritingTitle}</Alert.Title>
        <Alert.Description>
          <Stack gap="1" mt="1">
            <Text as="span" display="block" data-testid={`${testId}-ends`}>
              {copy.moderationEndsAt} {restrictionEndText(shown.endsAt, format)}
            </Text>
            <ChakraLink asChild color="brand.fg" alignSelf="flex-start">
              <NextLink href={MY_MODERATION_PATH} data-testid={`${testId}-link`}>
                {copy.myModerationOpen}
              </NextLink>
            </ChakraLink>
          </Stack>
        </Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

/**
 * The banner of a warning received (owner decision 2026-10-21: «경고 → 이의 기한 14일 동안 MY 요약에만
 * 안내 띠('경고를 받았습니다'와 내역 링크)»): that one was received, and the way to 조치·신고 내역, where
 * its reason and how to appeal it are. The owner's sentence and the link alone — no appeal guidance
 * of its own (owner decision 2026-10-22 답 3, #186, ADR-0084). Shown from the warning for its appeal
 * window (`warningInWindow`, APPEAL_WINDOW_DAYS), and no more once an operator cancelled it. On the
 * MY summary only — a warning restricts nothing (#45-11), so the write page keeps its banner for
 * restrictions (`SanctionBanner`). It reads the first page of the member's actions (ADR-0081 7-8),
 * drawn in the browser alone; nothing while it is read, failed or holds no such warning.
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
