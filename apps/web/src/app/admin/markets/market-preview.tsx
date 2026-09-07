'use client';

import { SimpleGrid, Stack, Text } from '@chakra-ui/react';
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
import { MarketCard } from '@/components/market/market-card';
import { RulesSection } from '@/components/market/rules-section';
import { copy } from '@/copy';
import { type Category, type CreateMarketBody, type MarketSummary } from '@/lib/api';
import { type MarketFormValues, isHttpUrl, toCreateMarketBody } from '@/lib/market-form';

/**
 * 카드·상세 미리보기 (PLAN 12), the preview ADR-0027 deferred to M4 (Q-M3-6).
 *
 * It draws the REAL `MarketCard` and the REAL `RulesSection` from what the form is holding right
 * now — that deferral is the whole point. A preview assembled out of lookalike markup would drift
 * from the visitor's screen the first time either component changed, and the admin would be
 * approving a picture of a market nobody sees. So nothing here re-implements a card.
 *
 * Read-only in the strict sense: no query, no mutation, and no clock. `CountdownBadge` with no
 * `now` shows the absolute close time until it has mounted (countdown-badge.tsx), which is what a
 * client component that Next also renders on the server needs — a `Date.now()` in this render
 * would put a different string in the server's HTML than in the first client render.
 */

/**
 * A draft has no id and no page yet, and the card needs both fields to exist rather than to be
 * real: the id only names the card's testid, and the slug only builds a link this component
 * neutralises below. Constants, not something derived from the form, so the markup does not churn
 * on every keystroke.
 */
const PREVIEW_ID = '00000000-0000-0000-0000-000000000000';
const PREVIEW_SLUG = 'preview';

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
 * Everything the server alone knows gets a neutral placeholder: a draft has never traded, and the
 * status is always `open` — the question a preview answers is what the card looks like once the
 * market is live, and the form only accepts edits while a market is draft or open anyway
 * (`isEditable`), so that is the truthful answer wherever the fields can still be changed. No
 * sparkline either: a draft has no ticks, and the card renders the gap rather than inventing a
 * line.
 */
function toPreviewMarket(body: CreateMarketBody, categories: Category[]): MarketSummary {
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
  return {
    id: PREVIEW_ID,
    slug: body.slug ?? PREVIEW_SLUG,
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
    lastPrice: priceOf(state),
    pYesBp: probabilityBp(state),
    status: 'open',
    volumeP: '0',
    tradeCount: 0,
    traderCount: 0,
    openAt: null,
    createdAt: '',
    resolvedResult: null,
  };
}

export interface MarketPreviewProps {
  /** The form's live values (`watch()`), so the preview tracks typing. */
  values: MarketFormValues;
  /** The active categories the select was built from; the card's tag needs the Korean name. */
  categories: Category[];
}

export function MarketPreview({ values, categories }: MarketPreviewProps) {
  const body = toCreateMarketBody(values);
  // Nothing worth previewing before the question is typed, and a card without one would put a
  // link with no accessible name on the page — an accessibility failure, not just noise.
  if (body.title === '') return null;

  return (
    <Stack gap="3" borderTopWidth="1px" pt="4" data-testid="market-preview">
      <Text fontWeight="semibold">{copy.adminMarketPreview}</Text>
      <SimpleGrid columns={{ base: 1, md: 2 }} gap="4" alignItems="start">
        <Stack
          gap="2"
          // The card is a picture of the form, not a way out of it: `LinkOverlay` makes the whole
          // card a link to `/markets/[slug]`, which for an unsaved draft is a page that does not
          // exist and from an edit would abandon what is typed. `next/link` returns early when
          // the click is already default-prevented, so this one capture-phase handler stops both
          // the anchor's navigation and the router's, and the card stays readable and focusable.
          onClickCapture={(event) => {
            event.preventDefault();
          }}
        >
          <Text fontSize="sm" color="fg.muted">
            {copy.adminMarketPreviewCard}
          </Text>
          <MarketCard market={toPreviewMarket(body, categories)} />
        </Stack>
        <Stack gap="2">
          <Text fontSize="sm" color="fg.muted">
            {copy.adminMarketPreviewDetail}
          </Text>
          {/* `RulesSection` defaults to `market-rules`, which the 정산 기준 textarea above owns. */}
          <RulesSection
            market={{
              rules: body.rules,
              resolutionSource: body.resolutionSource ?? null,
              closeAt: body.closeAt,
            }}
            data-testid="market-preview-rules"
          />
        </Stack>
      </SimpleGrid>
    </Stack>
  );
}
