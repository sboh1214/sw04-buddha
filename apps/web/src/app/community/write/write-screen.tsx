'use client';

import { Alert, Badge, Box, Button, HStack, Heading, Stack, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { SanctionBanner } from '@/components/moderation/sanction-banner';
import { MarketPicker } from '@/components/post/market-picker';
import { PostForm } from '@/components/post/post-form';
import { WriteGate } from '@/components/post/write-gate';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { useCreatePost } from '@/hooks/use-posts';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import {
  type WriteMarket,
  type WriteMarketLookup,
  postPath,
  postWriteErrorMessage,
  refusedImageIds,
  writePath,
  writeScreenMarket,
  writeScreenStart,
  writeScreenView,
} from '@/lib/posts';
import { type Refusal, refusalOf } from '@/lib/restriction';
import { useSession } from '@/lib/use-session';

/**
 * 글쓰기: with a market, the form under that market's title (#45-4: the market is chosen once and
 * never changed once sent — before that, '다른 시장 고르기' opens the picker in place and keeps
 * the title, the body and its images); without one, the picker, which puts the market picked into
 * the address (`?market=`), so a reload or a sign-in comes back to it. A post is sent once, then
 * the screen goes to its page. Above either, for a member under a writing restriction in force
 * (#185, ADR-0082), its banner (`SanctionBanner`, ADR-0069 decision 4 #50) — the form stays, and
 * sending it is refused with the restriction's end and the way to 조치·신고 내역
 * (`postWriteErrorMessage`, `isRestricted`). An account restriction (#139, ADR-0085) shows on the
 * same banner — #50's «진행 중인 제재가 있으면 … 글쓰기 화면의 안내 띠» — though it refuses no post
 * (ADR-0069 decision 1 #57-12; ADR-0085 7-10, asked).
 *
 * The market the form shows is the screen's own (`writeScreenMarket`, lib/posts.ts, where every
 * step of it is tested): the page's read (`lookup`) settles it as it comes, and a market picked
 * shows at once. Only the API's «no such market» takes the form away; a read that failed keeps it —
 * the market just picked, the draft under it — and, with no form yet, says so and offers to read
 * again (`writeScreenView`; Codex review of #219, round 2: every failure read as no market, and the
 * picker took the draft's place).
 */
export function WriteScreen({ lookup }: { lookup: WriteMarketLookup }) {
  const router = useRouter();
  const [held, setHeld] = useState(() => writeScreenStart(lookup));
  // A new read of the page (after a pick, a retry) comes as a new object, taken in as it comes.
  const market = writeScreenMarket(held, { kind: 'read', lookup });
  if (market !== held) setHeld(market);
  const view = writeScreenView(market);
  const [retrying, startRetry] = useTransition();
  // A market picked shows at once; its address follows, and the page's read of it then settles it.
  const pick = (picked: WriteMarket) => {
    setHeld((current) => writeScreenMarket(current, { kind: 'picked', market: picked }));
    router.replace(writePath(picked.id) as Route);
  };
  return (
    <Stack gap="6" data-testid="post-write-screen">
      <Heading as="h2" textStyle="headline">
        {copy.postWriteTitle}
      </Heading>
      <WriteGate back={view.back}>
        {(writer) => (
          <Stack gap="6">
            <SanctionBanner testId="post-write-sanction-banner" />
            {view.kind === 'form' ? (
              <WriteForm market={view.market} accountId={writer.accountId} onRepick={pick} />
            ) : view.kind === 'failed' ? (
              <Stack gap="3" align="flex-start" data-testid="post-write-market-failed">
                <Alert.Root status="error" role="alert">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{copy.postWriteMarketLoadError}</Alert.Description>
                  </Alert.Content>
                </Alert.Root>
                <Button
                  size="sm"
                  variant="outline"
                  loading={retrying}
                  onClick={() => startRetry(() => router.refresh())}
                  data-testid="post-write-market-retry"
                >
                  {copy.retry}
                </Button>
              </Stack>
            ) : (
              <MarketPicker
                prompt={copy.marketPickerPrompt}
                onPick={pick}
                testId="post-write-market-picker"
              />
            )}
          </Stack>
        )}
      </WriteGate>
    </Stack>
  );
}

/**
 * The market box and the form. Changing the market keeps the draft: the picker opens inside the
 * box, and the market picked shows at once and replaces the address's (`onRepick` — the screen's
 * `router.replace`), which re-renders the page with the new market while this component — and the
 * form and the editor under it, which hold the draft — stays mounted (nothing here is keyed by the
 * market). A link to the bare picker would have unmounted the form and lost the draft.
 */
function WriteForm({
  market,
  accountId,
  onRepick,
}: {
  market: WriteMarket;
  accountId: string;
  onRepick: (market: WriteMarket) => void;
}) {
  const router = useRouter();
  const { refetch: refetchSession } = useSession();
  const create = useCreatePost(() => void refetchSession());
  const format = useFormatDateTime();
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
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
                  onRepick(picked);
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
        errorMessage={refusal?.message}
        errorRestricted={refusal?.restricted}
        refusedImageIds={refusedImageIds(create.error)}
        onSubmit={({ title, body }) => {
          setRefusal(undefined);
          create.mutate(
            { marketId: market.id, title, body, expectedAccountId: accountId },
            {
              onSuccess: (post) => router.push(postPath(post.id) as Route),
              onError: (error) =>
                setRefusal(refusalOf(error, postWriteErrorMessage(error, format))),
            },
          );
        }}
      />
    </Stack>
  );
}
