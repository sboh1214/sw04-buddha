import { describe, expect, it } from 'vitest';
import { SPARKLINE_STROKE } from '@/components/market/market-sparkline';
import { CATEGORY_ITEM_OPACITY } from '@/lib/nav';
import { system } from './system';

/**
 * AC 6 (대비 AA), measured rather than eyeballed. A type-checker cannot see a colour and the
 * Playwright specs assert no ratio, so the pairs the M4 screens actually paint are computed here
 * from the values Chakra resolves at run time — the same numbers the comments in theme/system.ts
 * and market-sparkline.tsx quote. A palette edit that drops one of them below its threshold fails
 * the suite instead of waiting for a Lighthouse run.
 */

/** Every semantic colour token carries these two conditions; a mode is which one is painted. */
const MODES = ['_light', '_dark'] as const;
type Mode = (typeof MODES)[number];

/** The four palettes this app paints `variant="solid"` on, and so the four `contrast` pairs. */
const SOLID_PALETTES = ['brand', 'yes', 'no', 'orange'] as const;

/** `orange` is badge-only today; the other three are also buttons, which is what hovers. */
const BUTTON_PALETTES = ['brand', 'yes', 'no'] as const;

/** WCAG 1.4.3 for the label a solid fill carries: these are 14-16px buttons and 10-12px badges. */
const TEXT_MIN = 4.5;

/** WCAG 1.4.11 for a graphical object that is not text — the card's 24h trace. */
const GRAPHIC_MIN = 3;

/** `_hover` on the solid button recipe is `colorPalette.solid/90` over whatever is behind it. */
const HOVER_ALPHA = 0.9;

/** A `contrast` value is a CSS keyword rather than a scale reference, here and in Chakra's own. */
const KEYWORDS: Record<string, string | undefined> = { white: '#ffffff', black: '#000000' };

/**
 * The `#rrggbb` a semantic colour token paints in one mode. Three spellings reach here:
 * `{colors.teal.700}` is a reference into a scale, `white`/`black` are the keywords Chakra's own
 * `contrast` values use, and `#0a0c0f` is a literal — the page surfaces are Kalshi's measured
 * hex values (theme/system.ts) rather than a step of any scale. An alpha stroke (`rgba(...)`) is
 * deliberately NOT resolved: it has no single colour until it is painted over something, and
 * nothing this suite measures sits on one.
 */
function resolve(token: string, mode: Mode): string {
  const raw: unknown = system.tokens.getByName(`colors.${token}`)?.extensions.conditions?.[mode];
  if (typeof raw !== 'string') throw new Error(`colors.${token} has no ${mode} value`);
  const value: unknown = raw.startsWith('{')
    ? system.token(raw.slice(1, -1))
    : raw.startsWith('#')
      ? raw
      : KEYWORDS[raw];
  if (typeof value !== 'string') throw new Error(`colors.${token} ${mode} is unresolvable: ${raw}`);
  return value;
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`not an #rrggbb colour: ${hex}`);
  const channel = (at: number): number => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2.1 contrast ratio, 1..21. */
function ratio(a: string, b: string): number {
  const one = luminance(a);
  const two = luminance(b);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

/** `colour` at `alpha` over `behind`, which is what a `/90` fill is once the browser paints it. */
function over(colour: string, behind: string, alpha: number): string {
  const mix = (at: number): string => {
    const front = Number.parseInt(colour.slice(at, at + 2), 16);
    const back = Number.parseInt(behind.slice(at, at + 2), 16);
    return Math.round(front * alpha + back * (1 - alpha))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${mix(1)}${mix(3)}${mix(5)}`;
}

/** `palette _light: 3.74:1`, the one line a failure needs to be actionable. */
function shortfall(label: string, value: number, min: number): string[] {
  return value >= min ? [] : [`${label}: ${value.toFixed(2)}:1 < ${String(min)}:1`];
}

describe('palette contrast', () => {
  it('reads the label on a solid fill at 4.5:1 in both modes', () => {
    // The button and the badge recipe both resolve `bg: colorPalette.solid` with
    // `color: colorPalette.contrast`, so this pair — not the fill against the page — is what
    // carries 예/아니오, 매수/매도, 마감 임박 and the admin's 정산 단계 실패 badge (`no`).
    const failures = SOLID_PALETTES.flatMap((palette) =>
      MODES.flatMap((mode) =>
        shortfall(
          `${palette} solid ${mode}`,
          ratio(resolve(`${palette}.solid`, mode), resolve(`${palette}.contrast`, mode)),
          TEXT_MIN,
        ),
      ),
    );
    expect(failures).toEqual([]);
  });

  it('keeps that label readable while the button is hovered', () => {
    // `_hover` thins the fill to 90% over the page, which cost the 600 step its margin: white on
    // red.600 is 4.83:1 at rest and 4.30:1 hovered.
    const failures = BUTTON_PALETTES.flatMap((palette) =>
      MODES.flatMap((mode) =>
        shortfall(
          `${palette} solid/90 ${mode}`,
          ratio(
            over(resolve(`${palette}.solid`, mode), resolve('bg', mode), HOVER_ALPHA),
            resolve(`${palette}.contrast`, mode),
          ),
          TEXT_MIN,
        ),
      ),
    );
    expect(failures).toEqual([]);
  });

  it('separates a solid fill from the page it sits on at 3:1', () => {
    // 1.4.11 on the control itself for a button, and what keeps a badge from dissolving into the
    // card. It is why dark mode brightens `solid` to the 400 step instead of following light down
    // to the 700 step (teal.700 against the near-black page is 2.57:1).
    const failures = SOLID_PALETTES.flatMap((palette) =>
      MODES.flatMap((mode) =>
        shortfall(
          `${palette} solid on bg ${mode}`,
          ratio(resolve(`${palette}.solid`, mode), resolve('bg', mode)),
          GRAPHIC_MIN,
        ),
      ),
    );
    expect(failures).toEqual([]);
  });

  it('draws the card sparkline above the 3:1 non-text minimum', () => {
    // The trace is the only place a card shows the 24-hour trajectory, so it is content. The
    // tile sits on `surface.card`, a 2% alpha tint over `bg` (ADR-0041), and `bg`/`bg.subtle`
    // are the two opaque grounds that bracket it — both have to clear it.
    const failures = MODES.flatMap((mode) =>
      (['bg', 'bg.subtle'] as const).flatMap((background) =>
        shortfall(
          `${SPARKLINE_STROKE} on ${background} ${mode}`,
          ratio(resolve(SPARKLINE_STROKE, mode), resolve(background, mode)),
          GRAPHIC_MIN,
        ),
      ),
    );
    expect(failures).toEqual([]);
  });

  it('keeps the focus ring visible on every ground it is painted against (1.4.11)', () => {
    // Every pill, nav item, sidebar row and chip ADR-0041 added shows `brand.focusRing` on
    // keyboard focus, on the page and on the card; the search field paints an `inside` ring
    // flush with `surface.input`. Alpha grounds are composited over the page by hand, since
    // `resolve` deliberately refuses an rgba token.
    const grounds: Record<Mode, { name: string; hex: string }[]> = {
      _light: [
        { name: 'bg', hex: resolve('bg', '_light') },
        { name: 'bg.subtle', hex: resolve('bg.subtle', '_light') },
        // surface.card light: rgba(128,128,128,0.02); surface.input light: rgba(0,0,0,0.07).
        { name: 'surface.card', hex: over('#808080', resolve('bg', '_light'), 0.02) },
        { name: 'surface.input', hex: over('#000000', resolve('bg', '_light'), 0.07) },
      ],
      _dark: [
        { name: 'bg', hex: resolve('bg', '_dark') },
        { name: 'bg.subtle', hex: resolve('bg.subtle', '_dark') },
        // surface.card dark: rgba(255,255,255,0.02); surface.input dark: rgba(255,255,255,0.12).
        { name: 'surface.card', hex: over('#ffffff', resolve('bg', '_dark'), 0.02) },
        { name: 'surface.input', hex: over('#ffffff', resolve('bg', '_dark'), 0.12) },
      ],
    };
    const failures = MODES.flatMap((mode) =>
      grounds[mode].flatMap((ground) =>
        shortfall(
          `brand.focusRing on ${ground.name} ${mode}`,
          ratio(resolve('brand.focusRing', mode), ground.hex),
          GRAPHIC_MIN,
        ),
      ),
    );
    expect(failures).toEqual([]);
  });

  it('reads the dimmed category items of the header at 4.5:1 (1.4.3)', () => {
    // nav.tsx rests row 2's inactive items at `CATEGORY_ITEM_OPACITY` over the page, which is
    // Kalshi's treatment; the opacity is the smallest step that keeps 15px text AA in both modes.
    const failures = MODES.flatMap((mode) =>
      shortfall(
        `fg at ${String(CATEGORY_ITEM_OPACITY)} on bg ${mode}`,
        ratio(
          over(resolve('fg', mode), resolve('bg', mode), CATEGORY_ITEM_OPACITY),
          resolve('bg', mode),
        ),
        TEXT_MIN,
      ),
    );
    expect(failures).toEqual([]);
  });
});
