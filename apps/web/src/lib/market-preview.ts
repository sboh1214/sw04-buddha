import { copy } from '@/copy';
import { type Category, type CreateMarketFields, type MarketSummary } from '@/lib/api';
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
 * The HISTORY — everything the form cannot express — comes from `base` whenever there is one
 * that has left draft, and only otherwise from the placeholders. A draft has never traded and
 * never reaches a visitor's grid (the public list excludes it), so every placeholder is TRUE for
 * a draft and for the unsaved market on 시장 만들기: no fill, so the price is `null` and the card
 * reads 체결 없음 (N02 §5) — there is no initial probability to show as one (#125). Anything past
 * draft has a history of its own, and the 수정 card must preview the card visitors see, not one
 * with 체결 없음 and '참여자 0'. Of that history the card draws the price, the status, the
 * countdown and the 참여자; `volumeCoin` and `tradeCount` come along only because a
 * `MarketSummary` carries them.
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
    base !== undefined && base.status !== 'draft'
      ? {
          lastPrice: base.lastPrice,
          status: base.status,
          volumeCoin: base.volumeCoin,
          tradeCount: base.tradeCount,
          traderCount: base.traderCount,
          openAt: base.openAt,
          createdAt: base.createdAt,
          resolvedResult: base.resolvedResult,
        }
      : {
          lastPrice: null,
          status: 'open' as const,
          volumeCoin: '0',
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
    // `''` while the required field is empty: the badge's formatter renders that blank and it reads
    // 마감됨 until a close time is typed. Inventing an instant would mean reading the clock here.
    closeAt: body.closeAt,
    ...history,
  };
}
