import { Box, type BoxProps, Image } from '@chakra-ui/react';
import { CATEGORY_SLUGS, type CategorySlug } from '@buddha/shared';

/**
 * The small picture at the head of a card and beside a sidebar row (Kalshi draws its series
 * image there, 28px in a 6px-rounded tile with a hairline border). A market has no image of its
 * own unless an admin typed one, and a category has none at all, so the tile shows one of five
 * hand-drawn glyphs — one per TOP-LEVEL category, which a leaf inherits — on that category's
 * tint. The repo draws its own icons (components/ui/password-input.tsx); no icon package.
 *
 * `aria-hidden` throughout: the label beside the tile carries the name, and a glyph that meant
 * "경제" to a sighted reader would only be noise to a screen reader that just heard the word.
 *
 * The tint per category is a Chakra palette's `subtle`/`fg` pair, so it survives both modes
 * without a measurement of its own: those pairs are what Chakra's own `subtle` badge paints.
 */

/** Which glyph and tint a category takes; a slug the tree does not know gets the neutral pair. */
const PALETTE: Record<CategorySlug, string> = {
  economy: 'brand',
  culture: 'purple',
  entertainment: 'pink',
  tech: 'blue',
  weather: 'cyan',
};

function isTopLevel(slug: string): slug is CategorySlug {
  return (CATEGORY_SLUGS as readonly string[]).includes(slug);
}

export interface CategoryIconProps extends Omit<BoxProps, 'children'> {
  /**
   * The TOP-LEVEL slug the glyph is drawn for. A leaf passes its parent's slug; a caller that
   * only holds the leaf and cannot resolve the parent passes the leaf, and gets the neutral glyph.
   */
  slug: string;
  /** An admin-entered market image, drawn instead of the glyph when present and not failed. */
  imageUrl?: string | null;
  onImageError?: () => void;
  /** CSS px; the tile is square. Kalshi's card tile is 28, its sidebar tile 20. */
  size?: number;
}

export function CategoryIcon({
  slug,
  imageUrl,
  onImageError,
  size = 28,
  ...rest
}: CategoryIconProps) {
  const palette = isTopLevel(slug) ? PALETTE[slug] : 'gray';
  return (
    <Box
      aria-hidden="true"
      flexShrink="0"
      boxSize={`${String(size)}px`}
      borderRadius="icon"
      borderWidth="1px"
      borderColor="border.subtle"
      overflow="hidden"
      colorPalette={palette}
      bg="colorPalette.subtle"
      color="colorPalette.fg"
      display="flex"
      alignItems="center"
      justifyContent="center"
      {...rest}
    >
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt=""
          boxSize="100%"
          fit="cover"
          loading="lazy"
          onError={onImageError}
        />
      ) : (
        <CategoryGlyph slug={slug} size={Math.round(size * 0.57)} />
      )}
    </Box>
  );
}

/** 24-unit stroked glyphs, one per top-level category; `tag` for anything else. */
function CategoryGlyph({ slug, size }: { slug: string; size: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  switch (slug) {
    case 'economy':
      // A rising line over a baseline: the chart every economics desk shows.
      return (
        <svg {...common}>
          <path d="M3 20h18" />
          <path d="M4 15l5-5 4 4 7-8" />
          <path d="M16 6h4v4" />
        </svg>
      );
    case 'culture':
      // An open book.
      return (
        <svg {...common}>
          <path d="M12 6c-1.5-1.5-4-2-8-2v14c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2V4c-4 0-6.5.5-8 2z" />
          <path d="M12 6v14" />
        </svg>
      );
    case 'entertainment':
      // A clapperboard.
      return (
        <svg {...common}>
          <rect x="3" y="8" width="18" height="12" rx="2" />
          <path d="M3 8l2-4h14l2 4" />
          <path d="M8 4l2 4M13 4l2 4" />
          <path d="M10 12v5l4-2.5z" />
        </svg>
      );
    case 'tech':
      // A chip.
      return (
        <svg {...common}>
          <rect x="7" y="7" width="10" height="10" rx="1.5" />
          <path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3" />
        </svg>
      );
    case 'weather':
      // A cloud with a sun peeking out.
      return (
        <svg {...common}>
          <path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.3 1.5A3.5 3.5 0 0 0 7 18z" />
          <path d="M17 5l1.5-1.5M20 9h2" />
        </svg>
      );
    default:
      // A tag, for a slug the tree does not know.
      return (
        <svg {...common}>
          <path d="M3 12V4h8l9 9-8 8z" />
          <circle cx="7.5" cy="8.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}
