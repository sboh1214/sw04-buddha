import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SRC } from '@/test/screen-text';

/**
 * MY's rooms for its live orders (#124, ADR-0143 결정 9): a buy order ended without a `user:` event
 * reaches MY only through its market's room, so MY's live list sits in the room of every market it
 * has read, held or not. The component needs the query client and the socket, which this node-only
 * runner does not mount, so the wiring is read off the source.
 */
describe('PendingOrders market rooms', () => {
  const list = readFileSync(path.join(SRC, 'components/orders/pending-orders.tsx'), 'utf8');
  const portfolio = readFileSync(path.join(SRC, 'app/my/portfolio.tsx'), 'utf8');

  it("joins the room of every loaded order's market in MY's variant", () => {
    expect(list).toContain(
      "const marketIds = variant === 'my' ? [...new Set(rows.map((order) => order.marketId))] : [];",
    );
    expect(list).toContain('useMarketSocket(marketIds);');
    // Every loaded page, not only the rows drawn under a preview's limit.
    expect(list).toContain('page.items) ?? [];');
  });

  it("is MY's variant on both the tab and the summary's preview", () => {
    const shared = portfolio.slice(portfolio.indexOf('export function LivePendingOrders'));
    expect(shared).toMatch(/<PendingOrders[^>]*variant="my"/);
  });
});
