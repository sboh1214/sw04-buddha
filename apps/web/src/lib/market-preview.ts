import { type MarketStatus, isPublicMarketStatus } from '@buddha/shared';
import { copy } from '@/copy';
import { type Category, type CreateMarketFields, type Market, type MarketSummary } from '@/lib/api';
import { isHttpUrl } from '@/lib/market-form';

/**
 * A draft has no id and no page yet, and the card needs both fields to exist rather than to be
 * real: the id only names the card's testid, and the slug is only there because `MarketSummary`
 * has one — the preview draws the card with `interactive={false}`, so no link is built from it
 * at all. Constants, not something derived from the form, so the markup does not churn on every
 * keystroke.
 */
export const PREVIEW_ID = '00000000-0000-0000-0000-000000000000';
export const PREVIEW_SLUG = 'preview';

/**
 * The form's values as the row a visitor's card is drawn from. `toCreateMarketBody` does the
 * trimming and the empty→null conversion, so the preview cannot disagree with what a save would
 * send; it is total, so a half-typed form is safe to hand it.
 *
 * The HISTORY — everything the form cannot express — comes from `base` whenever visitors can
 * see it, and only otherwise from the placeholders. A DRAFT or REVIEW market has never traded and
 * never reaches a visitor's grid (no public route serves it, ADR-0093 decision 1, item 12), so
 * every placeholder is TRUE for one and for the unsaved market on 시장 만들기: no fill, so the price
 * is `null` and the card reads 체결 없음 (N02 §5) — there is no initial probability to show as one
 * (#125) — and the status is `open`, the card it is being made into, never the admin's 초안 or 검수
 * 중 on a card meant as the one visitors see. A public market has the card visitors see — a
 * SCHEDULED one its 개장 예정 badge before any fill, one that has traded its price and 참여자, a
 * CLOSED one whose scheduled judgement has passed its 판정 지연 (`judgementDelayed`, #22), a held 잠정
 * 결과 its 이의 검토 중 (`disputeUnderReview`, #175) with its judgement and 이의 기한 — and the
 * 수정 card must preview that card, not one with 체결 없음 and '참여자 0'. Of that history the card
 * draws the price, the status, the countdown and the 참여자; `volumeCoin` and `tradeCount` come along
 * only because a `MarketSummary` carries them.
 *
 * Written as two exhaustive objects rather than `base?.x ?? fallback`: `??` reads fine for
 * `lastPrice` but hides that `openAt` and `resolvedResult` are legitimately null on a live row,
 * which would silently take the placeholder for a market that has one.
 *
 * The card draws nothing else (ADR-0062 removed its trend line, the one element a preview could
 * not have), so the preview is the home grid's card in full: the 수정 card shows the market's
 * own 참여자, and the 시장 만들기 card '참여자 0'.
 */
export function toPreviewMarket(
  body: CreateMarketFields,
  categories: Category[],
  base?: MarketSummary,
): MarketSummary {
  // An unchosen category is `Number('')`, i.e. 0, which no serial id matches — the placeholder
  // path below. The field is a select, so there is no half-typed id to worry about.
  const category = categories.find((c) => c.id === body.categoryId);
  const imageUrl = body.imageUrl ?? null;
  const history =
    base !== undefined && isPublicMarketStatus(base.status)
      ? {
          lastPrice: base.lastPrice,
          lastFillAt: base.lastFillAt,
          status: base.status,
          judgementDelayed: base.judgementDelayed,
          disputeUnderReview: base.disputeUnderReview,
          volumeCoin: base.volumeCoin,
          tradeCount: base.tradeCount,
          traderCount: base.traderCount,
          statsRevision: base.statsRevision,
          openAt: base.openAt,
          createdAt: base.createdAt,
          resolvedResult: base.resolvedResult,
          judgementVersion: base.judgementVersion,
          disputeDeadline: base.disputeDeadline,
          disputeOpen: base.disputeOpen,
        }
      : {
          lastPrice: null,
          lastFillAt: null,
          status: 'open' as const,
          judgementDelayed: false,
          disputeUnderReview: false,
          volumeCoin: '0',
          tradeCount: 0,
          traderCount: 0,
          statsRevision: '0',
          openAt: null,
          createdAt: '',
          resolvedResult: null,
          judgementVersion: null,
          disputeDeadline: null,
          disputeOpen: false,
        };
  return {
    id: PREVIEW_ID,
    slug: body.slug ?? PREVIEW_SLUG,
    // The ordering key of `market:status` (A-M3-19), which only a live subscriber compares —
    // the preview card subscribes to nothing, so it carries none even when `base` has one.
    statusEventId: null,
    title: body.title,
    // The lookup only misses while the select still shows its placeholder — or, on the edit form,
    // when the market's category has since been retired — so the tag says what the field says.
    category: category ?? { nameKo: copy.adminMarketCategoryPlaceholder, slug: '' },
    // Only once the field holds a URL the API would accept: the card puts `imageUrl` straight
    // into an `<img>`, and a half-typed one would have the browser fetch `htt` per keystroke.
    imageUrl: imageUrl !== null && isHttpUrl(imageUrl) ? imageUrl : null,
    // `''` while the required field is empty: the badge's formatter renders that blank and it reads
    // 마감됨 until a close time is typed. Inventing an instant would mean reading the clock here.
    closeAt: body.closeAt,
    ...history,
  };
}

/**
 * What the detail's rules area (`RulesSection`) draws (#23, #22): the rule items but 배경, which is
 * its own section before it, the times and the judgement time zone, and the status, which says
 * whether it draws the 예정 개장 시각 row (only before the market opens).
 */
export type PreviewRules = Pick<
  Market,
  | 'yesCondition'
  | 'noCondition'
  | 'eventDeadline'
  | 'primarySource'
  | 'fallbackSources'
  | 'fallbackCondition'
  | 'longDelayDays'
  | 'delayHandling'
  | 'scheduledOpenAt'
  | 'closeAt'
  | 'scheduledAnnouncementAt'
  | 'scheduledJudgementAt'
  | 'judgementTimeZone'
  | 'status'
>;

/**
 * The form's rule items and times as the detail's rules area draws them (#23, #22), for the 상세
 * 미리보기: `toCreateMarketBody` has trimmed them, so a blank item reads '—' as on the visitor's
 * screen, an empty fallback list 없음 and a blank announcement 없음. A half-typed source address
 * goes as typed: the area links a name only to an http(s) address (`sourceView`), as it does for a
 * visitor. The status is the edited market's (`status`), or a draft's on 시장 만들기 — what the
 * market is now, so the preview draws the 예정 개장 시각 row exactly while a visitor's detail would.
 * The admin layout holds the area at KST, so no time shows a second, 판정 기준 시간대 line here.
 * Total, so a half-typed form is safe to hand it.
 */
export function toPreviewRules(
  body: CreateMarketFields,
  status: MarketStatus = 'draft',
): PreviewRules {
  return {
    yesCondition: body.yesCondition ?? '',
    noCondition: body.noCondition ?? '',
    eventDeadline: body.eventDeadline ?? null,
    primarySource: body.primarySource ?? null,
    fallbackSources: body.fallbackSources ?? [],
    fallbackCondition: body.fallbackCondition ?? '',
    longDelayDays: body.longDelayDays ?? null,
    delayHandling: body.delayHandling ?? '',
    scheduledOpenAt: body.scheduledOpenAt ?? null,
    closeAt: body.closeAt,
    scheduledAnnouncementAt: body.scheduledAnnouncementAt ?? null,
    scheduledJudgementAt: body.scheduledJudgementAt ?? null,
    judgementTimeZone: body.judgementTimeZone ?? null,
    status,
  };
}
