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

// PLAN 11.2: brand = placeholder indigo (open question Q7); yes = teal, no = red (Chakra's
// built-in scales). Labels always accompany colour so meaning never relies on colour alone.
//
// Each palette defines the same eight semantic keys a built-in palette defines. `border` is the
// one that is easy to miss and silently wrong when missed: the outline recipes read
// `colorPalette.border` through `var(--outline-color, var(--outline-color-legacy))`, and an
// undefined token makes the var invalid, so `variant="outline"` falls back to `colorPalette.muted`
// — a 100-level tint that is barely visible on white (AC 6, 대비 AA).
//
// The values are the 600/400 pair rather than the built-ins' 500/400. A border is a UI component
// boundary, so WCAG 1.4.11 asks for 3:1, and teal.500 on white is only 2.49:1; 600/400 clears it
// on every palette in both modes (light teal 3.74, red 4.83, indigo 6.29; dark 11.3/7.6/7.0).
//
// `solid` is measured against `contrast`, never against the page: the button and the badge recipe
// both resolve `bg: colorPalette.solid` with `color: colorPalette.contrast`, so that pair carries
// label text (`size="lg"` is 16px, `size="sm"` 14px) and owes WCAG 1.4.3 its 4.5:1 — in the
// resting state AND under `_hover`, which the button recipe paints as `colorPalette.solid/90`
// composited over the page. A white label does not pay it on the 600 step (teal.600 3.74:1,
// red.600 4.83:1 dropping to 4.30:1 on hover), and the 500 step this file used in dark mode is
// worse still (teal 2.49, red 3.76, indigo 4.47).
//
// So light drops all three to the 700 step and keeps the white label — teal 7.73/6.07 rest/hover,
// red 8.37/6.95, indigo 7.90/6.31. Indigo alone would have survived at 600 (6.29/5.12); one step
// for the three keeps the rule sayable and the family even, and 700 is `fg`'s step too. Dark
// cannot follow: teal.700 against the near-black page is 2.57:1, so the button stops reading as a
// control at all (1.4.11 again). Dark brightens `solid` to the 400 step and darkens the label
// instead — teal 11.28/9.24, red 7.59/6.31, indigo 7.04/5.87 on `black` — which is the shape
// Chakra's own orange palette already uses. The fill never has to carry the meaning either way:
// 예/아니오/매수 are written inside these buttons (PLAN 11.2).
const config = defineConfig({
  globalCss: {
    html: { colorPalette: 'brand' },
    body: { fontVariantNumeric: 'tabular-nums' },
  },
  theme: {
    tokens: {
      fonts: {
        heading: { value: fontStack },
        body: { value: fontStack },
      },
      colors: {
        brand: {
          50: { value: '#eef2ff' },
          100: { value: '#e0e7ff' },
          200: { value: '#c7d2fe' },
          300: { value: '#a5b4fc' },
          400: { value: '#818cf8' },
          500: { value: '#6366f1' },
          600: { value: '#4f46e5' },
          700: { value: '#4338ca' },
          800: { value: '#3730a3' },
          900: { value: '#312e81' },
          950: { value: '#1e1b4b' },
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
          focusRing: { value: { _light: '{colors.brand.500}', _dark: '{colors.brand.400}' } },
          border: { value: { _light: '{colors.brand.600}', _dark: '{colors.brand.400}' } },
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
        // badge (10px on a card, 12px in the detail header) and the admin 마감 지남 badge. Chakra
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
