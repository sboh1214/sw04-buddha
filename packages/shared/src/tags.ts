import * as z from 'zod';

/**
 * 태그 (#17, ADR-0093 decision 2 #172 item 2): every market carries 1..5 of them once it opens,
 * shared by every category, and an operator makes a new one by typing it while entering a market.
 * Two names that differ only in case or in the spaces around them are one tag (`tagKey`). The
 * detail shows them, each a link to its exact-match search on `/search`; cards do not.
 *
 * A draft may have none: too few is a missing item of the open-items check (`missingOpenItems`),
 * not a refusal at entry, so a draft saves half-done. More than MARKET_TAGS_MAX is refused at
 * entry.
 */
export const MARKET_TAGS_MIN = 1;
export const MARKET_TAGS_MAX = 5;

/** `tags.name` is varchar(20): a word or two, like a nickname. */
export const TAG_NAME_MAX = 20;

/**
 * What a tag name is made of once normalised (`normalizeTagName`): Hangul syllables, Latin letters,
 * digits, single spaces and `-_.&+·` inside it — 'S&P500', 'K-팝', '2026 지방선거', 'C++'. Not `#`
 * (the detail draws no prefix, and a typed '#AI' would be a second spelling of 'AI'), nor the
 * comma that separates tags in a pasted list, nor anything that sorts or prints oddly.
 */
export const TAG_NAME_PATTERN =
  /^[가-힣A-Za-z0-9](?:[가-힣A-Za-z0-9 \-_.&+·]*[가-힣A-Za-z0-9.&+])?$/;

/** NFC, the surrounding spaces gone and every inner run of whitespace one space. */
export function normalizeTagName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/**
 * What makes two names one tag: the normalised name in lower case. The charset holds no cased
 * letter but Latin (Hangul has none), so this is Postgres's `lower()` on the same value — the
 * `tags.name_key` column the unique index is on, and what the search compares a term with.
 */
export function tagKey(name: string): string {
  return normalizeTagName(name).toLowerCase();
}

export const tagNameSchema = z
  .string()
  .transform(normalizeTagName)
  .pipe(
    z
      .string()
      .min(1)
      .max(TAG_NAME_MAX)
      .regex(TAG_NAME_PATTERN, 'only Korean, letters, digits, spaces and -_.&+·'),
  );

/**
 * A market's tags as an admin sends them, in the order the detail shows: at most MARKET_TAGS_MAX,
 * no two the same tag. A duplicate is refused naming its index rather than dropped, so what was
 * typed is what is stored.
 */
export const marketTagsSchema = z
  .array(tagNameSchema)
  .max(MARKET_TAGS_MAX)
  .superRefine((names, ctx) => {
    const seen = new Set<string>();
    names.forEach((name, index) => {
      const key = tagKey(name);
      if (seen.has(key)) ctx.addIssue({ code: 'custom', message: 'duplicate tag', path: [index] });
      seen.add(key);
    });
  });
