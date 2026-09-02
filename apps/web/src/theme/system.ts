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
          solid: { value: { _light: '{colors.brand.600}', _dark: '{colors.brand.500}' } },
          contrast: { value: { _light: 'white', _dark: 'white' } },
          fg: { value: { _light: '{colors.brand.700}', _dark: '{colors.brand.300}' } },
          muted: { value: { _light: '{colors.brand.100}', _dark: '{colors.brand.900}' } },
          subtle: { value: { _light: '{colors.brand.50}', _dark: '{colors.brand.950}' } },
          emphasized: { value: { _light: '{colors.brand.200}', _dark: '{colors.brand.800}' } },
          focusRing: { value: { _light: '{colors.brand.500}', _dark: '{colors.brand.400}' } },
        },
        yes: {
          solid: { value: { _light: '{colors.teal.600}', _dark: '{colors.teal.500}' } },
          contrast: { value: { _light: 'white', _dark: 'white' } },
          fg: { value: { _light: '{colors.teal.700}', _dark: '{colors.teal.300}' } },
          muted: { value: { _light: '{colors.teal.100}', _dark: '{colors.teal.900}' } },
          subtle: { value: { _light: '{colors.teal.50}', _dark: '{colors.teal.950}' } },
          emphasized: { value: { _light: '{colors.teal.200}', _dark: '{colors.teal.800}' } },
          focusRing: { value: { _light: '{colors.teal.500}', _dark: '{colors.teal.400}' } },
        },
        no: {
          solid: { value: { _light: '{colors.red.600}', _dark: '{colors.red.500}' } },
          contrast: { value: { _light: 'white', _dark: 'white' } },
          fg: { value: { _light: '{colors.red.700}', _dark: '{colors.red.300}' } },
          muted: { value: { _light: '{colors.red.100}', _dark: '{colors.red.900}' } },
          subtle: { value: { _light: '{colors.red.50}', _dark: '{colors.red.950}' } },
          emphasized: { value: { _light: '{colors.red.200}', _dark: '{colors.red.800}' } },
          focusRing: { value: { _light: '{colors.red.500}', _dark: '{colors.red.400}' } },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
