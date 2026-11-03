'use client';

import { Alert, Badge, Button, HStack, Stack, Text } from '@chakra-ui/react';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { copy } from '@/copy';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { type AdminJudgementDelay, type AdminMarket } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { type EventRow, judgementDelayEpisodeText } from '@/lib/market-admin';
import {
  JUDGEMENT_DELAY_UNAVAILABLE_NOTE,
  currentJudgementDelayRecord,
  judgementDelayActorName,
  judgementDelayInstantWait,
  judgementDelayLate,
  judgementDelayRows,
  judgementDelayStartsAt,
  judgementDelayUnavailable,
  judgementLongDelayDeadline,
  judgementLongDelayWarned,
  showsJudgementDelays,
} from '@/lib/market-judgement-delay';
import { type JudgementDelayAction, JudgementDelayDialog } from './market-judgement-delay-dialogs';

/**
 * '판정 지연 기록' in the 판정 panel (#142, ADR-0106; ADR-0093 decision 1 #173 items 2·7·11·13,
 * decision 3 '#142 지연 사유', the owner's answers of 2026-11-03 (1)–(4)), after the current
 * judgement and its 판정 이의: what it asks of the admin on screen (`JudgementDelaysBody`) and the
 * 지연 기록 등록 it opened, held for that admin (`useHeldForOperator`, ADR-0092 answer 1) — once
 * `['me']` turns from A to B in place, the dialog closes with what A typed. Drawn on a market
 * CLOSED or PROVISIONAL and on any with a record (`showsJudgementDelays`). Focus comes back to the
 * current record's heading — the one just made — once a record went through (WCAG 2.4.3), else to
 * the section's. `readAt` is when the row was read (the query's `dataUpdatedAt`), what the section
 * judges by until its own timers draw it again.
 */
export function MarketJudgementDelays({ market, readAt }: { market: AdminMarket; readAt: number }) {
  const operatorId = useOperatorId();
  const [action, setAction] = useHeldForOperator<JudgementDelayAction>();
  const title = useRef<HTMLParagraphElement>(null);
  const current = useRef<HTMLParagraphElement>(null);
  const closed = useRef<{ market: AdminMarket } | null>(null);
  useEffect(() => {
    const from = closed.current;
    // Wait for the market the record answered: the current record is the new one then.
    if (from === null || action !== null || from.market === market) return;
    closed.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    (current.current ?? title.current)?.focus();
  }, [action, market]);
  if (!showsJudgementDelays(market)) return null;
  return (
    <>
      <JudgementDelaysBody
        market={market}
        readAt={readAt}
        operatorId={operatorId}
        onOpen={setAction}
        targets={{ title, current }}
      />
      {action !== null && (
        <JudgementDelayDialog
          market={market}
          onClose={(sent) => {
            if (sent) closed.current = { market };
            setAction(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The clock the section judges by: `readAt` (the row as read), then — a CLOSED market's detail is
 * not polled, nor a held 잠정 결과's past its deadline — the clock again once `at` has come, by a
 * one-shot timer (`judgementDelayInstantWait`: a second past it, a day at most), so what changes at
 * that instant is drawn by itself, as the waiting registration's early warning goes. Admin screens
 * never render on the server: the clock in the timer is no hydration risk.
 */
function useClockPast(readAt: number, at: string | null): number {
  const [clock, setClock] = useState(readAt);
  const now = Math.max(readAt, clock);
  const ahead = judgementDelayInstantWait(at, now) !== null;
  useEffect(() => {
    if (!ahead) return;
    const wait = judgementDelayInstantWait(at, Date.now()) ?? 0;
    const timer = setTimeout(() => setClock(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [ahead, at, clock]);
  return now;
}

/** The section's elements focus comes back to: its heading and the current record's. */
export interface JudgementDelayFocusTargets {
  title: RefObject<HTMLParagraphElement | null>;
  current: RefObject<HTMLParagraphElement | null>;
}

/**
 * The section as drawn for `operatorId` (undefined until `GET /me` answers), read at `readAt`:
 * - the late-update warning (owner answer (2)): the market reads '판정 지연', has a current record
 *   and that record's next review time has passed — the public detail reads 갱신 대기 then, and
 *   nothing else happens (#173 item 11): a new record is the update;
 * - the current record (`AdminJudgementDelay.current`): its reason, its next review time in KST
 *   (marked 갱신 대기 once late), who recorded it and when — or, on a market reading '판정 지연'
 *   whose records are all history (made before a judgement or a correction was approved), the note
 *   that there is none for the version now and the public detail shows the delay with no reason;
 * - 지연 기록 등록, on a market CLOSED or PROVISIONAL, on while the market reads '판정 지연'
 *   (`judgementDelayUnavailable`: the server's flag, or the clock past the scheduled judgement or
 *   a held market's deadline — the section draws again at that instant) and the admin on screen is
 *   known; off with the note why otherwise;
 * - the 지연 기록 이력 (`JudgementDelayHistory`), newest first.
 * The long-delay warning (owner answer (3)) is the panel's own first line (`JudgementLongDelay`):
 * it is about the judgement, not about a record. `targets` are what focus comes back to.
 */
export function JudgementDelaysBody({
  market,
  readAt,
  operatorId,
  onOpen,
  targets,
}: {
  market: AdminMarket;
  readAt: number;
  operatorId: string | undefined;
  onOpen: (action: JudgementDelayAction) => void;
  targets?: JudgementDelayFocusTargets;
}) {
  const current = currentJudgementDelayRecord(market);
  // Drawn again as the market starts to read '판정 지연' and as the current record's time passes.
  const startClock = useClockPast(readAt, judgementDelayStartsAt(market));
  const reviewClock = useClockPast(readAt, current?.nextReviewAt ?? null);
  const now = Math.max(startClock, reviewClock);
  const unavailable = judgementDelayUnavailable(market, now);
  const late = judgementDelayLate(market, current, unavailable === null, now);
  return (
    <Stack
      gap="3"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid="market-judgement-delays"
      data-delayed={unavailable === null}
    >
      <PanelHeading headingRef={targets?.title} testId="market-judgement-delays-title">
        {copy.adminMarketJudgementDelays}
      </PanelHeading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminMarketJudgementDelaysIntro}
      </Text>
      {late && (
        <Alert.Root status="warning" role="status" data-testid="market-judgement-delay-late">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminMarketJudgementDelayLate}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {current !== null && (
        <CurrentJudgementDelay record={current} late={late} headingRef={targets?.current} />
      )}
      {current === null && unavailable === null && market.judgementDelays.length > 0 && (
        <Text fontSize="sm" color="fg.muted" data-testid="market-judgement-delay-none-current">
          {copy.adminMarketJudgementDelayNoCurrent}
        </Text>
      )}
      {unavailable !== 'status' && (
        <Stack gap="1">
          <Button
            size="sm"
            variant="outline"
            alignSelf="flex-start"
            disabled={operatorId === undefined || unavailable !== null}
            onClick={() => onOpen('record')}
            data-testid="market-judgement-delay-record"
          >
            {copy.adminMarketJudgementDelayRecord}
          </Button>
          {unavailable !== null && (
            <Text
              fontSize="sm"
              color="fg.muted"
              data-testid="market-judgement-delay-unavailable"
              data-reason={unavailable}
            >
              {JUDGEMENT_DELAY_UNAVAILABLE_NOTE[unavailable]}
            </Text>
          )}
        </Stack>
      )}
      <JudgementDelayHistory market={market} />
    </Stack>
  );
}

/**
 * The long-delay warning at the top of the 판정 panel (owner answer 2026-11-03 (3)): a CLOSED market
 * past its 장기 지연 기한 — the scheduled judgement plus the rule's days (`judgementLongDelayWarned`,
 * on the clock from `readAt`, drawn again at the deadline since a CLOSED market is not polled) —
 * is told to apply the rule's 지연·취소·무효 처리 through 판정 등록 below: VOID too needs the
 * registration and another admin's approval (#152), and nothing is automatic (#173 item 11). It
 * shows the deadline in KST and the rule's own text. Records change nothing of it; the list of such
 * markets is #145's.
 */
export function JudgementLongDelay({ market, readAt }: { market: AdminMarket; readAt: number }) {
  const deadline = judgementLongDelayDeadline(market);
  const now = useClockPast(readAt, deadline);
  if (deadline === null || !judgementLongDelayWarned(market, now)) return null;
  return (
    <Alert.Root status="warning" role="status" data-testid="market-judgement-long-delay">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>
          <Stack gap="1">
            <Text>{copy.adminMarketJudgementLongDelay}</Text>
            <Line
              label={copy.adminMarketJudgementLongDelayDeadline}
              testId="market-judgement-long-delay-deadline"
            >
              {formatKst(deadline)}
            </Line>
            <Line
              label={copy.adminMarketDelayHandling}
              testId="market-judgement-long-delay-handling"
            >
              {market.delayHandling.trim() === '' ? '—' : market.delayHandling}
            </Line>
          </Stack>
        </Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

/** A heading inside the section; one focus may come back to (`headingRef`) takes it from script. */
function PanelHeading({
  children,
  headingRef,
  testId,
}: {
  children: ReactNode;
  headingRef?: RefObject<HTMLParagraphElement | null>;
  testId?: string;
}) {
  return (
    <Text
      ref={headingRef}
      tabIndex={headingRef === undefined ? undefined : -1}
      fontWeight="medium"
      fontSize="sm"
      data-testid={testId}
    >
      {children}
    </Text>
  );
}

/** One labelled value of the section's small print, its value under `testId`. */
function Line({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <Text as="div" fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
      <Text as="span" fontWeight="medium">
        {label}
      </Text>{' '}
      <Text as="span" data-testid={testId}>
        {children}
      </Text>
    </Text>
  );
}

/** Label/value rows in the section's small print, one line each. */
function Rows({ rows, testId }: { rows: readonly EventRow[]; testId: string }) {
  return (
    <Stack gap="0" fontSize="sm" color="fg.muted" data-testid={testId}>
      {rows.map((row) => (
        <Text key={row.label} whiteSpace="pre-wrap" wordBreak="break-word">
          <Text as="span" fontWeight="medium">
            {row.label}
          </Text>{' '}
          {row.value}
        </Text>
      ))}
    </Stack>
  );
}

/**
 * The current record: its reason — what the public detail shows — its next review time in KST,
 * marked 갱신 대기 once late, who recorded it (by nickname) and when.
 */
function CurrentJudgementDelay({
  record,
  late,
  headingRef,
}: {
  record: AdminJudgementDelay;
  late: boolean;
  headingRef?: RefObject<HTMLParagraphElement | null>;
}) {
  return (
    <Stack
      gap="1"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid="market-judgement-delay-current"
      data-late={late}
    >
      <HStack gap="2" flexWrap="wrap" align="baseline">
        <PanelHeading headingRef={headingRef} testId="market-judgement-delay-current-title">
          {copy.adminMarketJudgementDelayCurrent}
        </PanelHeading>
        {late && (
          <Badge
            colorPalette="orange"
            variant="subtle"
            data-testid="market-judgement-delay-current-passed"
          >
            {copy.adminMarketJudgementDelayPassed}
          </Badge>
        )}
      </HStack>
      <Line
        label={copy.adminMarketJudgementDelayReason}
        testId="market-judgement-delay-current-reason"
      >
        {record.reason}
      </Line>
      <Line
        label={copy.adminMarketJudgementDelayNextReviewAt}
        testId="market-judgement-delay-current-next-review"
      >
        {formatKst(record.nextReviewAt)}
      </Line>
      <Line
        label={copy.adminMarketJudgementDelayRecordedBy}
        testId="market-judgement-delay-current-by"
      >
        {judgementDelayActorName(record.recordedBy)}
      </Line>
      <Line
        label={copy.adminMarketJudgementDelayRecordedAt}
        testId="market-judgement-delay-current-at"
      >
        {formatKst(record.recordedAt)}
      </Line>
    </Stack>
  );
}

/**
 * 지연 기록 이력 (`AdminMarket.judgementDelays`, newest first; owner answer (4) — kept, never edited,
 * withdrawn or hidden): each record with the status it was made on ('거래 마감', '잠정 결과 v1'), 현재
 * on the current one, who recorded it and when, then its reason and next review time
 * (`judgementDelayRows`). `market-judgement-delay-history-<n>` counts from the newest and carries
 * the status in `data-status` and whether it is current in `data-current`.
 */
function JudgementDelayHistory({ market }: { market: AdminMarket }) {
  const records = market.judgementDelays;
  return (
    <Stack gap="2" data-testid="market-judgement-delay-history">
      <PanelHeading>{copy.adminMarketJudgementDelayHistory}</PanelHeading>
      {records.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" data-testid="market-judgement-delay-history-empty">
          {copy.adminMarketJudgementDelayHistoryEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {records.map((record, index) => {
            const at = `market-judgement-delay-history-${String(index)}`;
            return (
              <Stack
                key={record.id}
                gap="0.5"
                data-testid={at}
                data-status={record.marketStatus}
                data-current={record.current}
              >
                <HStack gap="2" flexWrap="wrap">
                  <Badge variant="subtle" data-testid={`${at}-episode`}>
                    {judgementDelayEpisodeText(record)}
                  </Badge>
                  {record.current && (
                    <Badge
                      size="sm"
                      variant="outline"
                      colorPalette="brand"
                      data-testid={`${at}-current`}
                    >
                      {copy.adminMarketJudgementDelayCurrentBadge}
                    </Badge>
                  )}
                  <Text fontSize="sm" fontWeight="medium" data-testid={`${at}-by`}>
                    {judgementDelayActorName(record.recordedBy)}
                  </Text>
                  <Text fontSize="xs" color="fg.muted" data-testid={`${at}-at`}>
                    {formatKst(record.recordedAt)}
                  </Text>
                </HStack>
                <Rows rows={judgementDelayRows(record, formatKst)} testId={`${at}-rows`} />
              </Stack>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
