'use client';

import { Link as ChakraLink } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { isOperator } from '@/lib/moderation';

/**
 * '운영' (#50, ADR-0081; owner decision 2026-10-21: «신고 없는 조치의 입구 → 공개 화면(글·댓글·대댓글·
 * 프로필)에 운영자에게만 '운영' 링크»): on a public post, each of its comments and replies, and a
 * profile, a link for operators to that post's, comment's or member's moderation page, where they
 * act with a report or without one. Whom it shows to is the role `GET /me` answers (`isOperator`),
 * read in the browser — anyone else, a visitor and an account whose `GET /me` is pending or failed
 * get nothing, so no admin address is drawn for them; the admin pages check the role again
 * whatever a page draws (AdminGuard). `label` names what the page is about for a screen reader,
 * which hears it with the visible '운영' in it.
 */
export function OperatorLink({
  href,
  label,
  testId,
}: {
  href: string;
  label: string;
  testId: string;
}) {
  const me = useMe();
  if (!isOperator(me.data?.profile.role)) return null;
  return (
    <ChakraLink asChild textStyle="bodyXs" color="fg.muted" _hover={{ color: 'fg' }}>
      <NextLink href={href as Route} prefetch={false} aria-label={label} data-testid={testId}>
        {copy.operatorModerationLink}
      </NextLink>
    </ChakraLink>
  );
}
