'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  DataList,
  Field,
  HStack,
  Heading,
  Input,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { DISPUTE_LINKS_MAX, DISPUTE_REASON_MAX } from '@buddha/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useEffect, useState } from 'react';
import { DisputeItem, DisputeRetractDialog } from '@/components/disputes/dispute-item';
import { DateTimeText } from '@/components/time-zone/time-zone-provider';
import { EmptyState } from '@/components/ui/empty-state';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  useDisputeOpen,
  useMyMarketDispute,
  useRetractDispute,
  useSubmitDispute,
} from '@/hooks/use-disputes';
import { useMarketSocket } from '@/hooks/use-market-socket';
import { useMarket } from '@/hooks/use-markets';
import { useMe } from '@/hooks/use-me';
import { type Market, type MyDispute } from '@/lib/api';
import {
  DISPUTE_REFUSAL_TEXT,
  type DisputeFormValues,
  EMPTY_DISPUTE_FORM,
  MY_DISPUTES_PATH,
  disputeDraft,
  disputeRetractFailureMessage,
  disputeScreenView,
  disputeSubmitFailure,
  toSubmitDisputeBody,
} from '@/lib/disputes';
import { MARKET_RESULT_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { marketKey } from '@/lib/market-keys';
import { marketStatusLabel } from '@/lib/market-status';

/**
 * 판정 이의 제출 (#175, ADR-0104; ADR-0093 decision 1 #173 items 5·6·7·13): the market it is about —
 * its title (back to its detail), its status, its 잠정 결과 and 이의 기한 — whether the member may
 * dispute it now and why not, one sentence each (`disputeScreenView`), the form, the member's own
 * dispute of the current judgement version with its status, the decision's reason and 철회 while
 * the deadline is ahead, and the way to MY '판정 이의'. Above the form, that the links and the reason
 * are the operators' alone and never public (#173 item 13), and that this is no 제재 이의 (ADR-0084).
 * No market price, volume or count anywhere: a dispute argues the rule's source, never the market's
 * majority (N03 §5, as the judgement screens, #152 AC 8).
 *
 * The market is the live row the page seeded and the socket keeps (`useMarket`, `market:status`:
 * a confirmed market takes the form away); the deadline goes by the screen's one-shot timer from
 * the server's `now` (`useDisputeOpen`) — a held market publishes nothing then. The standing is
 * the member's (`GET /me/disputes/markets/:id`, private), read once the session is known; the form
 * is drawn for the account of `GET /me` and keyed by it (ADR-0091), and submits the version the
 * standing was read for — the server refuses a version a correction (#176) replaced since.
 */
export function DisputeScreen({ marketId, now }: { marketId: string; now?: number }) {
  useMarketSocket([marketId]);
  const queryClient = useQueryClient();
  const market = useMarket(marketId);
  const data = market.data;
  // At the deadline a held market publishes nothing: its badge turns 판정 지연 on a fresh read, as
  // the detail's (`StatusNotice`).
  const open = useDisputeOpen(data ?? { disputeOpen: false, disputeDeadline: null }, now, () => {
    if (data?.disputeUnderReview === true) {
      void queryClient.invalidateQueries({ queryKey: marketKey(marketId) });
    }
  });
  return (
    <Stack gap="6" data-testid="dispute-screen">
      <Stack gap="2">
        <Heading as="h2" size="2xl">
          {copy.disputeTitle}
        </Heading>
        <Text color="fg.muted">{copy.disputeIntro}</Text>
      </Stack>
      {data === undefined ? (
        market.isLoadingError ? (
          <EmptyState message={copy.errUnknown} data-testid="dispute-market-failed" />
        ) : (
          <Skeleton height="32" borderRadius="card" />
        )
      ) : (
        <>
          <DisputeMarketCard market={data} />
          <Alert.Root status="info" data-testid="dispute-notice">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.disputePrivacyNote}</Alert.Description>
              <Alert.Description>{copy.disputeNotAppealNote}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <DisputeStanding market={data} open={open} />
        </>
      )}
      <ChakraLink
        asChild
        alignSelf="flex-start"
        fontSize="sm"
        colorPalette="brand"
        color="colorPalette.fg"
      >
        <NextLink href={MY_DISPUTES_PATH} data-testid="dispute-my-link">
          {copy.myDisputesOpen}
        </NextLink>
      </ChakraLink>
    </Stack>
  );
}

/**
 * The market the dispute is about: its title (to its detail), its status as a member reads it
 * (`marketStatusLabel`: '이의 검토 중' while one holds it), its 잠정 결과 and its 이의 기한 in the
 * viewer's zone with the 판정 기준 시간대 (`DateTimeText`). No price, volume or count.
 */
function DisputeMarketCard({ market }: { market: Market }) {
  return (
    <Card.Root data-testid="dispute-market">
      <Card.Body>
        <Stack gap="3">
          <HStack gap="2" flexWrap="wrap" align="center">
            <Badge
              colorPalette={MARKET_STATUS_PALETTE[market.status]}
              variant="subtle"
              data-testid="dispute-market-status"
            >
              {marketStatusLabel(market)}
            </Badge>
            <ChakraLink asChild colorPalette="brand" color="colorPalette.fg" fontWeight="semibold">
              <NextLink href={`/markets/${market.slug}` as Route} data-testid="dispute-market-link">
                {market.title}
              </NextLink>
            </ChakraLink>
          </HStack>
          <DataList.Root orientation="horizontal" size="sm">
            {market.resolvedResult !== null && (
              <DataList.Item>
                {/* '잠정 결과' while it is one; '결과' once confirmed, as the detail's row. */}
                <DataList.ItemLabel>
                  {market.status === 'provisional'
                    ? copy.disputeProvisionalResult
                    : copy.marketResolvedResult}
                </DataList.ItemLabel>
                <DataList.ItemValue data-testid="dispute-market-result">
                  {MARKET_RESULT_LABEL[market.resolvedResult]}
                </DataList.ItemValue>
              </DataList.Item>
            )}
            {market.disputeDeadline !== null && (
              <DataList.Item alignItems="flex-start">
                <DataList.ItemLabel>{copy.marketDisputeDeadline}</DataList.ItemLabel>
                <DataList.ItemValue display="block" data-testid="dispute-market-deadline">
                  <DateTimeText
                    iso={market.disputeDeadline}
                    judgementTimeZone={market.judgementTimeZone}
                    testId="dispute-market-deadline"
                  />
                </DataList.ItemValue>
              </DataList.Item>
            )}
          </DataList.Root>
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * The member's part, drawn for the account of `GET /me` (keyed by it, ADR-0091): a placeholder
 * until it has answered, the profile's failure, else the standing and the form. A submission
 * refused as another account's is kept above the keyed body (`accountChanged`), so the body drawn
 * again for the account really signed in says why it started again (as `ProposalForm`).
 */
function DisputeStanding({ market, open }: { market: Market; open: boolean }) {
  const me = useMe();
  const [accountChanged, setAccountChanged] = useState<string | null>(null);
  if (me.data !== undefined) {
    return (
      <DisputeBody
        key={me.data.id}
        market={market}
        open={open}
        accountId={me.data.id}
        accountChanged={accountChanged}
        onAccountChanged={setAccountChanged}
      />
    );
  }
  if (me.isLoggedIn && me.isError) {
    return <EmptyState message={copy.errProfileLoad} data-testid="dispute-profile-failed" />;
  }
  return <Skeleton height="40" borderRadius="card" data-testid="dispute-standing-pending" />;
}

function DisputeBody({
  market,
  open,
  accountId,
  accountChanged,
  onAccountChanged,
}: {
  market: Market;
  open: boolean;
  accountId: string;
  accountChanged: string | null;
  onAccountChanged: (message: string | null) => void;
}) {
  // The standing of the account this body was drawn for (ADR-0091, `myMarketDisputeKey`).
  const standing = useMyMarketDispute(market.id, accountId);
  // A standing read for another judgement version than the live row's — the screen was opened on
  // the CLOSED market the socket has since moved to 잠정 결과, or before a correction (#176) — is
  // read again; until then it says nothing of this version (`disputeScreenView`).
  const stale =
    standing.data !== undefined &&
    market.judgementVersion !== null &&
    standing.data.judgementVersion !== market.judgementVersion;
  const { refetch } = standing;
  useEffect(() => {
    if (stale) void refetch();
  }, [stale, refetch]);
  const view = disputeScreenView({
    status: market.status,
    judgementVersion: market.judgementVersion,
    open,
    standing: standing.data,
    // A refetch's failure counts only while what is held is another version's.
    failed: standing.isLoadingError || (stale && standing.isRefetchError),
  });
  const own = stale ? null : (standing.data?.dispute ?? null);
  // The submit lives here, not in the form: a sent dispute turns the standing to 'duplicate' and
  // the form goes before the mutation settles, which would take its `mutate` callbacks with it.
  const submit = useSubmitDispute();
  const retract = useRetractDispute();
  const [retracting, setRetracting] = useState<MyDispute | null>(null);
  const confirmRetract = () => {
    if (retracting === null) return;
    retract.mutate(
      // The account the screen was drawn for rides along (`expectedAccountId`, A-PG-24).
      { id: retracting.id, marketId: market.id, expectedAccountId: accountId },
      {
        onSuccess: () => {
          toaster.create({ type: 'success', title: copy.disputeRetracted });
          setRetracting(null);
        },
        onError: (error) => {
          toaster.create({ type: 'error', title: disputeRetractFailureMessage(error) });
          setRetracting(null);
        },
      },
    );
  };
  return (
    <Stack gap="4" data-testid="dispute-standing" data-view={view.kind}>
      {accountChanged !== null && (
        <Alert.Root status="error" role="alert" data-testid="dispute-account-changed">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{accountChanged}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {view.kind === 'pending' ? (
        <Skeleton height="40" borderRadius="card" data-testid="dispute-standing-pending" />
      ) : view.kind === 'failed' ? (
        <Stack gap="2" align="flex-start" data-testid="dispute-standing-failed">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.disputeLoadFailed}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void standing.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : view.kind === 'closed' ? (
        // The one per version speaks for itself once the dispute is drawn below.
        (view.reason !== 'duplicate' || own === null) && (
          <Alert.Root
            status="info"
            role="status"
            data-testid="dispute-closed"
            data-reason={view.reason}
          >
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{DISPUTE_REFUSAL_TEXT[view.reason]}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )
      ) : (
        <DisputeForm
          submit={submit}
          marketId={market.id}
          judgementVersion={view.judgementVersion}
          accountId={accountId}
          onAccountChanged={onAccountChanged}
        />
      )}
      {own !== null && (
        <DisputeItem
          dispute={own}
          showMarket={false}
          accountKnown
          deadlineOpen={open}
          onRetract={() => setRetracting(own)}
        />
      )}
      <DisputeRetractDialog
        dispute={retracting}
        pending={retract.isPending}
        confirmDisabled={false}
        onClose={() => setRetracting(null)}
        onConfirm={confirmRetract}
      />
    </Stack>
  );
}

/** A server refusal under one field, a link's by its index (none: every link, their count). */
type FieldRefusal =
  { field: 'links'; index?: number; message: string } | { field: 'reason'; message: string };

/**
 * The form (#173 item 6 '내용과 건수'): 1..DISPUTE_LINKS_MAX 근거 링크, added and taken away, and the
 * reason with its count — both required — then 판정 이의 내기. It says once what the one per version
 * means (no edit, a 철회 still counts). Every rule is the API's (`disputeDraft`); a field's error
 * shows once the form was sent once, and a server refusal lands under its field or above the form
 * (`disputeSubmitFailure`). Sent, the standing takes the dispute (`storeDispute`) and the screen
 * draws it in the form's place.
 */
function DisputeForm({
  submit,
  marketId,
  judgementVersion,
  accountId,
  onAccountChanged,
}: {
  submit: ReturnType<typeof useSubmitDispute>;
  marketId: string;
  judgementVersion: number;
  accountId: string;
  onAccountChanged: (message: string | null) => void;
}) {
  const [values, setValues] = useState<DisputeFormValues>(EMPTY_DISPUTE_FORM);
  const [sent, setSent] = useState(false);
  const [refused, setRefused] = useState<FieldRefusal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const draft = disputeDraft(values);
  const pending = submit.isPending;
  const change = (next: DisputeFormValues) => {
    setValues(next);
    setRefused(null);
  };
  const linkError = (index: number): string | null => {
    if (refused?.field === 'links' && (refused.index === undefined || refused.index === index)) {
      return refused.message;
    }
    return sent ? (draft.errors.links[index] ?? null) : null;
  };
  const reasonError =
    refused?.field === 'reason' ? refused.message : sent ? draft.errors.reason : null;

  const onSubmit = () => {
    setSent(true);
    setRefused(null);
    setNotice(null);
    onAccountChanged(null);
    if (!draft.ready) return;
    submit.mutate(
      // The account the form was drawn for rides along (`expectedAccountId`, A-PG-24).
      { marketId, body: toSubmitDisputeBody(draft, judgementVersion, accountId) },
      {
        onSuccess: () => toaster.create({ type: 'success', title: copy.disputeSubmitted }),
        onError: (error) => {
          const failure = disputeSubmitFailure(error);
          if (failure.kind === 'field') setRefused(failure);
          else if (failure.kind === 'session') onAccountChanged(failure.message);
          else setNotice(failure.message);
        },
      },
    );
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) onSubmit();
      }}
      data-testid="dispute-form"
    >
      <Stack gap="5">
        <Text fontSize="sm" color="fg.muted" data-testid="dispute-once">
          {copy.disputeOnce}
        </Text>
        {notice !== null && (
          <Alert.Root status="error" role="alert" data-testid="dispute-form-error">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{notice}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
        {/* One field per link (the judgement form's): each input its own id, label and error. */}
        <Stack gap="2" w="full" data-testid="dispute-links">
          <Text fontWeight="medium">{copy.disputeLinks}</Text>
          <Text fontSize="sm" color="fg.muted">
            {copy.disputeLinksHint}
          </Text>
          {values.links.map((link, index) => {
            const error = linkError(index);
            return (
              <Field.Root key={index} invalid={error !== null} required>
                <HStack gap="2" w="full">
                  <Input
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    value={link}
                    disabled={pending}
                    aria-label={`${copy.disputeLinks} ${String(index + 1)}`}
                    onChange={(event) =>
                      change({
                        ...values,
                        links: values.links.map((held, at) =>
                          at === index ? event.target.value : held,
                        ),
                      })
                    }
                    data-testid={`dispute-link-${String(index)}`}
                  />
                  {values.links.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      flexShrink={0}
                      disabled={pending}
                      aria-label={`${copy.disputeLinks} ${String(index + 1)} ${copy.disputeLinkRemove}`}
                      onClick={() =>
                        change({ ...values, links: values.links.filter((_, at) => at !== index) })
                      }
                      data-testid={`dispute-link-remove-${String(index)}`}
                    >
                      {copy.disputeLinkRemove}
                    </Button>
                  )}
                </HStack>
                <Field.ErrorText data-testid={`dispute-link-${String(index)}-error`}>
                  {error}
                </Field.ErrorText>
              </Field.Root>
            );
          })}
          {values.links.length < DISPUTE_LINKS_MAX && (
            <Button
              size="xs"
              variant="outline"
              alignSelf="flex-start"
              disabled={pending}
              onClick={() => change({ ...values, links: [...values.links, ''] })}
              data-testid="dispute-link-add"
            >
              {copy.disputeLinkAdd}
            </Button>
          )}
        </Stack>

        <Field.Root invalid={reasonError !== null} required>
          <Field.Label>{copy.disputeReason}</Field.Label>
          <Textarea
            rows={6}
            value={values.reason}
            maxLength={DISPUTE_REASON_MAX}
            disabled={pending}
            onChange={(event) => change({ ...values, reason: event.target.value })}
            data-testid="dispute-reason"
          />
          <HStack justify="space-between" w="full" gap="3" align="flex-start">
            <Field.HelperText>{copy.disputeReasonHint}</Field.HelperText>
            <Text
              fontSize="xs"
              color="fg.muted"
              whiteSpace="nowrap"
              data-testid="dispute-reason-count"
            >
              {String(values.reason.length)} {copy.disputeReasonCountMax}
            </Text>
          </HStack>
          <Field.ErrorText data-testid="dispute-reason-error">{reasonError}</Field.ErrorText>
        </Field.Root>

        <Button type="submit" alignSelf="flex-start" loading={pending} data-testid="dispute-submit">
          {copy.disputeSubmitButton}
        </Button>
      </Stack>
    </form>
  );
}
