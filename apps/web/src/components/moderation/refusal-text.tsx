'use client';

import { Link as ChakraLink } from '@chakra-ui/react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { MY_MODERATION_PATH } from '@/lib/moderation';

/**
 * A refusal's sentence where a screen shows it (an alert, a field's error), and — when a writing
 * restriction gave it (`isRestricted`, #185, ADR-0082) — the way to 조치·신고 내역 under it: owner
 * decision 2026-10-22 evening, via #186 «제한 중 거절의 이의 안내 → 끝나는 시각과 조치·신고 내역
 * 링크(기한은 내역에)». The sentence says the end (lib/restriction.ts); the appeal's guidance and its
 * deadline are 조치·신고 내역's, once, so this names neither.
 */
export function RefusalText({ message, restricted }: { message: string; restricted: boolean }) {
  return (
    <>
      {message}
      {restricted && <RestrictedModerationLink />}
    </>
  );
}

/**
 * The way to 조치·신고 내역 under a writing restriction's refusal (`RefusalText`), alone: for a
 * refusal drawn where its sentence is an element of its own — a held comment's reason, which names
 * its group (components/post/held-comment-text.tsx).
 *
 * The same link, under its own test id, goes under the refusal of a hidden post's edit screen —
 * '운영 정책에 따라 숨긴 글은 고칠 수 없습니다.' — wherever the screen says it (오너 결정 2026-10-25
 * «링크를 둠», #186, ADR-0084: «제한 거절 문구와 같은 꼴»; the edit screen's
 * `HiddenModerationLink`).
 */
export function RestrictedModerationLink({
  'data-testid': testId = 'restricted-moderation-link',
}: {
  'data-testid'?: string;
}) {
  return (
    <ChakraLink asChild color="brand.fg" display="block" mt="1">
      <NextLink href={MY_MODERATION_PATH} data-testid={testId}>
        {copy.myModerationOpen}
      </NextLink>
    </ChakraLink>
  );
}
