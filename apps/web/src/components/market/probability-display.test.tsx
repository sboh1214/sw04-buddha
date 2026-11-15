import { ChakraProvider } from '@chakra-ui/react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TimeZoneScope } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { formatKst } from '@/lib/datetime';
import { byTestId } from '@/test/render';
import { system } from '@/theme/system';
import { ProbabilityDisplay } from './probability-display';

/**
 * The detail header's third line as drawn (#64, ADR-0139 결정 2-1; owner answer 64-Q2, ADR-0140
 * 결정 2-27): '시장가격 · 최근 체결 <절대 시각>' on one line where it fits, and where it wraps
 * between its two parts — 375px with a zone tail such as '(GMT-5)' — no middle dot left at the
 * end of '시장가격'. Nothing is laid out under node, so what is pinned is what makes that so: the
 * markup, and the rules Emotion writes beside it (`@/test/render` drops those; here they are the
 * subject). The e2e (market.spec.ts, orders.spec.ts, dispute.spec.ts) reads the same text and test
 * ids in a browser.
 */

const FILL_AT = '2026-11-16T05:59:00.000Z';

/** The rendered HTML without its `<style>` elements, and those elements' CSS in one string. */
function draw(node: ReactNode): { html: string; css: string } {
  const full = renderToStaticMarkup(<ChakraProvider value={system}>{node}</ChakraProvider>);
  const style = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
  return {
    html: full.replace(style, ''),
    css: [...full.matchAll(style)].map(([, rules = '']) => rules).join('\n'),
  };
}

/** The declarations of the rule whose selector is exactly `.<className><suffix>`. */
function declarations(css: string, className: string, suffix = ''): string[] {
  const selector = `.${className}${suffix}{`;
  const blocks: string[] = [];
  for (let at = css.indexOf(selector); at >= 0; at = css.indexOf(selector, at + 1)) {
    // Top-level rules only: the line has no responsive values, so none is inside `@media`.
    if (at > 0 && !/[}\n]/.test(css[at - 1] ?? '')) continue;
    blocks.push(css.slice(at + selector.length, css.indexOf('}', at)));
  }
  return blocks
    .join(';')
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== '');
}

/** The line's own markup: from its opening tag to the end of the reading. */
function metaMarkup(html: string): string {
  const at = html.indexOf('data-testid="market-detail-price-meta"');
  expect(at).toBeGreaterThanOrEqual(0);
  return html.slice(html.lastIndexOf('<', at));
}

/** `class` of each `<span>` in `markup`, in order, with the text that directly follows its tag. */
function spans(markup: string): { className: string; testId: string; lead: string }[] {
  return [...markup.matchAll(/<span\b([^>]*)>([^<]*)/g)].map(([, attributes = '', lead = '']) => ({
    className: /\sclass="([^"]*)"/.exec(attributes)?.[1] ?? '',
    testId: /\sdata-testid="([^"]*)"/.exec(attributes)?.[1] ?? '',
    lead,
  }));
}

describe('ProbabilityDisplay third line (64-Q2)', () => {
  const traded = draw(<ProbabilityDisplay lastPrice={63} lastFillAt={FILL_AT} />);
  const time = `${copy.marketLastFillAt} ${formatKst(FILL_AT)}`;

  it("keeps the text and the test ids: '시장가격 · 최근 체결 <시각>', the time under its own id", () => {
    expect(byTestId(traded.html, 'market-detail-price-meta')?.text).toBe(
      `${copy.marketPriceName} · ${time}`,
    );
    expect(byTestId(traded.html, 'market-detail-last-fill')?.text).toBe(time);
    // One separator in the text, and none written a second time for a reader of the DOM.
    expect(byTestId(traded.html, 'market-probability')?.text.split('·')).toHaveLength(2);
  });

  it('puts the separator inside the part that wraps, out of its flow and just before its edge', () => {
    const [line, name, second, separator, lastFill, ...rest] = spans(metaMarkup(traded.html));
    expect(rest).toEqual([]);
    expect(line?.testId).toBe('market-detail-price-meta');
    // The line's own children are the two parts and no loose text: the separator is not between
    // them, where a wrap would leave it at the end of the first line.
    expect(line?.lead).toBe('');
    expect(name?.lead).toBe(copy.marketPriceName);
    expect(second?.lead).toBe('');
    expect(separator?.lead).toBe(' · ');
    expect(lastFill).toMatchObject({ testId: 'market-detail-last-fill', lead: time });
    // …and the second part closes after the time, so separator and time are both inside it.
    expect(metaMarkup(traded.html)).toMatch(
      /<span[^>]*> · <\/span><span[^>]*data-testid="market-detail-last-fill"[^>]*>[^<]*<\/span><\/span><\/span>/,
    );

    // The second part is the separator's containing block and never breaks inside.
    expect(declarations(traded.css, second?.className ?? '')).toEqual(
      expect.arrayContaining(['position:relative', 'white-space:nowrap']),
    );
    // The separator takes no room in it and ends where the part begins.
    expect(declarations(traded.css, separator?.className ?? '')).toEqual(
      expect.arrayContaining(['position:absolute', 'right:100%', 'white-space:pre']),
    );
  });

  it('clips at the line’s own box, a wrapping row, so a part that starts a line shows no dot', () => {
    const [line] = spans(metaMarkup(traded.html));
    expect(declarations(traded.css, line?.className ?? '')).toEqual(
      expect.arrayContaining(['display:flex', 'flex-wrap:wrap', 'overflow:hidden']),
    );
  });

  it('keeps room after the name as wide as the separator, unseen and not in the text', () => {
    const [, name] = spans(metaMarkup(traded.html));
    expect(declarations(traded.css, name?.className ?? '')).toContain('white-space:pre');
    // The same glyphs in the same font, so on one line the separator is drawn where inline text
    // had it; hidden, so it is neither painted nor read out.
    expect(declarations(traded.css, name?.className ?? '', '::after')).toEqual([
      'content:" · "',
      'visibility:hidden',
    ]);
  });

  it('draws a time with a zone tail the same way', () => {
    const { html } = draw(
      <TimeZoneScope zone="America/New_York" settled>
        <ProbabilityDisplay lastPrice={63} lastFillAt={FILL_AT} />
      </TimeZoneScope>,
    );
    const lastFill = byTestId(html, 'market-detail-last-fill')?.text ?? '';
    expect(lastFill).toMatch(/ \(GMT-\d\)$/);
    expect(byTestId(html, 'market-detail-price-meta')?.text).toBe(
      `${copy.marketPriceName} · ${lastFill}`,
    );
    expect(spans(metaMarkup(html)).map(({ lead }) => lead)).toEqual([
      '',
      copy.marketPriceName,
      '',
      ' · ',
      lastFill,
    ]);
  });

  it("leaves '시장가격' alone as it was before the first fill: plain text, no row, no clip, no room", () => {
    const { html, css } = draw(<ProbabilityDisplay lastPrice={null} lastFillAt={null} />);
    const [line, ...rest] = spans(metaMarkup(html));
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ testId: 'market-detail-price-meta', lead: copy.marketPriceName });
    expect(byTestId(html, 'market-detail-last-fill')).toBeUndefined();
    expect(byTestId(html, 'market-probability')?.text).toBe(
      `${copy.noFills}${copy.marketPriceName}`,
    );
    expect(declarations(css, line?.className ?? '')).toEqual([
      'font-size:var(--chakra-font-sizes-sm)',
      'color:var(--chakra-colors-fg-muted)',
    ]);
    expect(declarations(css, line?.className ?? '', '::after')).toEqual([]);
    expect(css).not.toContain('content:" · "');
  });
});
