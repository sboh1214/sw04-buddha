import {
  DEFAULT_LIQUIDITY_B,
  LIQUIDITY_B_MAX,
  LIQUIDITY_B_MIN,
  MARKET_IMAGE_URL_MAX,
  MARKET_RESOLVE_EVIDENCE_URL_MAX,
  MARKET_RESOLVE_NOTE_MAX,
  MARKET_SOURCE_MAX,
  MARKET_TEXT_MAX,
  MARKET_TITLE_MAX,
  MARKET_VOID_REASON_MAX,
  type MarketStatus,
  OUTCOMES,
  formatP,
  marketSlugSchema,
  maxLossP,
} from '@buddha/shared';
import type { KeepStateOptions } from 'react-hook-form';
import * as z from 'zod';
import { copy } from '@/copy';
import {
  type AdminMarket,
  type Category,
  type CreateMarketBody,
  type ResolveMarketBody,
  type UpdateMarketBody,
} from './api';
import { isoToKstLocal, kstLocalToIso } from './datetime';

/**
 * The admin market form (PLAN 12, design §4), shared by create and edit. Field values are the
 * strings the inputs hold; the probability is the Slider's number. Conversion to the API body
 * happens once, in `toCreateMarketBody` / `toUpdateMarketBody`, so the two screens cannot
 * disagree about it.
 */
export interface MarketFormValues {
  title: string;
  description: string;
  rules: string;
  resolutionSource: string;
  /** The category's id as the `<select>` holds it; '' until one is chosen. */
  categoryId: string;
  imageUrl: string;
  /** `datetime-local` in KST (lib/datetime). */
  closeAt: string;
  /** 1..99; `initialProbBp = pct * 100` on the wire. */
  probabilityPct: number;
  liquidityB: string;
  /** Blank asks the server to derive one from the title (create only). */
  slug: string;
}

export const EMPTY_MARKET_FORM: MarketFormValues = {
  title: '',
  description: '',
  rules: '',
  resolutionSource: '',
  categoryId: '',
  imageUrl: '',
  closeAt: '',
  probabilityPct: 50,
  liquidityB: String(DEFAULT_LIQUIDITY_B),
  slug: '',
};

/** The API's `z.url({ protocol: /^https?$/ })`, restated only as far as the form needs it. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** ≤ 6 decimals, as the API's numeric(18,6) column holds (shared `atMostSixDecimals`). */
const LIQUIDITY_PATTERN = /^\d+(\.\d{1,6})?$/;

const CATEGORY_ID_PATTERN = /^\d+$/;

/**
 * `original` is the prefilled edit form: a close time the admin did not touch is exempt from
 * the "must be in the future" rule, so a draft whose close time has passed can still have its
 * title fixed (the PATCH body omits an unchanged `closeAt`, and the API checks only what is
 * sent). A category prefilled as '' — retired since the market was made — is exempt the same
 * way while it stays untouched: `toUpdateMarketBody` never sends the blank, and the API
 * accepts a PATCH without `categoryId`. `rulesRequired` is the edit form of an open market:
 * a draft may be saved with blank rules, a live market may not be edited down to none (the
 * API refuses that with RULES_REQUIRED). Unlike `closeAt`, an untouched blank is not exempt
 * there — an open market without rules is an anomaly the admin must fix before saving
 * anything else. `now` is injectable for tests.
 */
export function marketFormSchema(
  options: { original?: MarketFormValues; now?: () => number; rulesRequired?: boolean } = {},
) {
  const now = options.now ?? Date.now;
  const rules = options.rulesRequired
    ? z.string().trim().min(1, copy.errMarketRulesOpen)
    : z.string().trim();
  return z.object({
    title: z.string().trim().min(1, copy.errMarketTitle).max(MARKET_TITLE_MAX, copy.errMarketTitle),
    description: z.string().trim().max(MARKET_TEXT_MAX, copy.errMarketText),
    rules: rules.max(MARKET_TEXT_MAX, copy.errMarketText),
    resolutionSource: z.string().trim().max(MARKET_SOURCE_MAX, copy.errMarketSource),
    categoryId: z
      .string()
      .refine(
        (value) =>
          (options.original !== undefined && value === '' && options.original.categoryId === '') ||
          CATEGORY_ID_PATTERN.test(value),
        copy.errMarketCategory,
      ),
    imageUrl: z
      .string()
      .trim()
      .refine(
        (value) => value === '' || (value.length <= MARKET_IMAGE_URL_MAX && isHttpUrl(value)),
        copy.errMarketImageUrl,
      ),
    closeAt: z.string().refine((value) => {
      if (options.original !== undefined && value === options.original.closeAt) return true;
      const iso = kstLocalToIso(value);
      return iso !== null && new Date(iso).getTime() > now();
    }, copy.errMarketCloseAt),
    probabilityPct: z.number().int().min(1, copy.errMarketInvalid).max(99, copy.errMarketInvalid),
    liquidityB: z
      .string()
      .trim()
      .refine((value) => {
        if (!LIQUIDITY_PATTERN.test(value)) return false;
        const b = Number(value);
        return b >= LIQUIDITY_B_MIN && b <= LIQUIDITY_B_MAX;
      }, copy.errMarketLiquidity),
    slug: z
      .string()
      .trim()
      .refine(
        (value) => value === '' || marketSlugSchema.safeParse(value).success,
        copy.errMarketSlug,
      ),
  });
}

/**
 * Reset policies of the edit form. `useForm({ resetOptions })` governs the reset the `values`
 * prop performs when the server's values change, and react-hook-form merges the same options
 * under every explicit `reset()` — so a reset that must NOT keep edits has to say so.
 */
/**
 * A refetch in the background (a window focus past staleTime, another admin's write, a socket
 * update): fields the admin has edited keep their input, the rest follow the server, and the
 * form stays dirty — nothing typed is lost, and the diff on save is taken against the newest
 * server values.
 */
export const FOLLOW_SERVER_RESET = {
  keepDirtyValues: true,
  keepDirty: true,
} satisfies KeepStateOptions;
/**
 * After a save: a clean restart on the row the API answered with (trimmed, normalised). The
 * saved fields are still marked dirty at that point, so the follow-server policy would keep
 * the untrimmed input and leave the form dirty. `keepFieldsRef` keeps the registered inputs
 * bound across the reset, so a keystroke before the next render is not dropped.
 */
export const AFTER_SAVE_RESET = {
  keepDirtyValues: false,
  keepDirty: false,
  keepFieldsRef: true,
} satisfies KeepStateOptions;

/** The 무효 dialog's one field (design §4: reason required, `voidMarketBodySchema { reason: 1..500 }`). */
export const voidMarketFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, copy.errMarketVoidReason)
    .max(MARKET_VOID_REASON_MAX, copy.errMarketVoidReason),
});
export type VoidMarketFormValues = z.infer<typeof voidMarketFormSchema>;

/**
 * The 정산 / 결과 변경 dialog (PLAN 12 정산 화면, design 5.5): the result is the one required
 * field, chosen by radio, so an untouched form holds no `result` at all rather than a
 * sentinel. The field's INPUT therefore admits `undefined` and its OUTPUT does not — the
 * `.optional().pipe(...)` is what lets `zodResolver` type the form's values one way and the
 * submitted values the other (`ResolveMarketFormValues` / `ResolveMarketFormOutput`), so the
 * dialog says 결과를 선택해 주세요 for a blank and the submit handler still receives a result
 * it need not re-check. Note and evidence are the strings the inputs hold; blanks become null
 * on the wire (`toResolveMarketBody`), and the API bounds both the same way
 * (`resolveMarketBodySchema`). Whether the chosen result differs from the current one is the
 * dialog's business, not the schema's: the change variant disables its button for the result
 * on screen, and the API refuses a stale one naming `result` (`transitionErrorMessage`).
 */
export const resolveMarketFormSchema = z.object({
  result: z
    .enum(OUTCOMES, copy.errMarketResultRequired)
    .optional()
    .pipe(z.enum(OUTCOMES, copy.errMarketResultRequired)),
  note: z.string().trim().max(MARKET_RESOLVE_NOTE_MAX, copy.errMarketResolveNote),
  evidenceUrl: z
    .string()
    .trim()
    .refine(
      (value) =>
        value === '' || (value.length <= MARKET_RESOLVE_EVIDENCE_URL_MAX && isHttpUrl(value)),
      copy.errMarketResolveEvidence,
    ),
});
/** What the inputs hold: `result` is absent until a radio is chosen. */
export type ResolveMarketFormValues = z.input<typeof resolveMarketFormSchema>;
/** What the schema hands the submit handler: a result, always. */
export type ResolveMarketFormOutput = z.output<typeof resolveMarketFormSchema>;

/** Only for values `resolveMarketFormSchema` accepted: trimmed, blanks to null. */
export function toResolveMarketBody(values: ResolveMarketFormOutput): ResolveMarketBody {
  return {
    result: values.result,
    note: orNull(values.note),
    evidenceUrl: orNull(values.evidenceUrl),
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/** Only for values `marketFormSchema` accepted: `closeAt` parses and `categoryId` is digits. */
export function toCreateMarketBody(values: MarketFormValues): CreateMarketBody {
  return {
    title: values.title.trim(),
    description: orNull(values.description),
    rules: values.rules.trim(),
    resolutionSource: orNull(values.resolutionSource),
    categoryId: Number(values.categoryId),
    imageUrl: orNull(values.imageUrl),
    closeAt: kstLocalToIso(values.closeAt) ?? '',
    initialProbBp: values.probabilityPct * 100,
    liquidityB: Number(values.liquidityB),
    ...(values.slug.trim() ? { slug: values.slug.trim() } : {}),
  };
}

/**
 * The PATCH body: only the fields that differ from the prefilled `original`, so an unchanged
 * close time in the past is never sent and the API's per-status refusals (design 3.4) are
 * only met by a field the admin actually touched. `liquidityB` / `initialProbBp` are dropped
 * unless the market is still a draft — the inputs are disabled then, but a stale form must
 * not turn a title edit into a 400 naming `liquidityB`. The slug is not editable here.
 * `{}` when nothing changed; the caller must not send that (the API refuses an empty update).
 */
export function toUpdateMarketBody(
  values: MarketFormValues,
  original: MarketFormValues,
  status: MarketStatus,
): UpdateMarketBody {
  const next = toCreateMarketBody(values);
  const before = toCreateMarketBody(original);
  const body: UpdateMarketBody = {};
  if (next.title !== before.title) body.title = next.title;
  if (next.description !== before.description) body.description = next.description;
  if (next.rules !== before.rules) body.rules = next.rules;
  if (next.resolutionSource !== before.resolutionSource) {
    body.resolutionSource = next.resolutionSource;
  }
  if (values.categoryId !== original.categoryId && values.categoryId !== '') {
    body.categoryId = next.categoryId;
  }
  if (next.imageUrl !== before.imageUrl) body.imageUrl = next.imageUrl;
  if (values.closeAt !== original.closeAt) body.closeAt = next.closeAt;
  if (status === 'draft') {
    if (next.initialProbBp !== before.initialProbBp) body.initialProbBp = next.initialProbBp;
    if (next.liquidityB !== before.liquidityB) body.liquidityB = next.liquidityB;
  }
  return body;
}

/**
 * The edit form's starting values. `AdminMarket` carries the category by slug, not id, so the
 * id is looked up in the active list; a market whose category has since been retired starts
 * with '' (the select shows the placeholder, and the unchanged value is never sent).
 */
export function marketToFormValues(market: AdminMarket, categories: Category[]): MarketFormValues {
  const category = categories.find((c) => c.slug === market.category.slug);
  return {
    title: market.title,
    description: market.description ?? '',
    rules: market.rules,
    resolutionSource: market.resolutionSource ?? '',
    categoryId: category === undefined ? '' : String(category.id),
    imageUrl: market.imageUrl ?? '',
    closeAt: isoToKstLocal(market.closeAt),
    probabilityPct: Math.min(99, Math.max(1, Math.round(market.initialProbBp / 100))),
    liquidityB: trimNumeric(market.liquidityB),
    slug: market.slug,
  };
}

/** `numeric(18,6)` arrives as "1000.000000"; the input is nicer to read as "1000". */
function trimNumeric(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : value;
}

/**
 * PLAN 12's live help under the liquidity input: the operator's worst case for this initial
 * probability and b, from the shared `maxLossP` (ADR-0027) — never re-derived here. Undefined
 * while the inputs cannot be read, so the help line simply stays blank rather than throwing.
 */
export function maxLossHelp(probabilityPct: number, liquidityB: string): string | undefined {
  if (!Number.isInteger(probabilityPct) || probabilityPct < 1 || probabilityPct > 99) {
    return undefined;
  }
  if (!LIQUIDITY_PATTERN.test(liquidityB.trim())) return undefined;
  const b = Number(liquidityB);
  if (b < LIQUIDITY_B_MIN || b > LIQUIDITY_B_MAX) return undefined;
  return `${copy.adminMarketMaxLoss} ${formatP(maxLossP(probabilityPct / 100, b))}`;
}
