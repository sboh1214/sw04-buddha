'use client';

import { Alert, Badge, Button, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import {
  CREDENTIAL_PROVIDER_ID,
  SOCIAL_PROVIDERS,
  authClient,
  authErrorMessage,
  type SocialProvider,
} from '@/lib/auth-client';
import { SettingsSection } from './section';

export const ACCOUNTS_QUERY_KEY = ['me', 'accounts'] as const;

const PROVIDER_LABEL: Record<string, string> = {
  [CREDENTIAL_PROVIDER_ID]: copy.providerCredential,
  google: copy.providerGoogle,
  kakao: copy.providerKakao,
  naver: copy.providerNaver,
};

/** better-auth appends `?error=<code>` to `errorCallbackURL`; pick the copy for the code. */
function linkErrorMessage(code: string): string {
  return code.includes('account_already_linked') ? copy.linkAlreadyUsed : copy.linkFailed;
}

/**
 * Linked login methods (PLAN 10.3). Reads better-auth `listAccounts` directly (the source of
 * truth for `account` rows, incl. the account id `unlinkAccount` needs); `GET /me` also
 * carries the list, so both caches are invalidated after link/unlink.
 * The 해제 button is disabled when only one method remains; the server enforces the same
 * rule (better-auth refuses to unlink the last account unless `allowUnlinkingAll`).
 * `linkError` is the `error` query parameter better-auth redirects back with when the
 * provider round-trip of a 연결 attempt fails (settings/page.tsx passes it through).
 */
export function LinkedAccounts({ linkError }: { linkError?: string | undefined }) {
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await authClient.listAccounts();
      if (error) throw new Error(authErrorMessage(error));
      return data;
    },
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
    ]);

  const link = useMutation({
    mutationFn: async (provider: SocialProvider) => {
      const { error } = await authClient.linkSocial({
        provider,
        callbackURL: '/settings',
        errorCallbackURL: '/settings?error=link',
      });
      if (error) throw new Error(authErrorMessage(error, copy.socialUnavailable));
      // Success = the browser is navigating to the provider; nothing else to do here.
    },
    onError: (error) => toaster.create({ type: 'error', title: error.message }),
  });

  const unlink = useMutation({
    // better-auth 1.7: unlinkAccount is keyed by the account row id only (no providerId).
    mutationFn: async (account: { id: string }) => {
      const { error } = await authClient.unlinkAccount({ accountId: account.id });
      // FAILED_TO_UNLINK_LAST_ACCOUNT -> copy.unlinkRefused (PLAN M1 AC 3).
      if (error) throw new Error(authErrorMessage(error));
    },
    onSuccess: async () => {
      toaster.create({ type: 'success', title: copy.unlinkDone });
      await invalidate();
    },
    onError: (error) => toaster.create({ type: 'error', title: error.message }),
  });

  const list = accounts.data ?? [];
  const canUnlink = list.length > 1;
  const rows: Array<{ providerId: string; linked: (typeof list)[number] | undefined }> = [
    CREDENTIAL_PROVIDER_ID,
    ...SOCIAL_PROVIDERS,
  ].map((providerId) => ({ providerId, linked: list.find((a) => a.providerId === providerId) }));

  return (
    <SettingsSection
      title={copy.settingsLinkedAccounts}
      hint={copy.settingsLinkedHint}
      testId="settings-accounts"
    >
      <Stack gap="4">
        {linkError && (
          <Alert.Root status="error" role="alert" data-testid="link-error">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{linkErrorMessage(linkError)}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
        {accounts.isPending ? (
          <Skeleton height="32" />
        ) : (
          <Stack gap="3" divideY="1px">
            {rows.map(({ providerId, linked }) => (
              <HStack key={providerId} justify="space-between" pt="3" _first={{ pt: 0 }}>
                <HStack gap="2">
                  <Text fontWeight="medium">{PROVIDER_LABEL[providerId] ?? providerId}</Text>
                  <Badge colorPalette={linked ? 'yes' : 'gray'} variant="subtle">
                    {linked ? copy.linked : copy.notLinked}
                  </Badge>
                </HStack>
                {linked ? (
                  <Button
                    size="sm"
                    variant="outline"
                    colorPalette="no"
                    disabled={!canUnlink}
                    loading={unlink.isPending && unlink.variables?.id === linked.id}
                    onClick={() => unlink.mutate({ id: linked.id })}
                    data-testid={`unlink-${providerId}`}
                  >
                    {copy.unlink}
                  </Button>
                ) : providerId !== CREDENTIAL_PROVIDER_ID ? (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={link.isPending && link.variables === providerId}
                    onClick={() => link.mutate(providerId as SocialProvider)}
                    data-testid={`link-${providerId}`}
                  >
                    {copy.link}
                  </Button>
                ) : null}
              </HStack>
            ))}
          </Stack>
        )}
      </Stack>
    </SettingsSection>
  );
}
