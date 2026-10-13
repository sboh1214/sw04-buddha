import { Box } from '@chakra-ui/react';
import { COIN_UNIT } from '@buddha/shared';
import type { ChargeTier } from '@/lib/charge-guide';

/**
 * The picture on a `/charge` package card (owner decision §8: PG screening asks for "바로 판매
 * 가능한 상품과 이미지"). Drawn here in SVG rather than shipped as a file: no image host to add to
 * the CSP, nothing to load, and it follows the colour mode — the tile is `brand.subtle` and every
 * stroke and fill is `currentColor` (`brand.fg`) at some opacity, so the one drawing is correct in
 * both themes without a second asset (the repo draws its own icons, category-icon.tsx).
 *
 * Four tiers, bigger package → bigger pile (`chargeTiers`, lib/charge-guide.ts): one coin; a coin
 * and a short stack; a coin and two stacks; a coin, three stacks and a glint.
 *
 * Every shape is translucent, so nothing may overlap or the overlap would show through darker. A
 * stack is therefore drawn as bands that tile exactly — each coin's side runs from the lower arc
 * of its top face to the lower arc of the face below, which is the next band's upper edge — plus
 * ONE full face on top; the upright coin and the stacks sit side by side.
 *
 * Decorative: `aria-hidden`, because the Coin amount and the price beside it carry the meaning.
 */

const VIEW_W = 160;
const VIEW_H = 100;
/** The y every stack stands on. */
const GROUND = 86;
/** Coin thickness and the vertical radius of a coin face seen at this angle. */
const THICKNESS = 5;
const FACE_RY = 5.5;

interface Stack {
  cx: number;
  count: number;
}

interface Scene {
  coin: { cx: number; cy: number; r: number };
  stackRx: number;
  stacks: Stack[];
  glints: { x: number; y: number; size: number }[];
}

const SCENES: Record<ChargeTier, Scene> = {
  0: { coin: { cx: 80, cy: 60, r: 24 }, stackRx: 16, stacks: [], glints: [] },
  1: { coin: { cx: 62, cy: 64, r: 20 }, stackRx: 16, stacks: [{ cx: 102, count: 3 }], glints: [] },
  2: {
    coin: { cx: 50, cy: 64, r: 20 },
    stackRx: 16,
    stacks: [
      { cx: 94, count: 4 },
      { cx: 128, count: 7 },
    ],
    glints: [],
  },
  3: {
    coin: { cx: 38, cy: 64, r: 20 },
    stackRx: 14,
    stacks: [
      { cx: 80, count: 4 },
      { cx: 112, count: 7 },
      { cx: 144, count: 10 },
    ],
    glints: [
      { x: 24, y: 26, size: 6 },
      { x: 60, y: 22, size: 4 },
      { x: 126, y: 16, size: 5 },
    ],
  },
};

/** The side band of one coin whose top face is centred at (cx, y). */
function bandPath(cx: number, y: number, rx: number): string {
  const left = cx - rx;
  const right = cx + rx;
  return [
    `M ${String(left)} ${String(y)}`,
    // Lower arc of this coin's top face, left to right (sweep 0 = via the bottom).
    `A ${String(rx)} ${String(FACE_RY)} 0 0 0 ${String(right)} ${String(y)}`,
    `L ${String(right)} ${String(y + THICKNESS)}`,
    // Lower arc of its bottom face, back right to left.
    `A ${String(rx)} ${String(FACE_RY)} 0 0 1 ${String(left)} ${String(y + THICKNESS)}`,
    'Z',
  ].join(' ');
}

/** A four-point glint centred at (x, y). */
function glintPath(x: number, y: number, s: number): string {
  const p = (dx: number, dy: number) => `${String(x + dx)} ${String(y + dy)}`;
  return `M ${p(0, -s)} Q ${p(0, 0)} ${p(s, 0)} Q ${p(0, 0)} ${p(0, s)} Q ${p(0, 0)} ${p(-s, 0)} Q ${p(0, 0)} ${p(0, -s)} Z`;
}

function CoinStack({ cx, count, rx }: Stack & { rx: number }) {
  // The top face of coin i (0 = bottom) is centred THICKNESS * (i + 1) above the ground.
  const faceY = (i: number) => GROUND - THICKNESS * (i + 1);
  const topY = faceY(count - 1);
  return (
    <g>
      {Array.from({ length: count }, (_, i) => (
        <path
          key={i}
          d={bandPath(cx, faceY(i), rx)}
          fill="currentColor"
          fillOpacity={0.45}
          stroke="currentColor"
          strokeWidth={1}
        />
      ))}
      <ellipse
        cx={cx}
        cy={topY}
        rx={rx}
        ry={FACE_RY}
        fill="currentColor"
        fillOpacity={0.2}
        stroke="currentColor"
        strokeWidth={1}
      />
      <ellipse
        cx={cx}
        cy={topY}
        rx={rx * 0.6}
        ry={FACE_RY * 0.6}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.5}
        strokeWidth={1}
      />
    </g>
  );
}

export function PackageIllustration({ tier }: { tier: ChargeTier }) {
  const scene = SCENES[tier];
  const { coin } = scene;
  return (
    <Box
      aria-hidden="true"
      colorPalette="brand"
      bg="colorPalette.subtle"
      color="colorPalette.fg"
      borderRadius="row"
      overflow="hidden"
      data-testid="charge-guide-illustration"
      data-tier={tier}
    >
      <svg
        viewBox={`0 0 ${String(VIEW_W)} ${String(VIEW_H)}`}
        focusable="false"
        // Scales with the card; the height follows the viewBox's 16:10.
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        {/* Ground shadow under the whole pile. */}
        <ellipse cx={80} cy={GROUND + 3} rx={68} ry={4} fill="currentColor" fillOpacity={0.08} />
        {scene.stacks.map((stack) => (
          <CoinStack key={stack.cx} {...stack} rx={scene.stackRx} />
        ))}
        {/* The upright coin, face on, with the unit written on it — the four letters at half the
            radius sit inside the inner ring (about 1.1r wide in a 1.48r ring). */}
        <circle
          cx={coin.cx}
          cy={coin.cy}
          r={coin.r}
          fill="currentColor"
          fillOpacity={0.2}
          stroke="currentColor"
          strokeWidth={2}
        />
        <circle
          cx={coin.cx}
          cy={coin.cy}
          r={coin.r * 0.74}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.55}
          strokeWidth={1}
        />
        <text
          x={coin.cx}
          y={coin.cy}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={coin.r * 0.5}
          fontWeight={700}
          fill="currentColor"
        >
          {COIN_UNIT}
        </text>
        {scene.glints.map((g) => (
          <path
            key={`${String(g.x)}-${String(g.y)}`}
            d={glintPath(g.x, g.y, g.size)}
            fill="currentColor"
          />
        ))}
      </svg>
    </Box>
  );
}
