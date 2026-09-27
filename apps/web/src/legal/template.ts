/**
 * `{{key}}` substitution for the legal pages and the footer (ADR-0044): every business fact is
 * written ONCE, in `business-info.ts`, and the prose that mentions it carries a placeholder.
 *
 * Deliberately strict. A placeholder that names no known key throws instead of rendering the
 * braces or an empty string: a 이용약관 that says "상호: {{companyNmae}}" — or worse, "상호: " —
 * is a published legal text with a hole in it, and the static pages are prerendered by `next
 * build`, so a throw here fails the build rather than a visitor's page. The unit tests resolve
 * every document with the real values for the same reason.
 *
 * One pass, left to right: a substituted value is never scanned again, so a value that happens
 * to contain braces cannot expand into another placeholder.
 */

/** `{{ key }}` with optional inner spaces; the key itself is captured untrimmed. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

export class UnknownTemplateKeyError extends Error {
  constructor(readonly key: string) {
    super(`Unknown template key: {{${key}}}`);
    this.name = 'UnknownTemplateKeyError';
  }
}

/**
 * Replaces every `{{key}}` in `text` with `values[key]`.
 *
 * Own properties only (`Object.hasOwn`), so `{{toString}}` or `{{constructor}}` is an unknown key
 * like any other rather than a stringified function.
 *
 * @throws UnknownTemplateKeyError when a placeholder names a key `values` does not have.
 */
export function fillTemplate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (_match, raw: string) => {
    const key = raw.trim();
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (value === undefined) throw new UnknownTemplateKeyError(key);
    return value;
  });
}

/** The keys `text` names, in order of appearance, duplicates included (for tests and audits). */
export function templateKeys(text: string): string[] {
  return Array.from(text.matchAll(PLACEHOLDER), (match) => (match[1] ?? '').trim());
}
