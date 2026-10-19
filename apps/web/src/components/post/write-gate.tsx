'use client';

import { Button, Skeleton } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { usePostWriter } from '@/hooks/use-posts';
import { loginPathBackToPage } from '@/lib/next-path';

/**
 * The write and edit screens' door (#46, ADR-0073): N05 §2 «비로그인 열람, 로그인 작성». Until the
 * session and `GET /me` have answered it draws a placeholder (the HTML names nobody); a visitor
 * gets a sign-in prompt that comes back to this screen with its query (`back`: the market picked);
 * a member gets the screen. An account with onboarding steps left never reaches here — the
 * onboarding gate takes it to its step first (#57-8), keeping a draft the form held (오너 결정
 * 2026-10-20, lib/post-drafts.ts) — and the server refuses its writes besides (OnboardedGuard).
 */
export function WriteGate({
  back,
  children,
}: {
  /** This screen's path and query, built from normalised values (never the address bar). */
  back: string;
  children: (writer: { accountId: string; publicId: string }) => ReactNode;
}) {
  const writer = usePostWriter();
  if (writer.pending) {
    return <Skeleton height="320px" borderRadius="card" data-testid="post-write-pending" />;
  }
  if (writer.failed) {
    return <EmptyState message={copy.errProfileLoad} data-testid="post-write-failed" />;
  }
  if (!writer.signedIn || writer.accountId === undefined || writer.publicId === undefined) {
    return (
      <EmptyState
        message={copy.postWriteSignedOut}
        action={
          <Button asChild size="sm" variant="outline">
            <NextLink href={loginPathBackToPage(back) as Route} data-testid="post-write-login">
              {copy.login}
            </NextLink>
          </Button>
        }
        data-testid="post-write-signed-out"
      />
    );
  }
  return children({ accountId: writer.accountId, publicId: writer.publicId });
}
