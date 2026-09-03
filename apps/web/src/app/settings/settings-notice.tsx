import { Alert } from '@chakra-ui/react';
import { copy } from '@/copy';
import { authNoticeFor } from '@/lib/auth-client';

/**
 * better-auth sends the browser back to `/settings?error=<code>` when a 연결 (linkSocial)
 * round-trip fails or when a verification / change-email link is invalid or expired
 * (`callbackURL` of those mails is /settings).
 */
export function SettingsNotice({ code }: { code: string | string[] }) {
  const message = authNoticeFor(code, copy.linkFailed);
  if (!message) return null;
  return (
    <Alert.Root status="error" role="alert" data-testid="settings-notice">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{message}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}
