'use client';

import { Button, type ButtonProps } from '@chakra-ui/react';
import { copy } from '@/copy';
import { useSignOut } from '@/hooks/use-sign-out';

/**
 * 로그아웃, wherever it is offered: MY (`AccountActions`), and the two screens an account the
 * onboarding gate holds can still open — /onboarding and /set-password (owner decision 2026-10-13,
 * #16: the header has no profile menu, and MY is not exempt from the gate, ADR-0043). One action
 * (`useSignOut`), so every one of them lands where MY's does.
 */
export function SignOutButton(
  props: Omit<ButtonProps, 'onClick' | 'children'> & { 'data-testid': string },
) {
  const handleSignOut = useSignOut();
  return (
    <Button size="sm" variant="ghost" {...props} onClick={() => void handleSignOut()}>
      {copy.logout}
    </Button>
  );
}
