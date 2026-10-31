import {
  MARKET_IMAGE_URL_MAX,
  MARKET_RESOLVE_EVIDENCE_URL_MAX,
  MARKET_RESOLVE_NOTE_MAX,
  MARKET_SOURCE_MAX,
  MARKET_TAGS_MAX,
  MARKET_TEXT_MAX,
  MARKET_TITLE_MAX,
  OUTCOMES,
  TAG_NAME_MAX,
  TAG_NAME_PATTERN,
  marketSlugSchema,
  normalizeTagName,
  tagKey,
} from '@buddha/shared';
import type { KeepStateOptions } from 'react-hook-form';
import * as z from 'zod';
import { copy } from '@/copy';
import {
  type AdminMarket,
  type Category,
  type CreateMarketFields,
  type ResolveMarketBody,
  type UpdateMarketFields,
} from './api';
import { isoToKstLocal, kstLocalToIso } from './datetime';

/**
 * The admin market form (PLAN 12, design §4), shared by create and edit. Field values are the
 * strings the inputs hold. Conversion to the API body happens once, in `toCreateMarketBody` /
 * `toUpdateMarketBody`, so the two screens cannot disagree about it. There is no initial
 * probability or liquidity: the direct AMM those set up is gone (#125), and a market is made
 * without either.
 */
export interface MarketFormValues {
  title: string;
  description: string;
  rules: string;
  resolutionSource: string;
  /** The category's id as the `<select>` holds it; '' until one is chosen. */
  categoryId: string;
  /**
   * The tags in entry order (#17, ADR-0093 decision 2 #172 item 2), each as `normalizeTagName` left
   * it when it went in (`addTags`); [] until one is added, and a draft may be saved so. A name some
   * tag already has in another case is linked to that tag's first spelling by the API, which the
   * form shows once the answer comes back.
   */
  tags: string[];
  /**
   * What the tag box holds and has not added: never sent. The box adds on Enter and 넣기 only,
   * and a save with a name still in it is refused (`errMarketTagPending`) rather than dropping
   * the name.
   */
  tagInput: string;
  imageUrl: string;
  /** `datetime-local` in KST (lib/datetime). */
  closeAt: string;
  /** Blank asks the server to derive one from the title (create only). */
  slug: string;
}

export const EMPTY_MARKET_FORM: MarketFormValues = {
  title: '',
  description: '',
  rules: '',
  resolutionSource: '',
  categoryId: '',
  tags: [],
  tagInput: '',
  imageUrl: '',
  closeAt: '',
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

const CATEGORY_ID_PATTERN = /^\d+$/;

/**
 * Why `name` (normalised) cannot join `tags`, or `undefined` when it can: the shared rules of
 * `marketTagsSchema` — at most MARKET_TAGS_MAX, TAG_NAME_MAX characters (zod's count, UTF-16 units,
 * as the API's), TAG_NAME_PATTERN, and no second name of one tag (`tagKey`: case and spacing aside)
 * — in Korean, so the box says which rule it was.
 */
function tagRefusal(tags: readonly string[], name: string): string | undefined {
  if (tags.length >= MARKET_TAGS_MAX) return copy.errMarketTagsMax;
  if (name.length > TAG_NAME_MAX) return copy.errMarketTagLength;
  if (!TAG_NAME_PATTERN.test(name)) return copy.errMarketTagFormat;
  const key = tagKey(name);
  if (tags.some((tag) => tagKey(tag) === key)) return copy.errMarketTagDuplicate;
  return undefined;
}

/** What adding the tag box's text did (`addTags`). */
export interface TagAddition {
  /** The tags after it, in entry order: the names that went in are at the end. */
  tags: string[];
  /** What stays in the box: '' once everything went in, else the refused name and those after. */
  rest: string;
  /** Why the first name left in the box was refused; absent when nothing was. */
  error?: string;
}

/**
 * The tag box's text added to `tags` (#17, ADR-0093 decision 2 #172 item 2), on Enter or 넣기:
 * split on commas, so a pasted '서울, 기상청' is two names, each normalised (`normalizeTagName`) and
 * blanks skipped. The names go in in order until one is refused (`tagRefusal`); that one and the
 * text after it stay in the box as typed, with the reason, so nothing typed is lost and what goes
 * in is what the API would take. A comma is never part of a name (TAG_NAME_PATTERN).
 */
export function addTags(tags: readonly string[], input: string): TagAddition {
  const pieces = input.split(',');
  const next = [...tags];
  for (const [index, piece] of pieces.entries()) {
    const name = normalizeTagName(piece);
    if (name === '') continue;
    const error = tagRefusal(next, name);
    if (error !== undefined) {
      return { tags: next, rest: pieces.slice(index).join(',').trim(), error };
    }
    next.push(name);
  }
  return { tags: next, rest: '' };
}

/**
 * Whether two lists are the same tags in the same order — what the API compares too (#17): a name
 * that differs only in case or spacing is the same tag, and the API keeps its first spelling.
 */
export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => tagKey(name) === tagKey(b[index] ?? ''));
}

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
 * anything else. `tagsRequired` is the same for the tags (#17): a draft may have none, an open
 * market may not be edited down to none (the API refuses that naming `tags`, 'required while
 * open'). Unlike the rules, an untouched empty set IS exempt: a market opened before #17 has no
 * tags, and its other fields must stay editable — the form sends no `tags` while they are
 * unchanged, which the API takes. The tags' own rules are the box's (`addTags`), checked again
 * here as a backstop; a name
 * left in the box is refused (`tagInput`). `now` is injectable for tests.
 */
export function marketFormSchema(
  options: {
    original?: MarketFormValues;
    now?: () => number;
    rulesRequired?: boolean;
    tagsRequired?: boolean;
  } = {},
) {
  const now = options.now ?? Date.now;
  const rules = options.rulesRequired
    ? z.string().trim().min(1, copy.errMarketRulesOpen)
    : z.string().trim();
  const tags = z.array(z.string()).superRefine((names, ctx) => {
    const kept: string[] = [];
    for (const name of names) {
      const refusal = tagRefusal(kept, normalizeTagName(name));
      if (refusal !== undefined) {
        ctx.addIssue({ code: 'custom', message: refusal });
        return;
      }
      kept.push(name);
    }
    // Edited down to none: the original had tags (an edit form always passes `original`).
    if (options.tagsRequired && names.length === 0 && (options.original?.tags.length ?? 1) > 0) {
      ctx.addIssue({ code: 'custom', message: copy.errMarketTagsOpen });
    }
  });
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
    tags,
    tagInput: z.string().refine((value) => value.trim() === '', copy.errMarketTagPending),
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

/**
 * The 판정 dialog (PLAN 12 정산 화면, ADR-0046): the result is the one required field, chosen
 * by radio, so an untouched form holds no `result` at all rather than a sentinel. The field's
 * INPUT therefore admits `undefined` and its OUTPUT does not — the
 * `.optional().pipe(...)` is what lets `zodResolver` type the form's values one way and the
 * submitted values the other (`ResolveMarketFormValues` / `ResolveMarketFormOutput`), so the
 * dialog says 결과를 선택해 주세요 for a blank and the submit handler still receives a result
 * it need not re-check. Note and evidence are the strings the inputs hold; blanks become null
 * on the wire (`toResolveMarketBody`), and the API bounds both the same way
 * (`resolveMarketBodySchema`). There is no "same result" rule: a market is judged once, and the
 * API refuses a second 판정 naming `status` (`transitionErrorMessage`).
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

/**
 * Only for values `resolveMarketFormSchema` accepted: trimmed, blanks to null — and the admin on
 * screen, who judges (`useOperatorId`, ADR-0092: the server refuses another account's).
 */
export function toResolveMarketBody(
  values: ResolveMarketFormOutput,
  operatorId: string,
): ResolveMarketBody {
  return {
    result: values.result,
    note: orNull(values.note),
    evidenceUrl: orNull(values.evidenceUrl),
    expectedAccountId: operatorId,
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/**
 * Only for values `marketFormSchema` accepted: `closeAt` parses and `categoryId` is digits. The
 * fields alone — the 미리보기 draws them too; the press adds the admin on screen (ADR-0092). The
 * tags always go, in entry order: none makes a draft without tags (#17), which the open-items
 * check then names.
 */
export function toCreateMarketBody(values: MarketFormValues): CreateMarketFields {
  return {
    title: values.title.trim(),
    description: orNull(values.description),
    rules: values.rules.trim(),
    resolutionSource: orNull(values.resolutionSource),
    categoryId: Number(values.categoryId),
    tags: [...values.tags],
    imageUrl: orNull(values.imageUrl),
    closeAt: kstLocalToIso(values.closeAt) ?? '',
    ...(values.slug.trim() ? { slug: values.slug.trim() } : {}),
  };
}

/**
 * The PATCH body: only the fields that differ from the prefilled `original`, so an unchanged
 * close time in the past is never sent and the API's per-status refusals (design 3.4) are
 * only met by a field the admin actually touched. The slug is not editable here. The tags go as
 * the whole ordered set when it differs (`sameTags`) — the API replaces the set (#17); a name
 * only re-cased is no change there either.
 * `{}` when nothing changed; the caller must not send that (the API refuses an update that names no
 * field beside the admin, which the press adds — ADR-0092).
 */
export function toUpdateMarketBody(
  values: MarketFormValues,
  original: MarketFormValues,
): UpdateMarketFields {
  const next = toCreateMarketBody(values);
  const before = toCreateMarketBody(original);
  const body: UpdateMarketFields = {};
  if (next.title !== before.title) body.title = next.title;
  if (next.description !== before.description) body.description = next.description;
  if (next.rules !== before.rules) body.rules = next.rules;
  if (next.resolutionSource !== before.resolutionSource) {
    body.resolutionSource = next.resolutionSource;
  }
  if (values.categoryId !== original.categoryId && values.categoryId !== '') {
    body.categoryId = next.categoryId;
  }
  if (!sameTags(values.tags, original.tags)) body.tags = [...values.tags];
  if (next.imageUrl !== before.imageUrl) body.imageUrl = next.imageUrl;
  if (values.closeAt !== original.closeAt) body.closeAt = next.closeAt;
  return body;
}

/**
 * The edit form's starting values. `AdminMarket` carries the category by slug, not id, so the
 * id is looked up in the active list; a market whose category has since been retired starts
 * with '' (the select shows the placeholder, and the unchanged value is never sent). The tags
 * are the stored spellings, in order.
 */
export function marketToFormValues(market: AdminMarket, categories: Category[]): MarketFormValues {
  const category = categories.find((c) => c.slug === market.category.slug);
  return {
    title: market.title,
    description: market.description ?? '',
    rules: market.rules,
    resolutionSource: market.resolutionSource ?? '',
    categoryId: category === undefined ? '' : String(category.id),
    tags: [...market.tags],
    tagInput: '',
    imageUrl: market.imageUrl ?? '',
    closeAt: isoToKstLocal(market.closeAt),
    slug: market.slug,
  };
}
