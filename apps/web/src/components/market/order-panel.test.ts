import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The order panel's drawing after the mockup review (#66, ADR-0140 결정 2-23), pinned in its
 * source as order-panel-provider.test.ts pins the provider's wiring: the components read the
 * provider's context and run effects, neither of which the node runner gives them. The words and
 * figures are pure and tested in lib/order-confirm.test.ts, lib/order-reasons.test.ts and
 * lib/market-detail.test.ts; the contrast of `fg.warning` in theme/contrast.test.ts.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const panel = read('./order-panel.tsx');
const result = read('./order-result.tsx');
const entryBar = read('./order-entry-bar.tsx');
const emptyState = read('../ui/empty-state.tsx');
const signInPrompt = read('./sign-in-prompt.tsx');

/** The source of one function, from its declaration to the next top-level one. */
function fn(source: string, name: string): string {
  const start = source.search(new RegExp(`\\nfunction ${name}\\b|\\nexport function ${name}\\b`));
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = source.slice(start + 1).search(/\n(export )?function /);
  return end < 0 ? source.slice(start) : source.slice(start, start + 1 + end);
}

describe('order panel drawing (결정 2-23)', () => {
  it('breaks Korean at spaces on every line of the panel, long tokens still wrapping', () => {
    const root = fn(panel, 'OrderPanel');
    const section = root.slice(root.indexOf('as="section"'));
    expect(section).toMatch(/wordBreak="keep-all"\s+overflowWrap="anywhere"/);
  });

  it('draws the gap’s line as a notice, keeping the id the buttons point at', () => {
    const root = fn(panel, 'OrderPanel');
    const gap = root.slice(root.indexOf('panel.inputClosed !== null && ('));
    expect(gap.slice(0, gap.indexOf('</Alert.Root>'))).toMatch(
      /<Alert\.Root\s+id=\{closedId\}\s+status="warning"\s+role="status"\s+tabIndex=\{-1\}/,
    );
    expect(gap).toContain('data-testid="order-input-closed"');
    expect(root).not.toMatch(/<Text[^>]*data-testid="order-input-closed"/);
  });

  it('names the gap’s reason in the price slot of the contract and the entry buttons', () => {
    expect(fn(panel, 'contractLabel')).toContain('orderEntryPrice(best, closed)');
    expect(panel).toContain('bestPriceOf(book, outcome, input.side),\n            inputClosed,');
    expect(entryBar).toContain("orderEntryPrice(bestPriceOf(book, contract, 'buy'), inputClosed)");
  });

  it('points a turned-off choice at the line that says why: the gap’s, or D13’s for 매도', () => {
    const choice = fn(panel, 'Choice');
    expect(choice).toContain(
      'disabled ? describedBy : option.disabled === true ? option.describedBy : undefined',
    );
    const form = fn(panel, 'OrderForm');
    expect(form.match(/describedBy=\{closedId\}/g)).toHaveLength(4);
    const sell = form.slice(form.indexOf("value: 'sell'"));
    expect(sell.slice(0, sell.indexOf('}'))).toContain('describedBy: accountLineId(place)');
  });

  it('moves the focus to the sign-in prompt’s sentence and brings the prompt into view', () => {
    const form = fn(panel, 'OrderForm');
    expect(form).toContain('signInMessageRef.current?.focus({ preventScroll: true });');
    expect(form).toContain("prompt.scrollIntoView({ block: 'nearest' });");
    expect(form).toContain('messageRef={signInMessageRef}');
    // Only while the focus is the panel's, or nowhere (a width crossing md takes nothing).
    expect(form).toContain('active === null || active === document.body || area?.contains(active)');
    // The sentence takes the focus only where a caller asks it to.
    expect(signInPrompt).toContain('messageRef={messageRef}');
    expect(emptyState).toContain('tabIndex={messageRef === undefined ? undefined : -1}');
  });

  it('keeps a restriction’s end unbroken in the account line and the refusal card', () => {
    expect(fn(result, 'RestrictedText')).toContain('whiteSpace="nowrap"');
    expect(fn(panel, 'AccountLine')).toContain('<RestrictedText');
    expect(fn(result, 'OrderErrorCard')).toContain('<RestrictedText');
    expect(panel).not.toContain('restrictedLine(');
  });
});

describe('order result cards (결정 2-23)', () => {
  it('names the order being taken and read back', () => {
    expect(fn(result, 'RequestSummary')).toContain('requestSummary(request.body)');
    expect(fn(result, 'Submitting')).toContain('<RequestSummary request={request} />');
    expect(fn(result, 'Recovering')).toContain('<RequestSummary request={request} />');
  });

  it('shows the read-back busy, with a spinner, until it waits for 다시 확인', () => {
    const recovering = fn(result, 'Recovering');
    expect(recovering).toContain('aria-busy={!exhausted}');
    expect(recovering).toMatch(/\{!exhausted && \(?\s*<Spinner/);
  });

  it('gives 버리기 its warning, grouped apart from 같은 요청 다시 보내기', () => {
    const unsent = fn(result, 'Unsent');
    const resend = unsent.indexOf('data-testid="order-resend"');
    const group = unsent.indexOf('data-testid="order-discard-group"');
    const warning = unsent.indexOf('id={warningId}');
    const discard = unsent.indexOf('data-testid="order-discard"');
    expect(resend).toBeGreaterThan(0);
    expect(group).toBeGreaterThan(resend);
    expect(warning).toBeGreaterThan(group);
    expect(discard).toBeGreaterThan(warning);
    expect(unsent).toContain('aria-describedby={warningId}');
  });

  it('gives a neutral status badge a fill and a stroke that show on the dark panel', () => {
    const card = fn(result, 'OrderResultCard');
    expect(card).toContain('variant="surface"');
    expect(card).toContain(
      "_dark={neutral ? { bg: 'gray.800', shadowColor: 'gray.600' } : undefined}",
    );
  });
});

describe('the module graph of the panel', () => {
  // A cycle back into market-detail.ts (order-reasons → order-panel → market-detail) left a
  // binding uninitialised when the server rendered the detail ("Cannot access … before
  // initialization"), which the node runner never sees: market-detail.ts stays a leaf of the
  // panel's modules, and a type-only import from order-panel is written `import type`.
  it('keeps market-detail.ts free of the panel modules', () => {
    const detail = read('../../lib/market-detail.ts');
    expect(detail).not.toMatch(/from '\.\/order-(reasons|panel|confirm|drafts|requests)'/);
  });

  it('imports order-panel into order-reasons for its types only', () => {
    const reasons = read('../../lib/order-reasons.ts');
    expect(reasons).not.toMatch(/^import \{[^}]*\} from '\.\/order-panel';/m);
    expect(reasons).toMatch(/^import type \{[^}]*\} from '\.\/order-panel';/m);
  });
});
