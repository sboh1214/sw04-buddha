import { MINUS_SIGN, formatP } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { ROLL_DIGITS, type RollCell, rollCells } from './roll';

/** The cell React would reuse across two renders: the one `fromRight` places from the end. */
const fromRight = (cells: readonly RollCell[], index: number): RollCell | undefined =>
  cells.find((cell) => cell.key === `r${String(index)}`);

describe('rollCells', () => {
  it('translates each digit to its own tenth of the column', () => {
    expect(rollCells('63')).toEqual([
      { key: 'r1', char: '6', offsetPct: 60 },
      { key: 'r0', char: '3', offsetPct: 30 },
    ]);
  });

  it('covers all ten digits, in order', () => {
    expect(rollCells(ROLL_DIGITS.join('')).map((cell) => cell.offsetPct)).toEqual([
      0, 10, 20, 30, 40, 50, 60, 70, 80, 90,
    ]);
  });

  it('has nothing to render for an empty string', () => {
    expect(rollCells('')).toEqual([]);
  });

  it('passes every non-digit through untouched', () => {
    // The composed labels formatP and formatYesPrice produce must survive intact: the 예 word,
    // the space, the thousands comma, the percent sign and the U+2212 minus are not digits and
    // never roll, but they still have to be rendered.
    const text = formatP(-1200n);
    expect(text).toBe(`${MINUS_SIGN}1,200P`);
    const cells = rollCells(text);
    expect(cells.map((cell) => cell.char).join('')).toBe(text);
    expect(cells.filter((cell) => cell.offsetPct === null).map((cell) => cell.char)).toEqual([
      MINUS_SIGN,
      ',',
      'P',
    ]);
    expect(rollCells('예 63%').filter((cell) => cell.offsetPct === null).length).toBe(3);
  });

  it('keys from the right, so a longer value animates the same glyphs', () => {
    // The regression key={i} causes: '예 9%' -> '예 63%' is an ordinary one-point move, and
    // keying from the left would hand the cell that held the '9' to the '6' and the cell that
    // held the '%' to the '3', rolling two columns that did not change.
    const one = rollCells('예 9%');
    const two = rollCells('예 63%');
    expect(fromRight(one, 0)?.char).toBe('%');
    expect(fromRight(two, 0)?.char).toBe('%');
    expect(fromRight(one, 1)?.char).toBe('9');
    expect(fromRight(two, 1)?.char).toBe('3');
    // The new tens digit simply mounts at a key nothing held before, which correctly does not
    // animate; every key inside one render is distinct, so React never collapses two cells.
    expect(fromRight(one, 3)?.char).toBe('예');
    expect(fromRight(two, 4)?.char).toBe('예');
    expect(new Set(two.map((cell) => cell.key)).size).toBe(two.length);
  });

  it('keeps the P suffix and the units digit in place when a thousand rolls over', () => {
    const before = rollCells('9,900P');
    const after = rollCells('10,000P');
    expect(fromRight(before, 0)?.char).toBe('P');
    expect(fromRight(after, 0)?.char).toBe('P');
    expect(fromRight(before, 1)?.offsetPct).toBe(0);
    expect(fromRight(after, 1)?.offsetPct).toBe(0);
    expect(fromRight(before, 4)?.char).toBe(',');
    expect(fromRight(after, 4)?.char).toBe(',');
  });
});
