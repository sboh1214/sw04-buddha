'use client';

import { Badge, Box, Button, HStack, Heading, Stack, Text } from '@chakra-ui/react';
import { type MarketStatus } from '@buddha/shared';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { MarketPicker } from '@/components/post/market-picker';
import { PostForm } from '@/components/post/post-form';
import { WriteGate } from '@/components/post/write-gate';
import { copy } from '@/copy';
import { useCreatePost } from '@/hooks/use-posts';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { postPath, postWriteErrorMessage, refusedImageIds, writePath } from '@/lib/posts';
import { useSession } from '@/lib/use-session';

/** The market a new post goes to, as the server page read it. */
export interface WriteMarket {
  id: string;
  title: string;
  status: MarketStatus;
}

/**
 * 글쓰기: with a market, the form under that market's title (#45-4: the market is chosen once and
 * never changed once sent — before that, '다른 시장 고르기' opens the picker in place and keeps
 * the title, the body and its images); without one, the picker, which puts the market picked into
 * the address (`?market=`), so a reload or a sign-in comes back to it. A post is sent once, then
 * the screen goes to its page.
 */
export function WriteScreen({ market }: { market: WriteMarket | null }) {
  const router = useRouter();
  return (
    <Stack gap="6" data-testid="post-write-screen">
      <Heading as="h2" textStyle="headline">
        {copy.postWriteTitle}
      </Heading>
      <WriteGate back={writePath(market?.id)}>
        {(writer) =>
          market === null ? (
            <MarketPicker
              prompt={copy.marketPickerPrompt}
              onPick={(picked) => router.replace(writePath(picked.id) as Route)}
              testId="post-write-market-picker"
            />
          ) : (
            <WriteForm market={market} accountId={writer.accountId} />
          )
        }
      </WriteGate>
    </Stack>
  );
}

/**
 * The market box and the form. Changing the market keeps the draft: the picker opens inside the
 * box, and the market picked replaces the address's (`router.replace`), which re-renders the page
 * with the new market while this component — and the form and the editor under it, which hold the
 * draft — stays mounted (nothing here is keyed by the market). A link to the bare picker would
 * have unmounted the form and lost the draft.
 */
function WriteForm({ market, accountId }: { market: WriteMarket; accountId: string }) {
  const router = useRouter();
  const { refetch: refetchSession } = useSession();
  const create = useCreatePost(() => void refetchSession());
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [changing, setChanging] = useState(false);
  // Sent, or on its way to the post's page: the market is the post's now.
  const sent = create.isPending || create.isSuccess;
  return (
    <Stack gap="4">
      <Box
        p="4"
        borderWidth="1px"
        borderColor="border.subtle"
        borderRadius="card"
        bg="surface.card"
        data-testid="post-write-market"
      >
        <Stack gap="1.5">
          <Text textStyle="overline" color="fg.muted">
            {copy.postWriteMarketLabel}
          </Text>
          <HStack gap="2" flexWrap="wrap">
            <Text textStyle="title" data-testid="post-write-market-title">
              {market.title}
            </Text>
            {market.status !== 'open' && (
              <Badge size="sm" variant="subtle" colorPalette={MARKET_STATUS_PALETTE[market.status]}>
                {MARKET_STATUS_LABEL[market.status]}
              </Badge>
            )}
          </HStack>
          <Text textStyle="bodyXs" color="fg.muted">
            {copy.postWriteMarketHint}
          </Text>
          {changing && !sent ? (
            <Stack gap="2" pt="1">
              <MarketPicker
                prompt={copy.marketPickerPrompt}
                onPick={(picked) => {
                  setChanging(false);
                  setRefusal(undefined);
                  router.replace(writePath(picked.id) as Route);
                }}
                testId="post-write-market-repick"
              />
              <Button
                size="xs"
                variant="ghost"
                alignSelf="flex-start"
                px="0"
                onClick={() => setChanging(false)}
                data-testid="post-write-market-repick-cancel"
              >
                {copy.cancel}
              </Button>
            </Stack>
          ) : (
            <Button
              size="xs"
              variant="ghost"
              alignSelf="flex-start"
              px="0"
              disabled={sent}
              onClick={() => setChanging(true)}
              data-testid="post-write-market-change"
            >
              {copy.postWriteMarketChange}
            </Button>
          )}
        </Stack>
      </Box>
      <PostForm
        // The market on screen: a draft the onboarding gate keeps comes back on this market's
        // write screen, the address the onboarding returns to.
        draftKey={{ kind: 'new', marketId: market.id }}
        accountId={accountId}
        submitLabel={copy.postWriteSubmit}
        pending={sent}
        saved={create.isSuccess}
        errorMessage={refusal}
        refusedImageIds={refusedImageIds(create.error)}
        onSubmit={({ title, body }) => {
          setRefusal(undefined);
          create.mutate(
            { marketId: market.id, title, body, expectedAccountId: accountId },
            {
              onSuccess: (post) => router.push(postPath(post.id) as Route),
              onError: (error) => setRefusal(postWriteErrorMessage(error)),
            },
          );
        }}
      />
    </Stack>
  );
}
