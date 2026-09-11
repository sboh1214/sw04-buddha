import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

// Pretendard Variable is loaded via the CSS import in app/layout.tsx.
const fontStack = [
  'Pretendard Variable',
  'Pretendard',
  '-apple-system',
  'BlinkMacSystemFont',
  'system-ui',
  'Roboto',
  'Helvetica Neue',
  'Segoe UI',
  'Apple SD Gothic Neo',
  'Noto Sans KR',
  'Malgun Gothic',
  'sans-serif',
];

// PLAN 11.2: brand = a green scale built around Kalshi's #28cc95 (the placeholder indigo of Q7
// went with the Kalshi restyle, ADR-0041); yes = teal, no = red (Chakra's built-in scales).
// Labels always accompany colour so meaning never relies on colour alone.
//
// Each palette defines the same eight semantic keys a built-in palette defines. `border` is the
// one that is easy to miss and silently wrong when missed: the outline recipes read
// `colorPalette.border` through `var(--outline-color, var(--outline-color-legacy))`, and an
// undefined token makes the var invalid, so `variant="outline"` falls back to `colorPalette.muted`
// — a 100-level tint that is barely visible on white (AC 6, 대비 AA).
//
// The values are the 600/400 pair rather than the built-ins' 500/400. A border is a UI component
// boundary, so WCAG 1.4.11 asks for 3:1, and teal.500 on white is only 2.49:1; 600/400 clears it
// on every palette in both modes (light teal 3.74, red 4.83, brand 3.24; dark 11.3/7.6/9.48).
//
// `solid` is measured against `contrast`, never against the page: the button and the badge recipe
// both resolve `bg: colorPalette.solid` with `color: colorPalette.contrast`, so that pair carries
// label text (`size="lg"` is 16px, `size="sm"` 14px) and owes WCAG 1.4.3 its 4.5:1 — in the
// resting state AND under `_hover`, which the button recipe paints as `colorPalette.solid/90`
// composited over the page. A white label does not pay it on the 600 step (teal.600 3.74:1,
// red.600 4.83:1 dropping to 4.30:1 on hover), and the 500 step this file once used in dark
// mode was worse still (teal 2.49, red 3.76, and 4.47 for the indigo of the time).
//
// So light drops all three to the 700 step and keeps the white label — teal 7.73/6.07 rest/hover,
// red 8.37/6.95, brand green 5.80/4.74 (#067450, Kalshi's own light green-x50). Kalshi's light
// accent #0ac285 itself is 2.32:1 on white and cannot be a solid fill here; it survives as the
// card's first row bar below. One step for the three keeps the rule sayable and the family
// even, and 700 is `fg`'s step too. Dark cannot follow: teal.700 against the near-black page is
// 2.57:1, so the button stops reading as a control at all (1.4.11 again). Dark brightens `solid`
// to the 400 step and darkens the label instead — teal 11.28/9.24, red 7.59/6.31, brand
// 10.16/8.37 on `#0a0c0f` — which is the shape Chakra's own orange palette already uses, and for
// brand it is literally Kalshi's Sign-up button (#28cc95 under a black label). The fill never
// has to carry the meaning either way: 예/아니오/매수 are written inside these buttons (PLAN 11.2).
//
// The rest of the page follows Kalshi's surfaces (ADR-0041, measured off kalshi.com): the dark
// page is #0a0c0f rather than pure black, borders are alpha strokes rather than gray steps so
// they read the same on every surface, and a card is a 2% tint with a 6-8% stroke. The literal
// rgba values below are Kalshi's `--stroke-x*` / `--container-x*` / `--fill-x*` variables; the
// names keep their ladder (subtle < muted < emphasized < solid) rather than the x-numbers.
const config = defineConfig({
  globalCss: {
    html: { colorPalette: 'brand' },
    body: { fontVariantNumeric: 'tabular-nums' },
  },
  theme: {
    // Kalshi's type ladder (`typ-*` classes, measured): the card title, the overline above it,
    // the three body sizes and their medium-weight "emphasis" twins, and the page headline.
    // One `textStyle` per rung so a card, a nav item and a sidebar row cannot drift apart by a
    // pixel each. Sizes are px rather than Chakra's rem tokens because the ladder is not on
    // Chakra's 12/14/16 grid (13 and 15 are its two most-used steps).
    textStyles: {
      overline: {
        value: {
          fontSize: '11px',
          lineHeight: '18px',
          fontWeight: '600',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        },
      },
      overlineLg: {
        value: {
          fontSize: '13px',
          lineHeight: '20px',
          fontWeight: '600',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        },
      },
      bodyXs: { value: { fontSize: '12px', lineHeight: '18px', fontWeight: '400' } },
      bodySm: { value: { fontSize: '13px', lineHeight: '20px', fontWeight: '400' } },
      bodyMd: { value: { fontSize: '15px', lineHeight: '22px', fontWeight: '400' } },
      emphasisXs: { value: { fontSize: '12px', lineHeight: '18px', fontWeight: '500' } },
      emphasisSm: { value: { fontSize: '13px', lineHeight: '20px', fontWeight: '500' } },
      emphasisMd: { value: { fontSize: '15px', lineHeight: '22px', fontWeight: '500' } },
      title: { value: { fontSize: '15px', lineHeight: '22px', fontWeight: '600' } },
      titleLg: { value: { fontSize: '18px', lineHeight: '24px', fontWeight: '600' } },
      headline: {
        value: {
          fontSize: '30px',
          lineHeight: '36px',
          fontWeight: '600',
          letterSpacing: '-0.02em',
        },
      },
    },
    tokens: {
      // Kalshi `rounded-x20 / x30 / x40 / x50`: the icon tile, a sidebar row, a card, a pill.
      radii: {
        icon: { value: '6px' },
        row: { value: '8px' },
        card: { value: '16px' },
        pill: { value: '100px' },
      },
      fonts: {
        heading: { value: fontStack },
        body: { value: fontStack },
      },
      colors: {
        // Kalshi's green family: 400 = dark-mode `--green-x10` / `--brand-primary` (#28cc95),
        // 500 = light-mode `--green-x10` (#0ac285), 600/700 = its light `--green-x40`/`x50`,
        // 300/200 = its dark `x40`/`x50`; the tints either side are interpolated.
        brand: {
          50: { value: '#e8faf3' },
          100: { value: '#c9f4e4' },
          200: { value: '#7ee0bf' },
          300: { value: '#5cd8ae' },
          400: { value: '#28cc95' },
          500: { value: '#0ac285' },
          600: { value: '#08a370' },
          700: { value: '#067450' },
          800: { value: '#05553b' },
          900: { value: '#043d2b' },
          950: { value: '#02261b' },
        },
      },
    },
    semanticTokens: {
      colors: {
        brand: {
          solid: { value: { _light: '{colors.brand.700}', _dark: '{colors.brand.400}' } },
          contrast: { value: { _light: 'white', _dark: 'black' } },
          fg: { value: { _light: '{colors.brand.700}', _dark: '{colors.brand.300}' } },
          muted: { value: { _light: '{colors.brand.100}', _dark: '{colors.brand.900}' } },
          subtle: { value: { _light: '{colors.brand.50}', _dark: '{colors.brand.950}' } },
          emphasized: { value: { _light: '{colors.brand.200}', _dark: '{colors.brand.800}' } },
          // The ring is a component boundary too (1.4.11, 3:1) and it is painted on MORE
          // grounds than a border: the page, a card, `bg.subtle`, and — for the search field's
          // `inside` ring — `surface.input`. Light 500 is 2.32:1 on white and 600 only 2.77:1 on
          // `surface.input`, so light takes the 700 step `solid` and `fg` already use (5.80 on
          // white, 4.95 on the search ground); dark keeps 400 (9.48:1 on the page). Measured in
          // contrast.test.ts.
          focusRing: { value: { _light: '{colors.brand.700}', _dark: '{colors.brand.400}' } },
          // 600 on white is 3.24:1 (1.4.11); 500 would be 2.32:1.
          border: { value: { _light: '{colors.brand.600}', _dark: '{colors.brand.400}' } },
        },
        // The page and its layers (Kalshi `--surface-x10/x20/x30`). Chakra's defaults are
        // merged, not replaced, so `bg.emphasized`, `bg.inverted`, the status tints and the
        // whole light side except `subtle` stay built-in. Light `bg.subtle` is Kalshi's
        // `--surface-foreground-opaque`; it is a page LAYER (panels, skeletons, Chakra's own
        // recipes read it), not a hover fill — the tile sits on `surface.card` and only its
        // stroke changes under the pointer.
        bg: {
          DEFAULT: { value: { _light: '#ffffff', _dark: '#0a0c0f' } },
          subtle: { value: { _light: '#f7f7f7', _dark: '#13161a' } },
          muted: { value: { _light: '{colors.gray.100}', _dark: '#1b2029' } },
          panel: { value: { _light: '#ffffff', _dark: '#13161a' } },
        },
        // Alpha strokes (Kalshi `--stroke-x40 / x30 / x20`): a card's resting border, a divider,
        // and the border a card gets under the pointer. `border.*` is what Chakra's own recipes
        // read (`borderWidth="1px"` with no colour resolves to `border.DEFAULT`), so the header
        // rule and every existing `borderWidth` in the app pick these up without an edit.
        border: {
          DEFAULT: { value: { _light: 'rgba(0, 0, 0, 0.10)', _dark: 'rgba(255, 255, 255, 0.14)' } },
          subtle: { value: { _light: 'rgba(0, 0, 0, 0.06)', _dark: 'rgba(255, 255, 255, 0.08)' } },
          muted: { value: { _light: 'rgba(0, 0, 0, 0.10)', _dark: 'rgba(255, 255, 255, 0.14)' } },
          emphasized: {
            value: { _light: 'rgba(0, 0, 0, 0.20)', _dark: 'rgba(255, 255, 255, 0.25)' },
          },
        },
        // Fills that are not a page layer (Kalshi `--container-x40`, `--fill-x60`, `--fill-x50`):
        // a card's 2% tint, the 3% wash a nav item takes on hover, the search field's ground.
        // Alpha rather than a step so they look the same on the page and on a panel.
        surface: {
          card: {
            value: { _light: 'rgba(128, 128, 128, 0.02)', _dark: 'rgba(255, 255, 255, 0.02)' },
          },
          hover: { value: { _light: 'rgba(0, 0, 0, 0.03)', _dark: 'rgba(255, 255, 255, 0.05)' } },
          input: { value: { _light: 'rgba(0, 0, 0, 0.07)', _dark: 'rgba(255, 255, 255, 0.12)' } },
        },
        // The card's two outcome rows (Kalshi `--green-x10` and `--blue-x10`, with the green's
        // `x20` 12% tint for a hovered pill). Row accents, not the yes/no palettes: the pair is
        // what Kalshi draws on every tile, and the rows are labelled 예/아니오 in words (PLAN
        // 11.2), so the colour carries no meaning the label does not. Neither bar is measured
        // for 1.4.11 (light `first` is 2.32:1 on white): the bar's length repeats the number in
        // the pill beside it, so it is redundant with text, which is the one case 1.4.11 exempts.
        // The pill's OUTLINE is a component boundary and is not this colour — it is
        // `brand.border` (light 600 = 3.24:1, dark 400 = this same #28cc95).
        row: {
          first: { value: { _light: '#0ac285', _dark: '#28cc95' } },
          firstTint: {
            value: { _light: 'rgba(10, 194, 133, 0.12)', _dark: 'rgba(40, 204, 149, 0.12)' },
          },
          second: { value: { _light: '#265cff', _dark: '#408fff' } },
        },
        yes: {
          solid: { value: { _light: '{colors.teal.700}', _dark: '{colors.teal.400}' } },
          contrast: { value: { _light: 'white', _dark: 'black' } },
          fg: { value: { _light: '{colors.teal.700}', _dark: '{colors.teal.300}' } },
          muted: { value: { _light: '{colors.teal.100}', _dark: '{colors.teal.900}' } },
          subtle: { value: { _light: '{colors.teal.50}', _dark: '{colors.teal.950}' } },
          emphasized: { value: { _light: '{colors.teal.200}', _dark: '{colors.teal.800}' } },
          focusRing: { value: { _light: '{colors.teal.500}', _dark: '{colors.teal.400}' } },
          border: { value: { _light: '{colors.teal.600}', _dark: '{colors.teal.400}' } },
        },
        no: {
          solid: { value: { _light: '{colors.red.700}', _dark: '{colors.red.400}' } },
          contrast: { value: { _light: 'white', _dark: 'black' } },
          fg: { value: { _light: '{colors.red.700}', _dark: '{colors.red.300}' } },
          muted: { value: { _light: '{colors.red.100}', _dark: '{colors.red.900}' } },
          subtle: { value: { _light: '{colors.red.50}', _dark: '{colors.red.950}' } },
          emphasized: { value: { _light: '{colors.red.200}', _dark: '{colors.red.800}' } },
          focusRing: { value: { _light: '{colors.red.500}', _dark: '{colors.red.400}' } },
          border: { value: { _light: '{colors.red.600}', _dark: '{colors.red.400}' } },
        },
        // The one BUILT-IN palette this app paints `variant="solid"` on: the 마감 임박 countdown
        // badge (12px in the detail header; the card draws the same words as `orange.fg` text
        // since ADR-0041) and the admin 마감 지남 badge. Chakra
        // pairs white with orange.600 there — 3.56:1, the same 1.4.3 miss as the three palettes
        // above — so light moves to the 700 step (7.88:1). Dark already pairs a black label with
        // orange.500 (7.49:1) and is restated unchanged; the config is merged rather than
        // replaced, so `fg`/`subtle`/`muted`/`emphasized`/`focusRing`/`border` stay built-in.
        orange: {
          solid: { value: { _light: '{colors.orange.700}', _dark: '{colors.orange.500}' } },
          contrast: { value: { _light: 'white', _dark: 'black' } },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
