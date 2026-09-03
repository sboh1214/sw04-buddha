'use client';

import { Button, Stack } from '@chakra-ui/react';
import { useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { SOCIAL_PROVIDERS, authErrorMessage, signIn, type SocialProvider } from '@/lib/auth-client';

const LABEL: Record<SocialProvider, string> = {
  google: copy.continueWithGoogle,
  kakao: copy.continueWithKakao,
  naver: copy.continueWithNaver,
};

// Brand-ish colours, but the label always names the provider (PLAN 11.2: never colour alone).
const STYLE: Record<SocialProvider, { bg: string; color: string; borderColor?: string }> = {
  google: { bg: 'bg', color: 'fg', borderColor: 'border' },
  kakao: { bg: '#FEE500', color: '#191919' },
  naver: { bg: '#03C75A', color: 'white' },
};

/**
 * Google / Kakao / Naver buttons. Calls `signIn.social`, which redirects the browser to the
 * provider; on return better-auth lands on `callbackURL` (`/api/auth/callback/:provider`
 * is handled by the API behind the rewrite). The API decides which providers are configured;
 * an unconfigured one fails with PROVIDER_NOT_FOUND -> Korean toast (PLAN 17 Q11 fallback).
 */
export function SocialButtons({ callbackURL }: { callbackURL: string }) {
  const [busy, setBusy] = useState<SocialProvider | null>(null);

  async function start(provider: SocialProvider) {
    setBusy(provider);
    const { error } = await signIn.social({
      provider,
      callbackURL,
      errorCallbackURL: '/login?error=social',
    });
    if (error) {
      setBusy(null);
      toaster.create({ type: 'error', title: authErrorMessage(error, copy.socialUnavailable) });
    }
    // On success the fetch plugin has already navigated to the provider.
  }

  return (
    <Stack gap="2">
      {SOCIAL_PROVIDERS.map((provider) => (
        <Button
          key={provider}
          type="button"
          size="lg"
          variant="outline"
          onClick={() => void start(provider)}
          loading={busy === provider}
          disabled={busy !== null && busy !== provider}
          data-provider={provider}
          {...STYLE[provider]}
          _hover={{ opacity: 0.9 }}
        >
          {LABEL[provider]}
        </Button>
      ))}
    </Stack>
  );
}
