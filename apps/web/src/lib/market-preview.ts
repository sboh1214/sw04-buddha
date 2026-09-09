import {
  BP_MAX,
  DEFAULT_LIQUIDITY_B,
  INITIAL_PROB_BP_MAX,
  INITIAL_PROB_BP_MIN,
  LIQUIDITY_B_MAX,
  LIQUIDITY_B_MIN,
  initState,
  priceOf,
  probabilityBp,
} from '@buddha/shared';
import { copy } from '@/copy';
import { type Category, type CreateMarketBody, type MarketSummary } from '@/lib/api';
import { canEditLiquidity } from '@/lib/market-admin';
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
 * `initState` refuses a p0 outside (0, 1) and a non-positive b, and a form being typed into is not
 * inside that domain — the liquidity field is a string, so `Number` reads an empty one as 0 and a
 * mistyped one as `NaN` — and a throw here would take the whole admin form down between two
 * keystrokes. The bounds are the schema's own, so anything the admin may actually save previews
 * exactly as it saves; only a value the form is about to reject is clamped at all.
 */
function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * The form's values as the row a visitor's card is drawn from. `toCreateMarketBody` does the
 * trimming and the empty→null conversion, so the preview cannot disagree with what a save would
 * send; it is total, so a half-typed form is safe to hand it.
 *
 * The HISTORY — everything the form cannot express — comes from `base` whenever there is one and
 * the curve is already frozen, and only otherwise from the placeholders.
 *
 * THE HAZARD those placeholders used to be: the same component draws 시장 만들기 AND the detail
 * screen's 수정 card, and the placeholders were written for the first. On an OPEN market that had
 * traded, the preview re-derived its price from `initialProbBp` — a value the API refuses to
 * change once open, so it is the price the market STARTED at. The card presented as the real one
 * therefore showed 50% beside a public card showing 70%, with 거래량 0 and no participants, and
 * the admin approved an edit against it.
 *
 * `canEditLiquidity` is the right condition and not a coincidence: it is the same `status ===
 * 'draft'` that freezes the curve. A draft has never traded and never reaches a visitor's grid
 * (the public list excludes it), so every placeholder is TRUE for a draft and for the unsaved
 * market on 시장 만들기 — and false for exactly the markets `base` describes. What was an
 * assumption in this file's own comment is now the branch.
 *
 * Written as two exhaustive objects rather than `base?.x ?? fallback`: `??` reads fine for
 * `lastPrice` but hides that `openAt` and `resolvedResult` are legitimately null on a live row,
 * which would silently take the placeholder for a market that has one.
 *
 * The sparkline stays absent either way — `AdminMarket` carries no tick series — so the preview
 * card is visibly one element short of the home grid's. That is a known gap, not parity.
 */
export function toPreviewMarket(
  body: CreateMarketBody,
  categories: Category[],
  base?: MarketSummary,
): MarketSummary {
  // The API derives the opening price from `initState(p0, b)` (market-admin.service.ts), so this
  // does too — PLAN 11.5: a price a screen shows is never re-derived by hand.
  const state = initState(
    clamp(body.initialProbBp, INITIAL_PROB_BP_MIN, INITIAL_PROB_BP_MAX, BP_MAX / 2) / BP_MAX,
    clamp(body.liquidityB, LIQUIDITY_B_MIN, LIQUIDITY_B_MAX, DEFAULT_LIQUIDITY_B),
  );
  // An unchosen category is `Number('')`, i.e. 0, which no serial id matches — the placeholder
  // path below. The field is a select, so there is no half-typed id to worry about.
  const category = categories.find((c) => c.id === body.categoryId);
  const imageUrl = body.imageUrl ?? null;
  const history =
    base !== undefined && !canEditLiquidity(base.status)
      ? {
          lastPrice: base.lastPrice,
          pYesBp: base.pYesBp,
          status: base.status,
          volumeP: base.volumeP,
          tradeCount: base.tradeCount,
          traderCount: base.traderCount,
          openAt: base.openAt,
          createdAt: base.createdAt,
          resolvedResult: base.resolvedResult,
        }
      : {
          lastPrice: priceOf(state),
          pYesBp: probabilityBp(state),
          status: 'open' as const,
          volumeP: '0',
          tradeCount: 0,
          traderCount: 0,
          openAt: null,
          createdAt: '',
          resolvedResult: null,
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
    // `''` while the required field is empty: `formatKst` renders that blank and the badge reads
    // 마감됨 until a close time is typed. Inventing an instant would mean reading the clock here.
    closeAt: body.closeAt,
    ...history,
  };
}
