'use client';

import { Button, type ButtonProps } from '@chakra-ui/react';
import { copy } from '@/copy';
import { useSignOut } from '@/hooks/use-sign-out';

/**
 * 로그아웃, wherever it is offered: MY (`AccountActions`), and the two screens an account the
 * onboarding gate holds can still open — /onboarding and /set-password (owner decision 2026-10-13,
 * #16: the header has no profile menu, and MY is not exempt from the gate, ADR-0043). One action
 * (`useSignOut`), so every one of them lands where MY's does. `beforeSignOut` is what the screen
 * tells the server before the session ends (/onboarding's leave report, ADR-0078).
 */
export function SignOutButton({
  beforeSignOut,
  ...props
}: Omit<ButtonProps, 'onClick' | 'children'> & {
  'data-testid': string;
  beforeSignOut?: () => Promise<void>;
}) {
  const handleSignOut = useSignOut(beforeSignOut);
  return (
    <Button size="sm" variant="ghost" {...props} onClick={() => void handleSignOut()}>
      {copy.logout}
    </Button>
  );
}
