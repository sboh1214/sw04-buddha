'use client';

import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  HStack,
  Heading,
  Link as ChakraLink,
  Portal,
  RadioGroup,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import {
  LINK_FLAG_REVIEW_OUTCOMES,
  type LinkFlagListStatus,
  type LinkFlagReviewOutcome,
} from '@buddha/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  LINK_FLAG_NOTE_MAX_LENGTH,
  linkFlagFlaggedAt,
  linkFlagGroupActionLabel,
  linkFlagGroupCount,
  linkFlagGroupKey,
  linkFlagGroupLatest,
  linkFlagItemPath,
  linkFlagKindLabel,
  linkFlagOutcomeLabel,
  linkFlagReasonLabel,
  linkFlagReviewErrorMessage,
  linkFlagReviewKeepsDialog,
  linkFlagReviewedBy,
  linkFlagStates,
  linkFlagWrittenAt,
  toLinkFlagReviewBody,
} from '@/lib/admin-link-flags';
import { type AdminLinkFlag, type AdminLinkFlagGroup, api, unwrap } from '@/lib/api';
import { ADMIN_MODERATION_ACTIONS_PATH, adminUserModerationPath } from '@/lib/moderation';
import { readFailed } from '@/lib/query-client';
import { ModerationNav } from '../moderation-parts';

const ADMIN_LINK_FLAGS_KEY = ['admin', 'link-flags'] as const;

/**
 * 반복 링크 검토 목록 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187; owner decision
 * 2026-10-22): the posts and comments a repetition rule caught, grouped by link and rule — one row
 * per link and rule with how many entries and the latest time («같은 주소·규칙끼리 묶어 항목 수
 * 보임»), 20 rows a page with 더 보기. A row opens to its entries (항목 보기, 20 a page). An operator
 * marks a row '확인함' with what came of it ('문제 없음' or '조치함') and an optional note — recorded
 * on the server (`admin_actions`) — and it leaves the default list; '확인함' shows the marks. The
 * post stays as it is (decision 4 #187 «글은 그대로 보임»): hiding, warning or restricting is #50's
 * moderation, whose area this page is part of (its row of links, `ModerationNav`) — an entry leads
 * to its item's moderation page, and a group marked '조치함' to the action log.
 *
 * A marked row leaves the list it was on, its 확인함으로 표시 with it: once the list is read again,
 * a focus left on nothing goes to the list's pressed button, not to the page's start.
 */
export function AdminLinkFlags() {
  const [status, setStatus] = useState<LinkFlagListStatus>('open');
  const pressed = useRef<HTMLButtonElement>(null);
  const focusAfterMark = useRef(false);
  const groups = useInfiniteQuery({
    queryKey: [...ADMIN_LINK_FLAGS_KEY, status],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/link-flags', {
          params: { query: pageParam ? { status, cursor: pageParam } : { status } },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
  const rows = groups.data?.pages.flatMap((page) => page.items) ?? [];
  // Once the list is drawn again after a mark: its row gone or not, or the read failed.
  useEffect(() => {
    if (!focusAfterMark.current) return;
    focusAfterMark.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) pressed.current?.focus();
  }, [groups.dataUpdatedAt, groups.errorUpdatedAt]);
  const onMarked = () => {
    focusAfterMark.current = true;
  };

  return (
    <Stack gap="4" data-testid="admin-link-flags">
      <ModerationNav />
      <Heading as="h3" size="lg">
        {copy.adminLinkFlags}
      </Heading>
      <Text color="fg.muted">{copy.adminLinkFlagsIntro}</Text>
      <HStack gap="2" role="group" aria-label={copy.adminLinkFlags}>
        {(['open', 'reviewed'] as const).map((value) => (
          <Button
            key={value}
            ref={status === value ? pressed : undefined}
            size="sm"
            variant={status === value ? 'solid' : 'outline'}
            aria-pressed={status === value}
            onClick={() => setStatus(value)}
            data-testid={`admin-link-flags-${value}`}
          >
            {value === 'open' ? copy.adminLinkFlagsOpen : copy.adminLinkFlagsReviewed}
          </Button>
        ))}
      </HStack>
      {groups.isPending ? (
        <Skeleton height="24" />
      ) : readFailed(groups) ? (
        <ErrorAlert />
      ) : rows.length === 0 ? (
        <Text color="fg.muted" data-testid="admin-link-flags-empty">
          {status === 'open' ? copy.adminNoLinkFlags : copy.adminNoReviewedLinkFlags}
        </Text>
      ) : (
        <Stack gap="2">
          {rows.map((group) => (
            <LinkFlagGroupRow key={linkFlagGroupKey(group)} group={group} onMarked={onMarked} />
          ))}
        </Stack>
      )}
      {groups.hasNextPage && (
        <>
          {/* A 더 보기 that failed: the rows stay, and this says so above the button that asks
              again (owner decision 2026-10-20 7, as every 더 보기 list). */}
          <LoadMoreFailed
            list={groups}
            message={copy.errUnknown}
            data-testid="admin-link-flags-more-failed"
          />
          <Button
            alignSelf="center"
            size="sm"
            variant="ghost"
            loading={groups.isFetchingNextPage}
            onClick={() => void groups.fetchNextPage()}
            data-testid="admin-link-flags-more"
          >
            {copy.loadMore}
          </Button>
        </>
      )}
    </Stack>
  );
}

function ErrorAlert() {
  return (
    <Alert.Root status="error" role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{copy.errUnknown}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

/**
 * One row: the rule, how many entries and the latest time, the link as the rules compared it
 * (plain text, never a link — an operator copies it rather than following a link someone
 * repeats), and — reviewed — the mark: what came of it, who and when, the note. 항목 보기 opens the
 * entries; 확인함으로 표시 (default list only) opens the mark's dialog. Both buttons are named after
 * the row (its rule and link), as every row has the same two.
 */
function LinkFlagGroupRow({
  group,
  onMarked,
}: {
  group: AdminLinkFlagGroup;
  onMarked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const regionId = useId();
  const { review } = group;
  const toggleText = open ? copy.adminLinkFlagHideItems : copy.adminLinkFlagShowItems;
  return (
    <Stack
      as="article"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      gap="1.5"
      data-testid="admin-link-flag-group"
      data-reason={group.reason}
      data-url={group.url}
    >
      <HStack justify="space-between" gap="3" flexWrap="wrap">
        <HStack gap="2" flexWrap="wrap">
          <Badge colorPalette="orange" variant="subtle" data-testid="admin-link-flag-reason">
            {linkFlagReasonLabel(group.reason)}
          </Badge>
          <Text fontSize="sm" data-testid="admin-link-flag-count">
            {linkFlagGroupCount(group)}
          </Text>
        </HStack>
        <Text fontSize="sm" color="fg.muted" data-testid="admin-link-flag-latest">
          {linkFlagGroupLatest(group)}
        </Text>
      </HStack>
      <Text fontSize="sm" fontFamily="mono" wordBreak="break-all" data-testid="admin-link-flag-url">
        {group.url}
      </Text>
      {review !== null && (
        <Stack gap="1" data-testid="admin-link-flag-review">
          <HStack gap="2" flexWrap="wrap" fontSize="sm">
            <Badge
              colorPalette={review.outcome === 'actioned' ? 'blue' : 'gray'}
              variant="subtle"
              data-testid="admin-link-flag-outcome"
            >
              {`${copy.adminLinkFlagsReviewed} · ${linkFlagOutcomeLabel(review.outcome)}`}
            </Badge>
            <Text color="fg.muted" data-testid="admin-link-flag-reviewed-by">
              {linkFlagReviewedBy(review)}
            </Text>
          </HStack>
          {review.note !== null && (
            <Text fontSize="sm" whiteSpace="pre-wrap" data-testid="admin-link-flag-note">
              {review.note}
            </Text>
          )}
          {review.outcome === 'actioned' && (
            <ChakraLink asChild colorPalette="brand" color="colorPalette.fg" fontSize="sm">
              <NextLink href={ADMIN_MODERATION_ACTIONS_PATH} data-testid="admin-link-flag-actions">
                {copy.adminModerationActions}
              </NextLink>
            </ChakraLink>
          )}
        </Stack>
      )}
      <HStack gap="2" flexWrap="wrap">
        <Button
          size="xs"
          variant="ghost"
          aria-label={linkFlagGroupActionLabel(group, toggleText)}
          aria-expanded={open}
          aria-controls={open ? regionId : undefined}
          onClick={() => setOpen((was) => !was)}
          data-testid="admin-link-flag-toggle"
        >
          {toggleText}
        </Button>
        {review === null && (
          <Button
            size="xs"
            variant="outline"
            aria-label={linkFlagGroupActionLabel(group, copy.adminLinkFlagReview)}
            onClick={() => setMarking(true)}
            data-testid="admin-link-flag-review-open"
          >
            {copy.adminLinkFlagReview}
          </Button>
        )}
      </HStack>
      {open && <LinkFlagItems id={regionId} group={group} />}
      {marking && (
        <ReviewDialog group={group} onClose={() => setMarking(false)} onMarked={onMarked} />
      )}
    </Stack>
  );
}

/**
 * A group's entries, newest first, 20 a page with 더 보기 — in one region (`id`, the toggle's
 * `aria-controls`) whatever state it is in. None at all: the row was read before its entries left
 * it (another operator marked them, or they were deleted), so it says so and its list is read
 * again, once, which drops the row.
 */
function LinkFlagItems({ id, group }: { id: string; group: AdminLinkFlagGroup }) {
  const queryClient = useQueryClient();
  const reviewId = group.review?.id;
  const items = useInfiniteQuery({
    queryKey: [...ADMIN_LINK_FLAGS_KEY, 'items', group.url, group.reason, reviewId ?? null],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const query = {
        url: group.url,
        reason: group.reason,
        ...(reviewId === undefined ? {} : { reviewId }),
        ...(pageParam ? { cursor: pageParam } : {}),
      };
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/link-flags/items', { params: { query } }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
  const rows = items.data?.pages.flatMap((page) => page.items) ?? [];
  const gone = items.isSuccess && rows.length === 0;
  const listRead = useRef(false);
  useEffect(() => {
    if (!gone || listRead.current) return;
    listRead.current = true;
    // The row's own list only: the entries' queries sit beside it under ADMIN_LINK_FLAGS_KEY, and
    // reading this one again would only find none again.
    void queryClient.invalidateQueries({
      queryKey: [...ADMIN_LINK_FLAGS_KEY, group.review === null ? 'open' : 'reviewed'],
    });
  }, [gone, group.review, queryClient]);

  return (
    <Stack id={id} gap="2" ps={{ base: '0', md: '3' }} data-testid="admin-link-flag-items">
      {items.isPending ? (
        <Skeleton height="16" />
      ) : readFailed(items) ? (
        <ErrorAlert />
      ) : gone ? (
        <Text fontSize="sm" color="fg.muted" data-testid="admin-link-flag-items-empty">
          {copy.adminLinkFlagItemsGone}
        </Text>
      ) : (
        rows.map((flag) => <LinkFlagEntry key={flag.id} flag={flag} />)
      )}
      {items.hasNextPage && (
        <>
          <LoadMoreFailed
            list={items}
            message={copy.errUnknown}
            data-testid="admin-link-flag-items-more-failed"
          />
          <Button
            alignSelf="center"
            size="xs"
            variant="ghost"
            loading={items.isFetchingNextPage}
            onClick={() => void items.fetchNextPage()}
            data-testid="admin-link-flag-items-more"
          >
            {copy.loadMore}
          </Button>
        </>
      )}
    </Stack>
  );
}

/**
 * One entry: the item — a 근거 글 or a 댓글, its excerpt linking to its moderation page (#50) — its
 * author (their moderation page), its market (the admin market screen), when it was caught and
 * written, and what became of it since (edited, deleted, hidden).
 */
function LinkFlagEntry({ flag }: { flag: AdminLinkFlag }) {
  const { target } = flag;
  const states = linkFlagStates(target);
  return (
    <Stack
      borderWidth="1px"
      borderRadius="l2"
      p="2.5"
      gap="1"
      data-testid={`admin-link-flag-${flag.id}`}
    >
      <HStack gap="2" align="baseline" minW="0">
        <Text fontSize="sm" color="fg.muted" flexShrink={0}>
          {linkFlagKindLabel(target.kind)}
        </Text>
        <ChakraLink asChild colorPalette="brand" color="colorPalette.fg" minW="0">
          <NextLink
            href={linkFlagItemPath(target) as Route}
            data-testid="admin-link-flag-item"
            style={{ overflowWrap: 'anywhere' }}
          >
            {target.excerpt}
          </NextLink>
        </ChakraLink>
      </HStack>
      <HStack gap="3" flexWrap="wrap" fontSize="sm" color="fg.muted">
        <Text>
          {copy.adminLinkFlagAuthor}{' '}
          <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
            <NextLink
              href={adminUserModerationPath(target.author.userId) as Route}
              data-testid="admin-link-flag-author"
            >
              {target.author.nickname}
            </NextLink>
          </ChakraLink>
        </Text>
        <Text>
          {copy.adminLinkFlagMarket}{' '}
          <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
            <NextLink
              href={`/admin/markets/${target.market.id}` as Route}
              data-testid="admin-link-flag-market"
            >
              {target.market.title}
            </NextLink>
          </ChakraLink>
        </Text>
        <Text>{linkFlagFlaggedAt(flag)}</Text>
        <Text>{linkFlagWrittenAt(target)}</Text>
      </HStack>
      {states.length > 0 && (
        <HStack gap="2" flexWrap="wrap" data-testid="admin-link-flag-states">
          {states.map((state) => (
            <Badge key={state} variant="outline" size="sm">
              {state}
            </Badge>
          ))}
        </HStack>
      )}
    </Stack>
  );
}

/**
 * The mark '확인함' (owner decision 2026-10-22): what came of it — required, '문제 없음' or
 * '조치함' — and an optional note, sent with the row's latest time as the server's `through`, so
 * an entry that arrived after the operator looked stays on the default list. Pinned while the
 * request runs, as the other admin dialogs are. Done, or refused by the API — nothing left to mark
 * (another operator marked it first) or any other answer — the dialog closes with a toast and both
 * lists are read again (`onMarked` first, so the focus finds its way once they are). A request
 * that never came back decided nothing: the toast, and the dialog stays with the outcome and the
 * note for the operator to send again (`linkFlagReviewKeepsDialog`, as the other admin dialogs).
 */
function ReviewDialog({
  group,
  onClose,
  onMarked,
}: {
  group: AdminLinkFlagGroup;
  onClose: () => void;
  onMarked: () => void;
}) {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<LinkFlagReviewOutcome | null>(null);
  const [note, setNote] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ADMIN_LINK_FLAGS_KEY });
  const review = useMutation({
    mutationFn: async (chosen: LinkFlagReviewOutcome) =>
      unwrap(
        await api.POST('/api/v1/admin/link-flags/reviews', {
          body: toLinkFlagReviewBody(group, chosen, note),
        }),
      ).data,
    onSuccess: async () => {
      toaster.create({ type: 'success', title: copy.adminLinkFlagReviewDone });
      onMarked();
      onClose();
      await refresh();
    },
    onError: async (error) => {
      toaster.create({ type: 'error', title: linkFlagReviewErrorMessage(error) });
      if (linkFlagReviewKeepsDialog(error)) return;
      onMarked();
      onClose();
      await refresh();
    },
  });
  const loading = review.isPending;

  return (
    <Dialog.Root
      open
      onOpenChange={(details) => {
        if (!details.open && !loading) onClose();
      }}
      lazyMount
      unmountOnExit
      closeOnInteractOutside={!loading}
      closeOnEscape={!loading}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content data-testid="admin-link-flag-review-dialog">
            <Dialog.Header>
              <Dialog.Title>{copy.adminLinkFlagReviewTitle}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="3">
                <Text>{copy.adminLinkFlagReviewBody}</Text>
                <Text fontSize="sm" fontFamily="mono" wordBreak="break-all">
                  {group.url}
                </Text>
                <Text fontSize="sm" color="fg.muted">
                  {`${linkFlagReasonLabel(group.reason)} · ${linkFlagGroupCount(group)}`}
                </Text>
                <RadioGroup.Root
                  name="outcome"
                  value={outcome}
                  onValueChange={(details) => {
                    const chosen = LINK_FLAG_REVIEW_OUTCOMES.find(
                      (value) => value === details.value,
                    );
                    if (chosen !== undefined) setOutcome(chosen);
                  }}
                  colorPalette="brand"
                >
                  {/* The group's accessible name is its own Label part (as the 판정 dialog's). */}
                  <RadioGroup.Label fontWeight="medium" mb="1">
                    {copy.adminLinkFlagOutcome}
                  </RadioGroup.Label>
                  <HStack gap="6">
                    {LINK_FLAG_REVIEW_OUTCOMES.map((value) => (
                      <RadioGroup.Item
                        key={value}
                        value={value}
                        data-testid={`admin-link-flag-outcome-${value}`}
                      >
                        <RadioGroup.ItemHiddenInput />
                        <RadioGroup.ItemIndicator />
                        <RadioGroup.ItemText>{linkFlagOutcomeLabel(value)}</RadioGroup.ItemText>
                      </RadioGroup.Item>
                    ))}
                  </HStack>
                </RadioGroup.Root>
                <Field.Root>
                  <Field.Label>{copy.adminLinkFlagNote}</Field.Label>
                  <Textarea
                    rows={3}
                    maxLength={LINK_FLAG_NOTE_MAX_LENGTH}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    data-testid="admin-link-flag-review-note"
                  />
                </Field.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={onClose}
                data-testid="admin-link-flag-review-cancel"
              >
                {copy.cancel}
              </Button>
              <Button
                size="sm"
                loading={loading}
                disabled={outcome === null}
                onClick={() => {
                  if (outcome !== null) review.mutate(outcome);
                }}
                data-testid="admin-link-flag-review-confirm"
              >
                {copy.adminLinkFlagReview}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
