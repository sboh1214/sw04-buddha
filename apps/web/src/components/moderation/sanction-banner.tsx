'use client';

import { Alert, Link as ChakraLink, Stack, Text } from '@chakra-ui/react';
import { RESTRICTION_KINDS, type RestrictionKind } from '@buddha/shared';
import NextLink from 'next/link';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { useMyModerationActions, useMyRestriction } from '@/hooks/use-reports';
import { MY_MODERATION_PATH, moderationRows, warningInWindow } from '@/lib/moderation';
import { restrictionEndText, restrictionsShown } from '@/lib/restriction';

/** Each restriction's title on the banner: what the end under it is the end of. */
const RESTRICTION_TITLES: Readonly<Record<RestrictionKind, string>> = {
  writing: copy.restrictionWritingTitle,
  account: copy.restrictionAccountTitle,
};

/**
 * The banner of a sanction in force (ADR-0069 decision 4 #50: «진행 중인 제재가 있으면 MY 요약·
 * 글쓰기 화면의 안내 띠»; 제재 is 작성 제한 and 계정 제한, #45-12): the writing restriction (#185,
 * ADR-0082) and the account restriction (#139, ADR-0085) that govern, among the `kinds` its page
 * shows — both on MY 요약 and MY 설정, the writing restriction alone on the write page (owner
 * decision 2026-10-23: the account restriction refuses no post, WRITE_PAGE_RESTRICTION_KINDS) — of
 * each, 무기한 over any term, else the latest end, the end a refused write names — each said by its
 * title and its end in the member's zone or '무기한', and under them the way to 조치·신고 내역, once,
 * and nothing more (owner decision 2026-10-22 evening, via #186 — ADR-0084 답 3: «경고·제재 띠 →
 * 이의 안내를 빼고 … 끝나는 시각(제한)과 조치·신고 내역 링크만»): the reason and how to appeal it —
 * the guidance above the list and its card's '이의 기한' (#186) — are 조치·신고 내역's, so several
 * restrictions standing at once (#185 keeps each as an action; a writing and an account
 * restriction may run together, #45-12·#57-12) never make it give one's deadline for another's,
 * and the operators who asked for or approved an account restriction are nowhere (#139). One
 * banner for both, as one sanction notice with one link (ADR-0085 7-10). An information banner
 * (blue), not the app's caution yellow (ADR-0070): it reports a state, it asks nothing.
 *
 * It reads the member's restrictions on its own (`GET /me/moderation/restriction`), not the first
 * page of their actions, so no number of later actions keeps a standing one off it; and draws
 * nothing while that is read, failed or holds none, nor once each end has passed by the browser's
 * clock. A write the server refuses with RESTRICTED reads it again (query-client.ts), so a
 * restriction given while the page was open shows here as soon as it refuses something. Test
 * ids: the writing restriction keeps the one it had for its end (`…-ends`) and gains one for its
 * title and end together (`…-restriction`); the account restriction's are
 * `…-account-restriction` and `…-account-ends`.
 */
export function SanctionBanner({
  testId,
  kinds = RESTRICTION_KINDS,
}: {
  testId: string;
  kinds?: readonly RestrictionKind[];
}) {
  const restriction = useMyRestriction();
  const format = useFormatDateTime();
  const shown = restrictionsShown(restriction.data, undefined, kinds);
  if (shown.length === 0) return null;
  return (
    <Alert.Root status="info" data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Stack gap="2">
          {shown.map((item) => {
            const id = item.kind === 'writing' ? testId : `${testId}-account`;
            return (
              <Stack key={item.kind} gap="1" data-testid={`${id}-restriction`}>
                <Alert.Title>{RESTRICTION_TITLES[item.kind]}</Alert.Title>
                <Alert.Description>
                  <Text as="span" display="block" data-testid={`${id}-ends`}>
                    {copy.moderationEndsAt} {restrictionEndText(item.endsAt, format)}
                  </Text>
                </Alert.Description>
              </Stack>
            );
          })}
          <Alert.Description>
            <ChakraLink asChild color="brand.fg">
              <NextLink href={MY_MODERATION_PATH} data-testid={`${testId}-link`}>
                {copy.myModerationOpen}
              </NextLink>
            </ChakraLink>
          </Alert.Description>
        </Stack>
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
