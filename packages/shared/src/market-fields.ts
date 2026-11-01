import * as z from 'zod';
import { MARKET_FALLBACK_SOURCES_MAX, MARKET_TEXT_MAX, MARKET_TITLE_MAX } from './constants.js';
import {
  marketLongDelayDaysSchema,
  marketSourceSchema,
  storableInstantSchema,
} from './market-rules.js';
import { timeZoneSchema } from './time-zone.js';

/**
 * The body fields of a market's rule-version items (#80, ADR-0101; ADR-0093 decision 2 #172 item
 * 7): the title, the rule items (market-rules.ts, #23) and the time items (market-times.ts, #22),
 * each as the create and update bodies take it (`marketFields`, market.ts) and as a supplement's
 * `changes` does (`marketSupplementChangesSchema`, market-supplement.ts), so both paths accept the
 * same values. market.ts reads market-supplement.ts for its DTOs, so the fields both build on live
 * in a module of their own; the package exports the bodies, not these.
 */

/** 제목: trimmed, 1..MARKET_TITLE_MAX characters. */
export const marketTitleSchema = z.string().trim().min(1).max(MARKET_TITLE_MAX);

/** A rule text (#23): trimmed, at most MARKET_TEXT_MAX; blank while not filled in. */
const ruleTextSchema = z.string().trim().max(MARKET_TEXT_MAX);

/** The rule items' fields (#23), in RULE_ITEMS order. */
export const ruleItemFields = {
  /** 배경. */
  description: ruleTextSchema.nullish(),
  yesCondition: ruleTextSchema.optional(),
  noCondition: ruleTextSchema.optional(),
  /**
   * 사건 기한 (#172 item 8); the admin enters it in KST. From STORABLE_INSTANT_MIN on: an earlier one
   * Postgres refuses or drizzle reads back as another year (ADR-0097). At or before the scheduled
   * judgement (owner answer 2026-10-31 A1, whole minutes); no order against the close.
   */
  eventDeadline: storableInstantSchema.nullish(),
  /** 1차 출처: `market_sources` priority 0. */
  primarySource: marketSourceSchema.nullish(),
  /**
   * 대체 출처, the whole ordered list (priorities 1..3), as `tags`: an edit with it replaces them, `[]`
   * removes them all.
   */
  fallbackSources: z.array(marketSourceSchema).max(MARKET_FALLBACK_SOURCES_MAX).optional(),
  /** 전환 조건: blank unless there is a fallback. */
  fallbackCondition: ruleTextSchema.optional(),
  /** 장기 지연 기한 in days after the scheduled judgement. */
  longDelayDays: marketLongDelayDaysSchema.nullish(),
  /** 지연·취소·무효 처리. */
  delayHandling: ruleTextSchema.optional(),
};

/** The time items' fields (#22, ADR-0098), in TIME_ITEMS order. */
export const timeItemFields = {
  /**
   * 예정 개장 시각 (#22): the market opens no earlier (ADR-0093 decision 3 '#21 앞당긴 개장'). Before
   * the close, in whole minutes. Once SCHEDULED it moves by its own write, with a reason (#78),
   * and the market opens at it (#21); fixed after the open (#172 item 14) — no supplement moves it.
   */
  scheduledOpenAt: storableInstantSchema.nullish(),
  /**
   * 거래 마감 시각: from STORABLE_INSTANT_MIN on (#22), and in the future (the service's). At or
   * before the scheduled judgement, in whole minutes (#172 item 12). After the open only a
   * supplement moves it, later only and never while PAUSED (#172 item 14, #80).
   */
  closeAt: storableInstantSchema,
  /**
   * 발표 예정 시각 (#172 item 13); null is '없음'. The close leads it by the release setting
   * `market.lead_close_gap` (the open-items check's `leadClose`).
   */
  scheduledAnnouncementAt: storableInstantSchema.nullish(),
  /**
   * 예정 판정 시각: at or after the close and 사건 기한, in whole minutes (#172 item 12, A1). Never
   * changes after the open (#172 item 14): no supplement moves it.
   */
  scheduledJudgementAt: storableInstantSchema.nullish(),
  /** 판정 기준 시간대 (#172 item 11): an IANA name (`timeZoneSchema`), trimmed, stored as given. */
  judgementTimeZone: timeZoneSchema.nullish(),
};
