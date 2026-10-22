'use client';

import { HStack, Stack, Text } from '@chakra-ui/react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { type MyModerationAction } from '@/lib/api';
import { appealGuidanceDeadline, appealGuidanceText } from '@/lib/moderation';

/**
 * 제재 이의의 안내 (#186, ADR-0084): how to appeal one action, in the three places that draw it —
 * the action's card on 조치·신고 내역, the MY summary's warning banner and the sanction banner
 * (ADR-0069 decision 2 #45-14: «조치 안내에 이메일과 기한을 적는다»; #45-13: the member reads the
 * 이의 방법 of every action). Not yet on the '숨김' line of MY '내 글', which shows a hiding to its
 * author with its reason alone — that one is the owner's to answer (ADR-0084 결과 4의 3). An appeal
 * goes by email alone and the app neither takes nor records one (decision 4 #186), so this is text
 * and a deadline, never a form or a button.
 *
 * Two lines: '이의 기한' with the action's last instant — APPEAL_WINDOW_DAYS from it
 * (`appealGuidanceDeadline`), an absolute time in the member's zone like every other on a member
 * screen (`useFormatDateTime`, ADR-0063) — and the sentence: the customer centre's email (business
 * info, 미정 until the owner supplies it), once per action within the window, the action standing
 * while it is reviewed, the answer by email (`appealGuidanceText`). It promises no outcome: an
 * operator who accepts one cancels the action, or lifts or shortens a restriction (#50, #185,
 * #139).
 *
 * Whether to draw anything is `appealGuidanceDeadline`'s alone — nothing for an action an operator
 * cancelled since, the passed deadline as it is for one standing (ADR-0084 6-3) — so it reads no
 * clock here; a source check in lib/moderation.test.ts holds this component to that. The member's
 * actions are read in the browser alone, so nothing here reaches a server render.
 *
 * `tone`: `card` puts the label and the sentence in the muted colour of a card's other lines;
 * `banner` lets them take the banner's own colour, which a muted grey would clash with.
 */
export function AppealGuidance({
  action,
  testId,
  tone = 'card',
}: {
  action: Pick<MyModerationAction, 'createdAt' | 'cancelledAt'>;
  testId: string;
  tone?: 'card' | 'banner';
}) {
  const format = useFormatDateTime();
  const deadline = appealGuidanceDeadline(action);
  if (deadline === null) return null;
  const muted = tone === 'card' ? 'fg.muted' : undefined;
  return (
    <Stack gap="0.5" textStyle="bodySm" data-testid={testId}>
      <HStack gap="2" align="baseline" flexWrap="wrap">
        <Text as="span" color={muted} flexShrink="0">
          {copy.moderationAppealDeadline}
        </Text>
        <Text
          as="span"
          color={tone === 'card' ? 'fg' : undefined}
          fontWeight={tone === 'banner' ? 'medium' : undefined}
          data-testid={`${testId}-deadline`}
        >
          {format(deadline)}
        </Text>
      </HStack>
      {/* Korean broken at spaces, and the email — one long word once the owner supplies it — anywhere
          rather than past a phone's edge (the footer's rule for the same address). */}
      <Text
        color={muted}
        wordBreak="keep-all"
        overflowWrap="anywhere"
        data-testid={`${testId}-text`}
      >
        {appealGuidanceText()}
      </Text>
    </Stack>
  );
}
