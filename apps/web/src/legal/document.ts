import { BUSINESS_INFO } from './business-info';
import { fillTemplate } from './template';

/**
 * The shape of 이용약관, 개인정보처리방침 and 환불정책 (ADR-0044): structured data rather than a
 * block of markup, so one renderer (`legal-document-view.tsx`) gives the three pages the same
 * typography, and so the tests can walk every string — resolve its `{{placeholders}}`, and check
 * it for the vocabulary PLAN Appendix A bans — without a DOM.
 *
 * Every string may carry `{{key}}` placeholders naming `BUSINESS_INFO` keys. The modules hold
 * the raw text; `resolveLegalDocument` is what a page renders.
 */

/** A list item, optionally with its own sub-items (a 조's 호 under a 항). */
export type LegalListItem = string | { readonly text: string; readonly items: readonly string[] };

export type LegalBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly LegalListItem[] }
  | {
      readonly kind: 'table';
      /** Read out by screen readers and shown above the table. */
      readonly caption: string;
      readonly head: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

export interface LegalSection {
  /** The bare name, e.g. `목적`; the renderer adds `제1조` or `1.` (`sectionHeading`). */
  readonly heading: string;
  readonly blocks: readonly LegalBlock[];
}

export interface LegalDocument {
  readonly title: string;
  /** `article` is 제1조(목적) — the 약관 convention; `decimal` is 1. 목적. */
  readonly numbering: 'article' | 'decimal';
  /** Shown under the title before the first section. */
  readonly intro: readonly LegalBlock[];
  readonly sections: readonly LegalSection[];
  /** 부칙: the effective date line and anything that belongs after the last section. */
  readonly addendum: readonly LegalBlock[];
}

// Shorthand for the document modules, which are mostly prose.
export const paragraph = (text: string): LegalBlock => ({ kind: 'paragraph', text });
export const numbered = (...items: LegalListItem[]): LegalBlock => ({
  kind: 'list',
  ordered: true,
  items,
});
export const bullets = (...items: LegalListItem[]): LegalBlock => ({
  kind: 'list',
  ordered: false,
  items,
});
export const table = (
  caption: string,
  head: readonly string[],
  rows: readonly (readonly string[])[],
): LegalBlock => ({ kind: 'table', caption, head, rows });

/** `제3조(P의 충전)` or `3. 환불 방법`; `index` is zero-based. */
export function sectionHeading(
  numbering: LegalDocument['numbering'],
  index: number,
  heading: string,
): string {
  const n = String(index + 1);
  return numbering === 'article' ? `제${n}조(${heading})` : `${n}. ${heading}`;
}

function mapBlock(block: LegalBlock, map: (text: string) => string): LegalBlock {
  switch (block.kind) {
    case 'paragraph':
      return { kind: 'paragraph', text: map(block.text) };
    case 'list':
      return {
        kind: 'list',
        ordered: block.ordered,
        items: block.items.map((item) =>
          typeof item === 'string'
            ? map(item)
            : { text: map(item.text), items: item.items.map(map) },
        ),
      };
    case 'table':
      return {
        kind: 'table',
        caption: map(block.caption),
        head: block.head.map(map),
        rows: block.rows.map((row) => row.map(map)),
      };
  }
}

/** The same document with `map` applied to every string in it. */
export function mapLegalDocument(doc: LegalDocument, map: (text: string) => string): LegalDocument {
  const blocks = (list: readonly LegalBlock[]) => list.map((block) => mapBlock(block, map));
  return {
    title: map(doc.title),
    numbering: doc.numbering,
    intro: blocks(doc.intro),
    sections: doc.sections.map((section) => ({
      heading: map(section.heading),
      blocks: blocks(section.blocks),
    })),
    addendum: blocks(doc.addendum),
  };
}

/** Every string in the document, in reading order (tests: placeholders, banned words). */
export function legalDocumentStrings(doc: LegalDocument): string[] {
  const out: string[] = [];
  mapLegalDocument(doc, (text) => {
    out.push(text);
    return text;
  });
  return out;
}

/**
 * The document as a page renders it: every placeholder replaced with the business facts.
 * Throws `UnknownTemplateKeyError` on a placeholder that names no fact — see `template.ts` for
 * why that is a build failure rather than a blank.
 */
export function resolveLegalDocument(
  doc: LegalDocument,
  values: Readonly<Record<string, string>> = BUSINESS_INFO,
): LegalDocument {
  return mapLegalDocument(doc, (text) => fillTemplate(text, values));
}
