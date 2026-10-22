'use client';

import { Link as ChakraLink } from '@chakra-ui/react';
import { type Route } from 'next';
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
      {restricted && (
        <ChakraLink asChild color="brand.fg" display="block" mt="1">
          <NextLink href={MY_MODERATION_PATH} data-testid="restricted-moderation-link">
            {copy.myModerationOpen}
          </NextLink>
        </ChakraLink>
      )}
    </>
  );
}

/**
 * The same way for a refusal said in a toast (a post's image, PostEditor): the toast's action,
 * which the toaster draws as its button — a toast carries no link of its own.
 */
export function restrictedToastAction(navigate: (href: Route) => void) {
  return { label: copy.myModerationOpen, onClick: () => navigate(MY_MODERATION_PATH) };
}
