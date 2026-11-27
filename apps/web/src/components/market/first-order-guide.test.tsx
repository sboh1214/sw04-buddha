import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { byTestId, renderWithQueries } from '@/test/render';
import { FirstOrderGuide } from './first-order-guide';

describe('FirstOrderGuide (#59, ADR-0154)', () => {
  it('is open with no way to fold it while the account has no order taken (#59-1)', () => {
    const html = renderWithQueries(
      <FirstOrderGuide firstOrderPlaced={false} timeInForce="ioc" side="buy" />,
    );
    expect(byTestId(html, 'first-order-guide')?.attributes['data-folded']).toBe('false');
    expect(html).not.toContain('data-testid="first-order-guide-toggle"');
    const body = byTestId(html, 'first-order-guide-body');
    expect(body?.attributes.hidden).toBeUndefined();
    expect(body?.text).toContain(copy.firstOrderGuideTitle);
    expect(body?.text).toContain(copy.firstOrderGuideProtection);
    expect(body?.text).not.toContain(copy.firstOrderGuideResting);
  });

  it('is folded under 다시 보기 once the account has one, the same text behind it (#59-2)', () => {
    const html = renderWithQueries(
      <FirstOrderGuide firstOrderPlaced timeInForce="gtc" side="sell" />,
    );
    expect(byTestId(html, 'first-order-guide')?.attributes['data-folded']).toBe('true');
    const toggle = byTestId(html, 'first-order-guide-toggle');
    expect(toggle?.text).toBe(copy.firstOrderGuideShow);
    expect(toggle?.attributes['aria-expanded']).toBe('false');
    const body = byTestId(html, 'first-order-guide-body');
    expect(toggle?.attributes['aria-controls']).toBe(body?.attributes.id);
    expect(body?.attributes.hidden).toBeDefined();
    expect(body?.text).toContain(copy.firstOrderGuideResting);
    expect(body?.text).not.toContain(copy.firstOrderGuideProtection);
  });

  it("ends on the guide's 주문 방식, in a new tab so 확인 keeps the order (#59-4, #136)", () => {
    for (const firstOrderPlaced of [false, true]) {
      const html = renderWithQueries(
        <FirstOrderGuide firstOrderPlaced={firstOrderPlaced} timeInForce="gtc" side="buy" />,
      );
      const body = byTestId(html, 'first-order-guide-body');
      const link = byTestId(html, 'first-order-guide-link');
      expect(body?.text).toContain(copy.guideLinkOrders);
      expect(link?.attributes.href).toBe('/guide#orders');
      expect(link?.attributes.target).toBe('_blank');
      expect(link?.attributes.rel).toBe('noopener');
      expect(link?.text).toBe(copy.guideLinkOrders);
    }
  });

  it('draws nothing while the account is not known yet', () => {
    const html = renderWithQueries(
      <FirstOrderGuide firstOrderPlaced={undefined} timeInForce="ioc" side="buy" />,
    );
    expect(html).toBe('');
  });
});
