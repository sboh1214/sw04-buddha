import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PRICE_MAX, PRICE_MIN } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { SRC, copyRefsOf, literalsOf, localImportsOf } from '../test/screen-text';
import { formatNoPrice, formatYesPrice } from './market-admin';
import { type OutcomeReading, noPrice, outcomeRows, participantsText } from './market-card';

/** The two readings of a market that HAS a fill; a missing one here is a failure, not a value. */
function readings(lastPrice: number): [OutcomeReading, OutcomeReading] {
  const [yes, no] = outcomeRows(lastPrice);
  if (yes.reading === null || no.reading === null)
    throw new Error(`no reading at ${String(lastPrice)}`);
  return [yes.reading, no.reading];
}

describe('noPrice', () => {
  it('is the complement of lastPrice', () => {
    expect(noPrice(63)).toBe(37);
    expect(noPrice(50)).toBe(50);
    expect(noPrice(PRICE_MIN)).toBe(PRICE_MAX);
    expect(noPrice(PRICE_MAX)).toBe(PRICE_MIN);
  });
});

describe('outcomeRows', () => {
  it('orders YES before NO and colours them first/second', () => {
    const [yes, no] = outcomeRows(63);
    expect(yes.key).toBe('yes');
    expect(no.key).toBe('no');
    expect(yes.label).toBe(copy.yes);
    expect(no.label).toBe(copy.no);
    expect(yes.accent).toBe('row.first');
    expect(no.accent).toBe('row.second');
  });

  it('shows lastPrice on the YES row and its complement on the NO row, and nothing else', () => {
    const [yes, no] = readings(63);
    expect(yes.percent).toBe(63);
    expect(no.percent).toBe(37);
    // A reading is the percent and the words that name it: no other figure is derived from the
    // price for the card to print (O-21 in ADR-0047, ADR-0062).
    expect(Object.keys(yes).sort()).toEqual(['accessibleName', 'percent']);
    expect(Object.keys(no).sort()).toEqual(['accessibleName', 'percent']);
  });

  it('names each row by the words the badge used to show', () => {
    // "YES 63%" / "NO 37%": the reading in words, never the colour alone (PLAN 11.2).
    const [yes, no] = readings(63);
    expect(yes.accessibleName).toBe(formatYesPrice(63));
    expect(no.accessibleName).toBe(formatNoPrice(63));
    expect(yes.accessibleName).toBe(`${copy.yes} 63%`);
    expect(no.accessibleName).toBe(`${copy.no} 37%`);
  });

  it('sums the two percents to 100 across the whole range', () => {
    for (let price = PRICE_MIN; price <= PRICE_MAX; price += 1) {
      const [yes, no] = readings(price);
      expect(yes.percent + no.percent).toBe(100);
      // Both sides stay inside the range the API allows.
      expect(yes.percent).toBeGreaterThanOrEqual(PRICE_MIN);
      expect(no.percent).toBeGreaterThanOrEqual(PRICE_MIN);
      expect(yes.percent).toBeLessThanOrEqual(PRICE_MAX);
      expect(no.percent).toBeLessThanOrEqual(PRICE_MAX);
    }
  });

  it('handles the two ends: a 1% market and a 99% market', () => {
    const [yesLow, noLow] = readings(PRICE_MIN);
    expect(yesLow.percent).toBe(1);
    expect(noLow.percent).toBe(99);
    expect(yesLow.accessibleName).toBe(`${copy.yes} 1%`);
    expect(noLow.accessibleName).toBe(`${copy.no} 99%`);

    const [yesHigh, noHigh] = readings(PRICE_MAX);
    expect(yesHigh.percent).toBe(99);
    expect(noHigh.percent).toBe(1);
    expect(yesHigh.accessibleName).toBe(`${copy.yes} 99%`);
    expect(noHigh.accessibleName).toBe(`${copy.no} 1%`);
  });

  it('keeps both rows before the first fill, with no reading at all (N02 §5)', () => {
    // Owner decision #125 (ADR-0048): the YES and NO rows stay, labelled and coloured as ever,
    // and nothing stands in for the price — no percent and no 50% opening setting.
    const [yes, no] = outcomeRows(null);
    expect([yes.key, no.key]).toEqual(['yes', 'no']);
    expect([yes.label, no.label]).toEqual([copy.yes, copy.no]);
    expect([yes.accent, no.accent]).toEqual(['row.first', 'row.second']);
    expect(yes.reading).toBeNull();
    expect(no.reading).toBeNull();
  });
});

describe('participantsText', () => {
  it('writes the participants, not the fills: traderCount and never tradeCount', () => {
    // Two different numbers on one row. On every e2e market both are 0 (nothing writes them
    // before the order path, #119), so this is the one place the field the card reads is pinned.
    const row = { traderCount: 3, tradeCount: 11 };
    expect(participantsText(row)).toBe(`${copy.marketTraders} 3`);
  });

  it('writes a 0 as 0, not hidden (ADR-0061 decision 1, item 4)', () => {
    expect(participantsText({ traderCount: 0 })).toBe(`${copy.marketTraders} 0`);
  });

  it("is the detail header's spelling: the count as String writes it, ungrouped", () => {
    expect(participantsText({ traderCount: 12345 })).toBe(`${copy.marketTraders} 12345`);
  });
});

/** The tile: what the home grid renders, and the admin 미리보기 with `interactive={false}`. */
const CARD = path.join(SRC, 'components', 'market', 'market-card.tsx');

/**
 * The copy table is not walked as a source: its values reach the card only through the keys a
 * card source reads, so it is checked by those keys (`copyRefsOf`). Its other values are other
 * screens' text, which O-21 does not reach — the multiple is off the card, not off the app.
 */
const COPY = path.join(SRC, 'copy.ts');

/**
 * Every source the card can print from: `entry` and what it imports, followed transitively
 * (`localImportsOf`), past the copy table. For the real tile that is `lib/market-card.ts`, the
 * price formatters of `lib/market-admin.ts`, the countdown and what they import in turn — a
 * helper beside the price formatters is where a multiple would come back as readily as the tile.
 */
function cardSources(entry: string): string[] {
  const found = [entry];
  // for…of reads the array's length at every step, so it visits what the walk pushes.
  for (const file of found) {
    for (const imported of localImportsOf(file, readFileSync(file, 'utf8'))) {
      if (imported !== COPY && !found.includes(imported)) found.push(imported);
    }
  }
  return found;
}

/** The screen-reader sentence the multiple was read out with ('정답 시 투입 대비 1.59x'). */
const MULTIPLE_SENTENCE = '투입 대비';

/**
 * A payout multiple as screen text (test/screen-text.ts reads an interpolation as the digit 0): a
 * figure followed by an x — '1.59x', `${…}x` in a template, `{…}x` in JSX — or an x standing
 * alone, for a figure that `+` puts it after; the same figure followed by 배 ('1.59배', `${…}
 * 배`); or the sentence it was read out with. Not a hex literal such as '0x1f'.
 */
function readsAsMultiple(text: string): boolean {
  return (
    /\d\s?[x×](?![0-9A-Za-z])/.test(text) ||
    /^\s*[x×]\s*$/.test(text) ||
    /\d\s?배/.test(text) ||
    text.includes(MULTIPLE_SENTENCE)
  );
}

/**
 * Where `files` print a multiple: their literals, and the copy values they read by key. A key the
 * table no longer has reads as nothing.
 */
function multiplesIn(files: readonly string[]): string[] {
  const values: Record<string, string | undefined> = copy;
  return files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const where = (line: number) => `${path.relative(SRC, file)}:${String(line)}`;
    return [
      ...literalsOf(file, source)
        .filter((literal) => readsAsMultiple(literal.text))
        .map((literal) => `${where(literal.line)} ${JSON.stringify(literal.text)}`),
      ...copyRefsOf(file, source)
        .filter((ref) => readsAsMultiple(values[ref.key] ?? ''))
        .map((ref) => `${where(ref.line)} copy.${ref.key}`),
    ];
  });
}

describe("the card's screen text (O-21 in ADR-0047, ADR-0062)", () => {
  it('recognises a multiple in every form the card could print one', () => {
    // The removed `payoutMultiple`, a figure written inline in the row's JSX, one glued on with
    // `+`, one written out, the same figure in Korean, and the screen-reader sentence written
    // into the JSX rather than read from the copy table.
    const old = [
      'export const payoutMultiple = (price: number) => `${(100 / price).toFixed(2)}x`;',
      'const cell = <Text>{(100 / reading.percent).toFixed(2)}x</Text>;',
      "const glued = (100 / reading.percent).toFixed(2) + 'x';",
      "const literal = '1.59x';",
      'const korean = <Text>{(100 / reading.percent).toFixed(1)}배</Text>;',
      "const spaced = '1.6 배';",
      'const sentence = <VisuallyHidden>정답 시 투입 대비</VisuallyHidden>;',
    ].join('\n');
    const found = literalsOf('old.tsx', old).filter((literal) => readsAsMultiple(literal.text));
    expect(found.map((literal) => literal.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // What the card does print stays clear of it — sizes, a percent, its footer — and so do a
    // hex number and a 배 that follows no figure.
    for (const text of ['28px', '1fr auto auto', '0%', '0x1f', '참여자 0', '—', '배경']) {
      expect(readsAsMultiple(text), text).toBe(false);
    }
  });

  it('follows what the card imports, transitively, past the copy table', () => {
    // A formatter two imports away from the tile: the tile reads the call as '0', so the tile
    // alone looks clear, and a scan of a fixed list of files would never reach the formatter.
    const dir = mkdtempSync(path.join(tmpdir(), 'card-sources-'));
    try {
      const tile = path.join(dir, 'card.tsx');
      const helper = path.join(dir, 'payout.ts');
      const formatter = path.join(dir, 'format.ts');
      writeFileSync(
        tile,
        [
          "import { copy } from '@/copy';",
          "import { payoutText } from './payout';",
          'export const Cell = ({ p }: { p: number }) => <Text>{payoutText(p)}</Text>;',
        ].join('\n'),
      );
      writeFileSync(
        helper,
        "import { multiple } from './format';\nexport const payoutText = (p: number) => multiple(p);",
      );
      writeFileSync(
        formatter,
        'export const multiple = (p: number) => `${(100 / p).toFixed(2)}x`;',
      );
      const sources = cardSources(tile);
      expect(sources).toEqual([tile, helper, formatter]);
      expect(multiplesIn([tile])).toEqual([]);
      expect(multiplesIn(sources)).toEqual([`${path.relative(SRC, formatter)}:1 "0x"`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints no payout multiple and not the sentence it was read out with', () => {
    // An e2e card has no fill (no order path before #119), and a card with no fill never showed
    // a multiple (ADR-0048), so the e2e cannot tell the removal from the old card; this can.
    const sources = cardSources(CARD);
    expect(sources).toEqual(
      expect.arrayContaining([
        path.join(SRC, 'lib', 'market-card.ts'),
        path.join(SRC, 'lib', 'market-admin.ts'),
        path.join(SRC, 'components', 'market', 'countdown-badge.tsx'),
      ]),
    );
    expect(sources).not.toContain(COPY);
    expect(multiplesIn(sources)).toEqual([]);
  });
});
