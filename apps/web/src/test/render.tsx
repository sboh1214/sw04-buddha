import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { system } from '@/theme/system';

/**
 * Rendering a client component to the HTML its first paint has, in vitest's node environment (no
 * DOM, no effects): inside Chakra's system and a QueryClient holding `seed`, each data under its
 * key, as the server pages seed theirs. For the components whose drawing, not only the pure
 * function behind it, an owner decision is about. Test support, not screen code: the screen walk
 * skips this folder (screen-text.ts).
 */
export function renderWithQueries(
  node: ReactNode,
  seed: readonly (readonly [queryKey: readonly unknown[], data: unknown])[] = [],
): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [queryKey, data] of seed) queryClient.setQueryData(queryKey, data);
  const html = renderToStaticMarkup(
    <ChakraProvider value={system}>
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    </ChakraProvider>,
  );
  queryClient.clear();
  // Emotion writes its rules beside the elements; what is drawn is the rest.
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '');
}

/** One element of rendered HTML: its attributes as written and its text with the tags taken out. */
export interface RenderedElement {
  attributes: Record<string, string>;
  text: string;
}

/** The entities React writes in text and attributes, back to their characters. */
function decode(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The element whose opening tag matches `open`, out to its own closing tag. */
function elementAt(html: string, open: RegExpMatchArray): RenderedElement {
  const name = open[1] ?? '';
  const at = open.index ?? 0;
  const attributes: Record<string, string> = {};
  for (const [, key = '', value = ''] of open[0].matchAll(/\s([\w:-]+)="([^"]*)"/g)) {
    attributes[key] = decode(value);
  }
  // Nested elements of the same name are counted, so the right closing tag ends it.
  const tags = new RegExp(`<(/?)${name}\\b[^>]*>`, 'g');
  tags.lastIndex = at + open[0].length;
  let depth = 1;
  let end = html.length;
  for (let tag = tags.exec(html); tag !== null; tag = tags.exec(html)) {
    depth += tag[1] === '/' ? -1 : 1;
    if (depth === 0) {
      end = tag.index;
      break;
    }
  }
  const inner = html.slice(at + open[0].length, end);
  return { attributes, text: decode(inner.replace(/<[^>]+>/g, '')) };
}

/** The element carrying `data-testid="<testId>"`, or `undefined` when none is drawn. */
export function byTestId(html: string, testId: string): RenderedElement | undefined {
  const open = new RegExp(
    `<([a-z][a-z0-9]*)\\b[^>]*\\sdata-testid="${escapeRegExp(testId)}"[^>]*>`,
  ).exec(html);
  return open === null ? undefined : elementAt(html, open);
}

/** The elements of one tag name (`h2`, `a`…), in the order they are drawn. */
export function byTagName(html: string, name: string): RenderedElement[] {
  return [...html.matchAll(new RegExp(`<(${name})\\b[^>]*>`, 'g'))].map((open) =>
    elementAt(html, open),
  );
}

/** Every `data-testid` that starts with `prefix`, in the order they are drawn. */
export function testIdsStartingWith(html: string, prefix: string): string[] {
  return [...html.matchAll(/\sdata-testid="([^"]*)"/g)]
    .map(([, testId = '']) => testId)
    .filter((testId) => testId.startsWith(prefix));
}
