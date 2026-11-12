import { ChakraProvider } from '@chakra-ui/react';
import { InfiniteQueryObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { CONTROL_KEY, controlDetailKey } from '@/hooks/use-market-maker-controls';
import { adminMarketMakerKey } from '@/hooks/use-admin-market-maker';
import { ApiError, type AdminMarket } from '@/lib/api';
import { getQueryClient } from '@/lib/query-client';
import { marketMaker } from '@/test/market-maker';
import { makerControlApproved, makerControlRequest } from '@/test/market-maker-control';
import { byTestId } from '@/test/render';
import { system } from '@/theme/system';
import type * as Dialogs from './market-review-dialogs';
import {
  ControlDecisionDialog,
  MarketMakerControlInbox,
  MarketMakerControlsPanel,
} from './market-maker-controls';
vi.mock('./market-review-dialogs', async (importOriginal) => {
  const original = await importOriginal<typeof Dialogs>();
  return {
    ...original,
    ReviewDialogShell: (props: ComponentProps<typeof Dialogs.ReviewDialogShell>) => (
      <section>
        {props.children}
        {props.refusal && <p>{props.refusal}</p>}
        <button data-testid="confirm" disabled={props.confirmDisabled}>
          {props.confirmLabel}
        </button>
      </section>
    ),
  };
});
function draw(client: QueryClient, action: 'approve' | 'reject' | 'retract' = 'approve') {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <QueryClientProvider client={client}>
        <ControlDecisionDialog
          marketId={marketMaker.marketId}
          id={makerControlRequest.id}
          action={action}
          onClose={() => undefined}
        />
      </QueryClientProvider>
    </ChakraProvider>,
  );
}
describe('control dialog read and stale boundaries', () => {
  it.each(['market', 'history', 'inbox'] as const)(
    'keeps the %s rows and a retryable notice at the failed next-page button',
    async (location) => {
      const client = getQueryClient();
      client.setDefaultOptions({
        // Render the already mounted list after its failed more, without starting a new mount refetch.
        queries: { retry: false, retryOnMount: false, refetchOnMount: false, staleTime: Infinity },
      });
      client.setQueryData(['me'], { id: 'admin-b' });
      client.setQueryData(adminMarketMakerKey(marketMaker.marketId), marketMaker);
      const key =
        location === 'history'
          ? [...CONTROL_KEY, 'admin-b', marketMaker.marketId, 'history']
          : [
              ...CONTROL_KEY,
              'admin-b',
              location === 'inbox' ? undefined : marketMaker.marketId,
              'list',
              false,
            ];
      const item = location === 'history' ? makerControlApproved.execution! : makerControlRequest;
      const page = { items: [item], nextCursor: 'next' as string | null };
      let fails = true;
      const observer = new InfiniteQueryObserver(client, {
        queryKey: key,
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
          pageParam && fails
            ? Promise.reject(new Error('next page 503'))
            : Promise.resolve(pageParam ? { items: [], nextCursor: null } : page),
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        initialData: { pages: [page], pageParams: [undefined] },
      });
      const unsubscribe = observer.subscribe(() => undefined);
      const drawList = () =>
        renderToStaticMarkup(
          <ChakraProvider value={system}>
            <QueryClientProvider client={client}>
              {location === 'inbox' ? (
                <MarketMakerControlInbox />
              ) : (
                <MarketMakerControlsPanel
                  market={{ id: marketMaker.marketId, status: 'open' } as AdminMarket}
                />
              )}
            </QueryClientProvider>
          </ChakraProvider>,
        ).replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '');
      const notice = `maker-controls-${location === 'market' ? 'requests' : location}-more-failed`;
      try {
        await observer.fetchNextPage();
        expect(observer.getCurrentResult().isFetchNextPageError).toBe(true);
        let html = drawList();
        expect(html).toContain(location === 'history' ? '1 → 2' : makerControlRequest.reason);
        expect(byTestId(html, notice)?.text).toBe(copy.makerControlsReadFailed);
        expect(byTestId(html, notice)?.attributes.role).toBe('alert');
        expect(html.split(copy.makerControlsReadFailed)).toHaveLength(2);
        // A committed response updating a cached row must not hide the failed-more notice.
        client.setQueryData(key, { pages: [page], pageParams: [undefined] });
        expect(byTestId(drawList(), notice)?.text).toBe(copy.makerControlsReadFailed);
        fails = false;
        await observer.fetchNextPage();
        html = drawList();
        expect(byTestId(html, notice)).toBeUndefined();
        expect(html).toContain(location === 'history' ? '1 → 2' : makerControlRequest.reason);
      } finally {
        unsubscribe();
        client.clear();
      }
    },
  );
  it('keeps first503 retryable with disabled decisions and no false missing claim', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    try {
      client.setQueryData(['me'], { id: 'admin-b' });
      await expect(
        client.fetchQuery({
          queryKey: controlDetailKey('admin-b', marketMaker.marketId, makerControlRequest.id),
          queryFn: () =>
            Promise.reject(new ApiError(503, { code: 'INTERNAL', message: 'unavailable' })),
        }),
      ).rejects.toBeDefined();
      const html = draw(client);
      expect(html).toContain(copy.makerControlsReadFailed);
      expect(html).toContain(copy.retry);
      expect(html).not.toContain(copy.makerControlsNotFound);
      expect(byTestId(html, 'confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      client.clear();
    }
  });
  it('preserves fixed request facts on failed refresh and blocks approval', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    try {
      client.setQueryData(['me'], { id: 'admin-b' });
      const key = controlDetailKey('admin-b', marketMaker.marketId, makerControlRequest.id);
      client.setQueryData(key, { request: makerControlRequest, marketMaker });
      await expect(
        client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error('offline')) }),
      ).rejects.toThrow('offline');
      const html = draw(client);
      expect(html).toContain(makerControlRequest.reason);
      expect(html).toContain(copy.makerControlsReadFailed);
      expect(byTestId(html, 'confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      client.clear();
    }
  });
  it('permits own retraction of stale requests while an approval remains disabled', () => {
    const client = new QueryClient();
    try {
      client.setQueryData(['me'], { id: 'admin-a' });
      client.setQueryData(
        controlDetailKey('admin-a', marketMaker.marketId, makerControlRequest.id),
        {
          request: makerControlRequest,
          marketMaker: {
            ...marketMaker,
            runtime: { ...marketMaker.runtime!, controlGeneration: '2' },
          },
        },
      );
      expect(byTestId(draw(client, 'retract'), 'confirm')?.attributes).not.toHaveProperty(
        'disabled',
      );
      expect(byTestId(draw(client, 'approve'), 'confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      client.clear();
    }
  });
});
