import type { APIRequestContext, APIResponse, Page, Request } from '@playwright/test';
import type { AdminMarket, Market, MarketJudgementDelayRecordedPayload } from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  adminAccount,
  closeMarket,
  createOpenMarket,
  documentSurvived,
  expect,
  kstLocalOf,
  markDocument,
  meOf,
  recordJudgementDelay,
  sendJudgementDelay,
  signIn,
  subscribed,
  test,
  waitPast,
} from './helpers';

/**
 * 판정 지연 기록 (#142, ADR-0106; ADR-0093 decision 1 #173 items 2·7·11·13, decision 2 #172 item
 * 14, decision 3 '#142 지연 사유', the owner's answers of 2026-11-03 (1)–(4)): a 거래 마감 market
 * whose scheduled judgement has passed reads '판정 지연' with no record (#22), and then one admin —
 * alone and at once, no approval — records why it is late and when it is next reviewed: the 지연
 * 사유, one public sentence, and the 다음 검토 시각, after now and within 7 × 24 hours (owner answer
 * (1)), checked by the API on its database clock. A visitor's open detail reads it without a
 * reload (the record republishes `market:status` with its key unchanged, A-M4-36): the reason and
 * the time in the visitor's zone and the market's 판정 기준 시간대, nobody's name and no record
 * time. Once that time passes with no new record, nothing happens (#173 item 11): the status stays
 * 거래 마감 with no result, the public detail marks the time '갱신 대기' by itself and says that no
 * result comes of it, and the admin's 판정 panel warns that the update is late (owner answer (2)).
 * A change is a new record, made from the panel's dialog, never an edit or a withdrawal (owner
 * answer (4)): the new one is current and public, the earlier one stays in the 지연 기록 이력 —
 * newest first — and the 이벤트 로그 holds one '판정 지연 기록' per record, in order. A market that
 * does not read '판정 지연' — an open one, a closed one before its scheduled judgement — takes no
 * record: the API refuses it by its status, and a closed one's 판정 panel has the button off with
 * the reason (an open one has no 판정 panel).
 *
 * The closed market's close and scheduled judgement are seconds ahead of its making (the API takes
 * a scheduled judgement no earlier than the approval's minute, ADR-0098), as market-times.spec.ts'
 * delay test makes it, and the first record's next review time seconds ahead of the record —
 * through the API (`recordJudgementDelay`), as the dialog's `datetime-local` is minute-precise; the
 * second goes through the dialog a day ahead. No spec waits for the worker here: it does nothing
 * at either instant (`closeMarket` alone waits for its close should the close come first). A
 * record cannot be removed, so the delayed markets stay in the e2e database, as every closed one.
 *
 * Who may record and when, every refusal's order and the bounds to the millisecond on the database
 * clock, the records (the `market_judgement_delays` rows, the `judgement_delay_recorded` events,
 * the admin actions), the current record across a judgement's approval, a correction and the
 * confirmation, a held 잠정 결과's record and the public answers' private fields are the API's,
 * the database's and the worker's integration tests (admin-market-judgement-delays.controller
 * .test.ts, private-data.test.ts, packages/db market-judgement-delay.test.ts and schema.test.ts,
 * worker judgement-delay.test.ts — the time passing creates nothing); a held 잠정 결과's record on
 * screen is correction.spec.ts'. The long-delay warning needs a scheduled judgement days past
 * (`longDelayDays` is 1 at least), which no spec market reaches: it, the panel's section, the
 * dialog's bounds and what a refusal says are unit-tested (market-judgement-delay-panel.test.tsx,
 * lib/market-judgement-delay.test.ts, market-detail.test.tsx).
 */

const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * How far ahead of its making the market closes and is judged: room for making it, opening it
 * through the review and closing it early (`closeMarket`), as market-times.spec.ts' delay test.
 */
const DUE_IN_MS = 25_000;

/** How long the spec waits for the public market to read '판정 지연' (#22: on the read). */
const DELAYED_WAIT_MS = 60_000;

/**
 * How far ahead of the first record its 다음 검토 시각 is: room for the visitor's detail to read it
 * and the admin's to be read again, both on screen already and both checked not passed before it
 * passes, with room to spare on a loaded CI shard (three shards, both projects). Only those checks
 * sit in the window: what the time does not change is checked once it has passed.
 */
const REVIEW_IN_MS = 45_000;

/**
 * How long past that time the spec looks again: the admin panel's timers fire a second past it;
 * the public detail's fires at it, on a clock anchored to its server render (later by hydration).
 */
const REVIEW_SLACK_MS = 2_000;

/** A zone other than Seoul, where both projects run (playwright.config.ts). */
const NEW_YORK_ZONE = 'America/New_York';

/** The judgement zone's line of an instant judged in New York, read in Seoul (DST either way). */
const NEW_YORK_LINE = new RegExp(
  `^${copy.rulesJudgementZoneLine} \\d{4}\\. \\d{1,2}\\. \\d{1,2}\\. (오전|오후) \\d{1,2}:\\d{2} ` +
    '\\((GMT-4|GMT-5)\\)$',
);

/** The refusal details of a record (MARKET_JUDGEMENT_DELAY_REFUSALS, restated: types only). */
const NOT_AWAITING = [{ path: ['status'], message: 'not awaiting a judgement' }];
const NOT_DELAYED = [{ path: ['status'], message: 'not delayed' }];
const NOT_AFTER_NOW = [{ path: ['nextReviewAt'], message: 'not after now' }];
const TOO_FAR_AHEAD = [{ path: ['nextReviewAt'], message: 'more than 7 days ahead' }];

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}

/** A refusal's `details`, once its status and code are the ones expected. */
async function refusalOf(response: APIResponse, status: number, code: string): Promise<unknown> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  const { error } = JSON.parse(body) as { error: { code: string; details: unknown } };
  expect(error.code).toBe(code);
  return error.details;
}

/** The admin market as `context` reads it. */
async function adminMarketOf(context: APIRequestContext, id: string): Promise<AdminMarket> {
  return dataOf<AdminMarket>(await context.get(`/api/v1/admin/markets/${id}`));
}

/** The public market as a signed-out visitor reads it (`request` carries no cookie). */
async function publicMarketOf(request: APIRequestContext, id: string): Promise<Market> {
  return dataOf<Market>(await request.get(`/api/v1/markets/${id}`));
}

/** The market's 판정 지연 기록 events, newest first (`AdminMarket.events` is). */
function delayEventsOf(market: AdminMarket): AdminMarket['events'] {
  return market.events.filter((event) => event.type === 'judgement_delay_recorded');
}

/** The ISO instant of the whole minute `ms` falls in: what a `datetime-local` input sends. */
function minuteIso(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
}

/**
 * Lets the page's toasts go before the next press (themes.spec.ts's `letToastsGo`): a toast pauses
 * while the pointer rests on the stack, and on a phone the stack covers the panel's buttons.
 */
async function letToastsGo(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}

/** The `POST /admin/markets/:id/judgement-delays` this page sends next. */
function nextRecord(page: Page, marketId: string): Promise<Request> {
  return page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/v1/admin/markets/${marketId}/judgement-delays`,
  );
}

test.describe('판정 지연 기록', () => {
  test('예정 판정 시각이 지나 판정 지연으로 보이는 거래 마감 시장에 한 관리자가 지연 사유와 다음 검토 시각을 기록하면 방문자의 상세가 리프레시 없이 그 사유와 시각을 두 시간대로 보이고, 그 시각이 지나도 결과는 생기지 않고 공개 상세는 갱신 대기로, 관리자 상세는 늦은 갱신 경고로 바뀌며, 판정 칸에서 다시 기록하면 새 기록이 공개되고 두 기록이 이력과 이벤트 로그에 순서대로 남는다', async ({
    admin,
    browser,
    page,
    request,
  }) => {
    // The scheduled judgement and the first next review time waited out, with two screens open.
    test.slow();
    const first = await meOf(admin);
    const firstName = first.profile.nickname;
    const firstContext = await browser.newContext();
    try {
      // --- before the market: admin 1's browser signed in, which takes time.
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);

      // Closes and is judged in seconds, in New York: a visitor in Seoul reads the next review time
      // in both zones. The 사건 기한 is at the judgement too (A1).
      const dueAt = new Date(Date.now() + DUE_IN_MS).toISOString();
      const market = await createOpenMarket(admin, {
        closeAt: dueAt,
        ruleItems: { eventDeadline: dueAt },
        times: { scheduledJudgementAt: dueAt, judgementTimeZone: NEW_YORK_ZONE },
      });
      // 마감 by the operators now (#114) — or, should its close come first, by the worker on
      // schedule, which `closeMarket` then waits for: closed, its judgement just ahead or past.
      const closed = await closeMarket(admin, market.id);
      expect(closed.status).toBe('closed');
      expect(closed.judgementDelays).toEqual([]);
      const reason = `1차 출처의 발표가 늦어지고 있습니다 확인 코드 ${market.tag}`;
      const secondReason = `1차 출처가 발표 일정을 다시 알렸습니다 확인 코드 ${market.tag}`;

      // --- both screens on the market: the visitor, signed out, in its room; admin 1's detail
      // with the 판정 panel's 판정 지연 기록 — nothing recorded.
      const joined = subscribed(page, market.id);
      await page.goto(`/markets/${market.slug}`);
      await joined;
      await markDocument(page);
      const badge = page.getByTestId('market-status-badge');
      const notice = page.getByTestId('market-status-notice');
      await firstPage.goto(`/admin/markets/${market.id}`);
      const section = firstPage.getByTestId('market-judgement-delays');
      await expect(section.getByTestId('market-judgement-delays-title')).toHaveText(
        copy.adminMarketJudgementDelays,
      );
      await expect(firstPage.getByTestId('market-judgement-delay-history-empty')).toHaveText(
        copy.adminMarketJudgementDelayHistoryEmpty,
      );

      // --- the scheduled judgement passes: '판정 지연' on the read (#173 item 11), no record.
      await expect
        .poll(async () => (await publicMarketOf(request, market.id)).judgementDelayed, {
          timeout: DELAYED_WAIT_MS,
          intervals: [1_000],
        })
        .toBe(true);
      expect(await publicMarketOf(request, market.id)).toMatchObject({
        status: 'closed',
        resolvedResult: null,
        judgementDelayed: true,
        judgementDelay: null,
      });
      // Admin 1's detail, never reloaded, offers the record from that instant on (its own clock
      // past the scheduled judgement, by a timer — a closed market's detail is not polled).
      await expect(section).toHaveAttribute('data-delayed', 'true');
      await expect(firstPage.getByTestId('market-judgement-delay-record')).toBeEnabled();
      await expect(firstPage.getByTestId('market-judgement-delay-unavailable')).toHaveCount(0);
      // No long delay yet: the rule's days run from the scheduled judgement (#172 item 10).
      await expect(firstPage.getByTestId('market-judgement-long-delay')).toHaveCount(0);

      // --- the API's refusals of the next review time, on its database clock (owner answer
      // (1)): not after now, and later than 7 × 24 hours from now. Nothing is written.
      expect(
        await refusalOf(
          await sendJudgementDelay(admin, market.id, {
            reason,
            nextReviewAt: new Date(Date.now() - MINUTE_MS).toISOString(),
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual(NOT_AFTER_NOW);
      expect(
        await refusalOf(
          await sendJudgementDelay(admin, market.id, {
            reason,
            nextReviewAt: new Date(Date.now() + 7 * DAY_MS + 10 * MINUTE_MS).toISOString(),
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual(TOO_FAR_AHEAD);
      const refused = await adminMarketOf(admin, market.id);
      expect(refused.judgementDelays).toEqual([]);
      expect(delayEventsOf(refused)).toEqual([]);

      // --- record #1 by admin 1 alone, through the API: the next review time seconds ahead.
      const nextReviewAt = new Date(Date.now() + REVIEW_IN_MS).toISOString();
      const recorded = await recordJudgementDelay(admin, market.id, { reason, nextReviewAt });
      // Nothing of the market changes (#173 item 11): 거래 마감, no result, no judgement, the
      // scheduled judgement as it was (#172 item 14).
      expect(recorded).toMatchObject({
        status: 'closed',
        resolvedResult: null,
        judgementVersion: null,
        judgementDelayed: true,
        judgementDelay: { reason, nextReviewAt, nextReviewPassed: false },
        scheduledJudgementAt: closed.scheduledJudgementAt,
      });
      expect(recorded.judgement).toMatchObject({ current: null, pending: null });
      const [record] = recorded.judgementDelays;
      if (record === undefined) throw new Error('unreachable: recordJudgementDelay checks it');
      expect(recorded.judgementDelays).toEqual([
        {
          id: record.id,
          reason,
          nextReviewAt,
          marketStatus: 'closed',
          judgementVersion: null,
          recordedAt: record.recordedAt,
          recordedBy: { id: first.id, nickname: firstName },
          current: true,
        },
      ]);
      // Its event: no status change, admin 1's, with what the record says (#188 and #145 read it).
      const [event] = delayEventsOf(recorded);
      if (event === undefined) throw new Error(`market ${market.id} has no delay record event`);
      expect(recorded.events[0]).toEqual(event);
      const payload: MarketJudgementDelayRecordedPayload = {
        delayId: record.id,
        reason,
        nextReviewAt,
        marketStatus: 'closed',
        judgementVersion: null,
      };
      expect(event).toMatchObject({ fromStatus: null, toStatus: null, actorId: first.id, payload });

      // --- the visitor's detail, never reloaded: '판정 지연', its sentence, and under it the
      // reason and the next review time in Seoul and in New York — not passed, no marker.
      await expect(badge).toHaveText(copy.marketStatusJudgementDelayed);
      await expect(notice).toContainText(copy.marketJudgementDelayedNotice);
      await expect(notice.getByTestId('market-detail-delay-reason')).toHaveText(reason);
      const nextReview = notice.getByTestId('market-detail-next-review');
      await expect(nextReview).toContainText(copy.marketNextReviewAt);
      await expect(nextReview).toHaveAttribute('data-passed', 'false');
      await expect(notice.getByTestId('market-detail-next-review-viewer-zone')).toHaveText(
        formatKst(nextReviewAt),
      );
      await expect(notice.getByTestId('market-detail-next-review-judgement-zone')).toHaveText(
        NEW_YORK_LINE,
      );
      await expect(notice.getByTestId('market-detail-next-review-passed')).toHaveCount(0);
      expect(await documentSurvived(page)).toBe(true);
      expect((await publicMarketOf(request, market.id)).judgementDelay).toEqual({
        reason,
        nextReviewAt,
        nextReviewPassed: false,
      });

      // --- admin 1's detail, read again: the current record — the reason, the time in KST, who
      // and when — and no late warning yet. Its 이력 and 이벤트 로그 row wait until the time passes.
      await firstPage.reload();
      const current = firstPage.getByTestId('market-judgement-delay-current');
      await expect(current).toHaveAttribute('data-late', 'false');
      await expect(firstPage.getByTestId('market-judgement-delay-current-reason')).toHaveText(
        reason,
      );
      await expect(firstPage.getByTestId('market-judgement-delay-current-next-review')).toHaveText(
        formatKst(nextReviewAt),
      );
      await expect(firstPage.getByTestId('market-judgement-delay-current-by')).toHaveText(
        firstName,
      );
      await expect(firstPage.getByTestId('market-judgement-delay-current-at')).toHaveText(
        formatKst(record.recordedAt),
      );
      await expect(firstPage.getByTestId('market-judgement-delay-late')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-judgement-delay-current-passed')).toHaveCount(0);

      // --- the next review time passes with no new record (owner answer (2)), both screens open.
      await waitPast(page, nextReviewAt, REVIEW_SLACK_MS);
      // The visitor's detail marks it '갱신 대기' by itself, keeps the reason and says that no
      // result comes of the time passing — never reloaded.
      await expect(nextReview).toHaveAttribute('data-passed', 'true');
      await expect(notice.getByTestId('market-detail-next-review-passed')).toHaveText(
        copy.marketNextReviewPassed,
      );
      await expect(notice.getByTestId('market-detail-next-review-passed-note')).toHaveText(
        copy.marketNextReviewPassedNote,
      );
      await expect(notice.getByTestId('market-detail-delay-reason')).toHaveText(reason);
      await expect(badge).toHaveText(copy.marketStatusJudgementDelayed);
      expect(await documentSurvived(page)).toBe(true);
      // Admin 1's detail, never reloaded, warns that the update is late.
      await expect(firstPage.getByTestId('market-judgement-delay-late')).toContainText(
        copy.adminMarketJudgementDelayLate,
      );
      await expect(current).toHaveAttribute('data-late', 'true');
      await expect(firstPage.getByTestId('market-judgement-delay-current-passed')).toHaveText(
        copy.adminMarketJudgementDelayPassed,
      );
      // And nothing happened (#173 item 11, AC 6): still 거래 마감, no result, no judgement, no
      // new event since the record; the API says the time has passed.
      const passed = await adminMarketOf(admin, market.id);
      expect(passed).toMatchObject({
        status: 'closed',
        resolvedResult: null,
        judgementVersion: null,
        judgementDelayed: true,
        judgementDelay: { reason, nextReviewAt, nextReviewPassed: true },
      });
      expect(passed.judgement).toMatchObject({ current: null, pending: null });
      expect(passed.events[0]?.id).toBe(event.id);
      expect(passed.judgementDelays).toEqual(recorded.judgementDelays);
      expect((await publicMarketOf(request, market.id)).judgementDelay).toEqual({
        reason,
        nextReviewAt,
        nextReviewPassed: true,
      });

      // --- what the time does not change, checked out of the window above: record #1 current in
      // admin 1's 지연 기록 이력 and its 이벤트 로그 row, on the page read again before it passed.
      const onlyEntry = firstPage.getByTestId('market-judgement-delay-history-0');
      await expect(onlyEntry).toHaveAttribute('data-current', 'true');
      await expect(onlyEntry).toHaveAttribute('data-status', 'closed');
      await expect(onlyEntry.getByTestId('market-judgement-delay-history-0-episode')).toHaveText(
        copy.marketStatusClosed,
      );
      await expect(onlyEntry.getByTestId('market-judgement-delay-history-0-current')).toHaveText(
        copy.adminMarketJudgementDelayCurrentBadge,
      );
      await expect(firstPage.getByTestId('market-judgement-delay-history-1')).toHaveCount(0);
      const eventRow = firstPage.getByTestId(`market-event-${String(event.id)}`);
      await expect(eventRow).toContainText(copy.eventJudgementDelayRecorded);
      await expect(eventRow).toContainText(`${copy.adminMarketJudgementDelayReason} ${reason}`);
      await expect(eventRow).toContainText(`${copy.eventNextReviewAt} ${formatKst(nextReviewAt)}`);
      await expect(eventRow).toContainText(
        `${copy.adminMarketJudgementDelayEpisode} ${copy.marketStatusClosed}`,
      );

      // Public data (#173 item 13, decision 3): the reason and the time alone — who recorded it,
      // when, the record's id: in neither the answer nor the server's HTML.
      const publicBody = await (await request.get(`/api/v1/markets/${market.id}`)).text();
      const html = await (await request.get(`/markets/${market.slug}`)).text();
      expect(publicBody).toContain(reason);
      expect(html).toContain(reason);
      for (const hidden of [first.id, record.id, record.recordedAt]) {
        expect(publicBody).not.toContain(hidden);
        expect(html).not.toContain(hidden);
      }

      // --- record #2 from the panel (owner answer (4): a change is a new record): the dialog
      // shows the current record and opens with its reason; the time is the admin's to set, in
      // KST, after now and within 7 days on screen too.
      await letToastsGo(firstPage);
      await firstPage.getByTestId('market-judgement-delay-record').click();
      const dialog = firstPage.getByTestId('market-judgement-delay-dialog');
      const confirm = dialog.getByTestId('market-judgement-delay-dialog-confirm');
      const reasonInput = dialog.getByTestId('market-judgement-delay-reason');
      const timeInput = dialog.getByTestId('market-judgement-delay-next-review');
      const timeError = dialog.getByTestId('market-judgement-delay-next-review-error');
      await expect(dialog).toContainText(copy.adminMarketJudgementDelayBody);
      await expect(dialog.getByTestId('market-judgement-delay-dialog-current')).toContainText(
        reason,
      );
      await expect(dialog.getByTestId('market-judgement-delay-dialog-current')).toContainText(
        formatKst(nextReviewAt),
      );
      await expect(reasonInput).toHaveValue(reason);
      await expect(timeInput).toHaveValue('');
      await expect(confirm).toBeDisabled();
      await timeInput.fill(kstLocalOf(new Date(Date.now() - 2 * MINUTE_MS).toISOString()));
      await expect(timeError).toHaveText(copy.errMarketJudgementDelayNextReviewAfter);
      await expect(confirm).toBeDisabled();
      await timeInput.fill(
        kstLocalOf(new Date(Date.now() + 7 * DAY_MS + 60 * MINUTE_MS).toISOString()),
      );
      await expect(timeError).toHaveText(copy.errMarketJudgementDelayNextReviewTooFar);
      await expect(confirm).toBeDisabled();
      const secondNextReviewAt = minuteIso(Date.now() + DAY_MS);
      await reasonInput.fill(secondReason);
      await timeInput.fill(kstLocalOf(secondNextReviewAt));
      await expect(timeError).toHaveCount(0);
      await expect(confirm).toBeEnabled();
      const sent = nextRecord(firstPage, market.id);
      await confirm.click();
      // Sent in UTC (N03 §4), naming admin 1 (ADR-0092).
      expect((await sent).postDataJSON()).toEqual({
        reason: secondReason,
        nextReviewAt: secondNextReviewAt,
        expectedAccountId: first.id,
      });
      await expect(firstPage.getByText(copy.adminMarketJudgementDelayRecorded)).toBeVisible();
      await expect(dialog).toHaveCount(0);

      // --- admin 1's panel: record #2 current, no late warning; the 이력 newest first, #1 kept.
      await expect(firstPage.getByTestId('market-judgement-delay-current-reason')).toHaveText(
        secondReason,
      );
      await expect(firstPage.getByTestId('market-judgement-delay-current-next-review')).toHaveText(
        formatKst(secondNextReviewAt),
      );
      await expect(current).toHaveAttribute('data-late', 'false');
      await expect(firstPage.getByTestId('market-judgement-delay-late')).toHaveCount(0);
      const newest = firstPage.getByTestId('market-judgement-delay-history-0');
      const earlier = firstPage.getByTestId('market-judgement-delay-history-1');
      await expect(newest).toHaveAttribute('data-current', 'true');
      await expect(newest.getByTestId('market-judgement-delay-history-0-rows')).toContainText(
        `${copy.adminMarketJudgementDelayReason} ${secondReason}`,
      );
      await expect(newest.getByTestId('market-judgement-delay-history-0-by')).toHaveText(firstName);
      await expect(earlier).toHaveAttribute('data-current', 'false');
      await expect(earlier.getByTestId('market-judgement-delay-history-1-current')).toHaveCount(0);
      await expect(earlier.getByTestId('market-judgement-delay-history-1-rows')).toContainText(
        `${copy.adminMarketJudgementDelayReason} ${reason}`,
      );
      await expect(earlier.getByTestId('market-judgement-delay-history-1-rows')).toContainText(
        `${copy.adminMarketJudgementDelayNextReviewAt} ${formatKst(nextReviewAt)}`,
      );
      await expect(firstPage.getByTestId('market-judgement-delay-history-2')).toHaveCount(0);

      // --- the visitor's detail, never reloaded: record #2's reason and time, no marker.
      await expect(notice.getByTestId('market-detail-delay-reason')).toHaveText(secondReason);
      await expect(notice.getByTestId('market-detail-next-review-viewer-zone')).toHaveText(
        formatKst(secondNextReviewAt),
      );
      await expect(nextReview).toHaveAttribute('data-passed', 'false');
      await expect(notice.getByTestId('market-detail-next-review-passed')).toHaveCount(0);
      expect(await documentSurvived(page)).toBe(true);

      // --- the records (AC 7·8): two, newest first, the second current; two events in order, each
      // admin 1's with its record; still 거래 마감 with no result and no judgement.
      const after = await adminMarketOf(admin, market.id);
      expect(after).toMatchObject({
        status: 'closed',
        resolvedResult: null,
        judgementVersion: null,
        judgementDelay: {
          reason: secondReason,
          nextReviewAt: secondNextReviewAt,
          nextReviewPassed: false,
        },
      });
      expect(after.judgement).toMatchObject({ current: null, pending: null });
      expect(
        after.judgementDelays.map(({ reason: said, nextReviewAt: at, current: isCurrent }) => ({
          said,
          at,
          isCurrent,
        })),
      ).toEqual([
        { said: secondReason, at: secondNextReviewAt, isCurrent: true },
        { said: reason, at: nextReviewAt, isCurrent: false },
      ]);
      expect(after.judgementDelays[1]).toEqual({ ...record, current: false });
      const events = delayEventsOf(after);
      expect(events.map((entry) => entry.payload)).toEqual([
        {
          delayId: after.judgementDelays[0]?.id,
          reason: secondReason,
          nextReviewAt: secondNextReviewAt,
          marketStatus: 'closed',
          judgementVersion: null,
        },
        payload,
      ]);
      expect(events.map((entry) => entry.actorId)).toEqual([first.id, first.id]);
      expect(Number(events[0]?.id)).toBeGreaterThan(Number(event.id));
      await expect(firstPage.getByTestId(`market-event-${String(events[0]?.id)}`)).toContainText(
        `${copy.adminMarketJudgementDelayReason} ${secondReason}`,
      );
      expect(await publicMarketOf(request, market.id)).toMatchObject({
        status: 'closed',
        resolvedResult: null,
        judgementDelay: {
          reason: secondReason,
          nextReviewAt: secondNextReviewAt,
          nextReviewPassed: false,
        },
      });
    } finally {
      await firstContext.close();
    }
  });

  test('판정 지연으로 보이지 않는 시장은 지연 기록을 받지 않는다 — 거래 중 시장과 예정 판정 시각 전의 거래 마감 시장은 API가 거절하고, 거래 마감 시장의 판정 칸은 지연 기록 등록을 끄고 그 까닭을 말한다', async ({
    admin,
    page,
  }) => {
    // A day from its close to its scheduled judgement (`timesFor`): not delayed for a day.
    const market = await createOpenMarket(admin);
    const past = new Date(Date.now() - MINUTE_MS).toISOString();

    // --- 거래 중: no judgement awaited — refused by its status, and no 판정 panel at all.
    expect(
      await refusalOf(await sendJudgementDelay(admin, market.id), 400, 'VALIDATION_ERROR'),
    ).toEqual(NOT_AWAITING);
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto(`/admin/markets/${market.id}`);
    await expect(page.getByTestId('market-pause')).toHaveAttribute('data-status', 'open');
    await expect(page.getByTestId('market-judgement-delays')).toHaveCount(0);

    // --- 거래 마감 before its scheduled judgement: 거래 마감, not 판정 지연, so no record — the
    // status checked before the time (a past one is refused as not delayed first).
    await closeMarket(admin, market.id);
    expect(
      await refusalOf(await sendJudgementDelay(admin, market.id), 400, 'VALIDATION_ERROR'),
    ).toEqual(NOT_DELAYED);
    expect(
      await refusalOf(
        await sendJudgementDelay(admin, market.id, { nextReviewAt: past }),
        400,
        'VALIDATION_ERROR',
      ),
    ).toEqual(NOT_DELAYED);
    const refused = await adminMarketOf(admin, market.id);
    expect(refused).toMatchObject({ status: 'closed', judgementDelayed: false });
    expect(refused.judgementDelays).toEqual([]);
    expect(delayEventsOf(refused)).toEqual([]);

    // Its 판정 panel: the section with no record, 지연 기록 등록 off and why, no warning.
    await page.reload();
    const section = page.getByTestId('market-judgement-delays');
    await expect(section).toHaveAttribute('data-delayed', 'false');
    await expect(page.getByTestId('market-judgement-delay-record')).toBeDisabled();
    const unavailable = page.getByTestId('market-judgement-delay-unavailable');
    await expect(unavailable).toHaveAttribute('data-reason', 'early');
    await expect(unavailable).toHaveText(copy.adminMarketJudgementDelayEarly);
    await expect(page.getByTestId('market-judgement-delay-history-empty')).toHaveText(
      copy.adminMarketJudgementDelayHistoryEmpty,
    );
    await expect(page.getByTestId('market-judgement-delay-current')).toHaveCount(0);
    await expect(page.getByTestId('market-judgement-delay-late')).toHaveCount(0);
    await expect(page.getByTestId('market-judgement-long-delay')).toHaveCount(0);
  });
});
