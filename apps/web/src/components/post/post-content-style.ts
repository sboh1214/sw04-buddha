import { type SystemStyleObject } from '@chakra-ui/react';
import { POST_TEXT_COLORS } from '@buddha/shared';
import { postTextColorToken } from '@/lib/post-editor';

/**
 * How a post's body looks, ONE style object for its two hosts (#46, ADR-0073): the post page's
 * React rendering of the stored document (post-body.tsx) and the editor's ProseMirror view
 * (post-editor.tsx), so what the writer sees is what the reader gets.
 *
 * The hosts' tags differ in two places, and each rule names both spellings:
 * - headings: the editor draws `h1`–`h3` (TipTap's `level`), the post page `h3`–`h5` carrying
 *   `data-heading` (the page's own `h1` and `h2` sit above the body, A-M4-31);
 * - a colour: both draw `data-color="<name>"` and never an inline style — the post page from the
 *   mark, the editor from the `textStyle` attribute it renders (post-editor.tsx) — and the rule
 *   paints the theme's `postText.<name>`, readable in either theme (contrast.test.ts).
 */
export const POST_CONTENT_CSS: SystemStyleObject = {
  textStyle: 'bodyMd',
  color: 'fg',
  wordBreak: 'break-word',
  '& > * + *': { marginTop: '3' },
  '& p': { minHeight: '22px' },
  '& h1, & [data-heading="1"]': { textStyle: 'headline', fontSize: '24px', lineHeight: '32px' },
  '& h2, & [data-heading="2"]': { textStyle: 'titleLg', fontSize: '20px', lineHeight: '28px' },
  '& h3, & [data-heading="3"]': { textStyle: 'titleLg' },
  '& strong': { fontWeight: '700' },
  '& em': { fontStyle: 'italic' },
  '& s': { textDecoration: 'line-through' },
  '& a': { color: 'brand.fg', textDecoration: 'underline', textUnderlineOffset: '2px' },
  '& code': {
    fontFamily: 'mono',
    fontSize: '0.9em',
    bg: 'bg.muted',
    borderRadius: '4px',
    px: '1',
  },
  '& pre': {
    fontFamily: 'mono',
    fontSize: '13px',
    lineHeight: '20px',
    bg: 'bg.muted',
    borderRadius: 'row',
    p: '3',
    overflowX: 'auto',
    whiteSpace: 'pre',
  },
  '& pre code': { bg: 'transparent', p: '0', fontSize: 'inherit' },
  '& blockquote': {
    borderStartWidth: '3px',
    borderColor: 'border.emphasized',
    ps: '3',
    color: 'fg.muted',
  },
  '& ul': { ps: '6', listStyleType: 'disc' },
  '& ol': { ps: '6', listStyleType: 'decimal' },
  '& li > * + *': { marginTop: '1' },
  '& hr': { borderColor: 'border.emphasized', my: '4' },
  '& img': { maxWidth: '100%', height: 'auto', borderRadius: 'row', display: 'block' },
  '& table': { borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' },
  '& td, & th': {
    borderWidth: '1px',
    borderColor: 'border.emphasized',
    px: '2',
    py: '1.5',
    verticalAlign: 'top',
    textAlign: 'start',
  },
  '& th': { bg: 'bg.subtle', fontWeight: '600' },
  ...Object.fromEntries(
    POST_TEXT_COLORS.map((color) => [
      `& [data-color="${color}"]`,
      { color: postTextColorToken(color) },
    ]),
  ),
};
