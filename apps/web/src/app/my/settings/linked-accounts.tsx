'use client';

import { Alert, Badge, Button, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { ACCOUNTS_QUERY_KEY, ME_QUERY_KEY, useLinkedAccounts, useMe } from '@/hooks/use-me';
import { useAuthSessionChanged } from '@/hooks/use-session-changed';
import {
  CREDENTIAL_PROVIDER_ID,
  SOCIAL_PROVIDERS,
  authClient,
  authErrorMessage,
  type SocialProvider,
} from '@/lib/auth-client';
import { MY_SETTINGS_PATH } from '@/lib/my';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

const PROVIDER_LABEL: Record<string, string> = {
  [CREDENTIAL_PROVIDER_ID]: copy.providerCredential,
  google: copy.providerGoogle,
  kakao: copy.providerKakao,
  naver: copy.providerNaver,
};

/**
 * Linked login methods (PLAN 10.3). Reads better-auth `listAccounts` directly (the source of
 * truth for `account` rows, incl. the account id `unlinkAccount` needs); `GET /me` also
 * carries the list, so both caches are invalidated after link/unlink.
 * The 해제 button is disabled when only one method remains; the server enforces the same
 * rule (better-auth refuses to unlink the last account unless `allowUnlinkingAll`).
 * A failed provider round-trip comes back as `/my/settings?error=<code>` (settings-notice.tsx).
 *
 * 연결 names the account of this screen's `Me` beside better-auth's own body, and the API's hook
 * compares it with the cookie's (ADR-0092): in the render between the session naming B and
 * SessionCacheGuard's reset the card is still A's while the cookie is B's, and a link taken with
 * B's cookie would put the provider A picked on B. Refused, nothing is linked and the session is
 * asked for again. So the card waits for `GET /me`, as every other MY 설정 card does, and shows
 * what they show while it is read and when it fails (`ProfileUnavailable` — the skeleton, then
 * `copy.errProfileLoad` with 다시 시도; owner decision 2026-10-26 17:21 answer 6 «다른 카드처럼
 * 보임», as the password card since ADR-0091): before, the rows and 해제 stood while 연결 stayed off
 * with no reason and no retry. 해제 needs no account: it names a login method by its row id, which
 * better-auth looks up among the cookie's account's rows only.
 */
export function LinkedAccounts() {
  const queryClient = useQueryClient();
  const accounts = useLinkedAccounts();
  // The account this screen's `Me` is: the card is drawn once `GET /me` has answered.
  const { data: me, isPending: mePending } = useMe();
  const sessionChanged = useAuthSessionChanged();

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
    ]);

  const link = useMutation({
    mutationFn: async ({ provider, account }: { provider: SocialProvider; account: string }) => {
      const { error } = await authClient.linkSocial(
        {
          provider,
          callbackURL: MY_SETTINGS_PATH,
          errorCallbackURL: `${MY_SETTINGS_PATH}?error=link`,
        },
        // better-auth's body has no account; the client merges this one into it.
        { body: { expectedAccountId: account } },
      );
      if (error) {
        throw new Error(
          sessionChanged(error)
            ? copy.sessionChanged
            : authErrorMessage(error, copy.socialUnavailable),
        );
      }
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
      {/* `!me` covers a failed /me AND the session-gone case, where the query never runs — as the
          address and password cards do. */}
      {mePending || !me ? (
        <ProfileUnavailable />
      ) : accounts.isPending ? (
        <Skeleton height="32" />
      ) : accounts.isError ? (
        // `data ?? []` would draw every method as 미연결, which is the same false claim the
        // password section makes when it offers "설정" to an account that has a password.
        <Stack gap="3" align="flex-start">
          <Alert.Root status="error" role="alert" data-testid="accounts-error">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{accounts.error.message}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button
            size="sm"
            variant="outline"
            loading={accounts.isFetching}
            onClick={() => void accounts.refetch()}
          >
            {copy.retry}
          </Button>
        </Stack>
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
                  loading={link.isPending && link.variables?.provider === providerId}
                  onClick={() =>
                    link.mutate({ provider: providerId as SocialProvider, account: me.id })
                  }
                  data-testid={`link-${providerId}`}
                >
                  {copy.link}
                </Button>
              ) : null}
            </HStack>
          ))}
        </Stack>
      )}
    </SettingsSection>
  );
}
