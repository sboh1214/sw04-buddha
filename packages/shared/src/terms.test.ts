import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPLACED_TERMS, type ReplacedTerm, type TermMatch } from './terms.js';

// The doc lives outside this package, so packages/shared/turbo.json names it as an input of
// `test`: a change to the table alone must not replay a cached pass.
const TERMS_DOC = new URL('../../../docs/TERMS.md', import.meta.url);

/** The doc's words for `TermMatch`. */
const MATCH_LABEL: Record<string, TermMatch> = { 글자: 'text', 뜻: 'meaning' };

/** The rows of the `## 대응표` table in docs/TERMS.md, read back into `ReplacedTerm`s. */
function docRows(markdown: string): ReplacedTerm[] {
  const section = markdown.split(/^## /m).find((part) => part.startsWith('대응표'));
  if (section === undefined) throw new Error('docs/TERMS.md has no "## 대응표" section');
  const lines = section.split('\n').filter((line) => line.startsWith('|'));
  // The header and the |---| separator come first.
  return lines.slice(2).map((line) => {
    const [unused, use, basis, match, note] = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const code = (cell: string) => cell.replace(/^`|`$/g, '');
    const row: ReplacedTerm = {
      unused: code(unused ?? ''),
      use: use === '—' ? [] : (use ?? '').split('·').map(code),
      basis: basis ?? '',
      match: MATCH_LABEL[match ?? ''] ?? (match as TermMatch),
      ...(note ? { note } : {}),
    };
    return row;
  });
}

describe('REPLACED_TERMS (#14, docs/TERMS.md)', () => {
  it('is the table in docs/TERMS.md, row for row', () => {
    expect(docRows(readFileSync(TERMS_DOC, 'utf8'))).toEqual(REPLACED_TERMS);
  });

  it('lists each unused expression once, never as its own replacement', () => {
    const unused = REPLACED_TERMS.map((row) => row.unused);
    expect(new Set(unused).size).toBe(unused.length);
    for (const row of REPLACED_TERMS) {
      expect(row.use, row.unused).not.toContain(row.unused);
      expect(row.basis.trim(), row.unused).not.toBe('');
    }
  });

  it('never offers an unused expression as the word to use', () => {
    const unused = new Set(REPLACED_TERMS.map((row) => row.unused));
    for (const row of REPLACED_TERMS) {
      for (const word of row.use) expect(unused.has(word), `${row.unused} → ${word}`).toBe(false);
    }
  });

  it('keeps the six gambling words of D21 with no replacement', () => {
    const banned = REPLACED_TERMS.filter((row) => row.basis === 'D21');
    expect(banned.map((row) => row.unused)).toEqual([
      '베팅',
      '배당',
      '배당률',
      '승률',
      '판돈',
      '당첨',
    ]);
    for (const row of banned) {
      expect(row.use).toEqual([]);
      expect(row.match).toBe('text');
    }
  });
});
