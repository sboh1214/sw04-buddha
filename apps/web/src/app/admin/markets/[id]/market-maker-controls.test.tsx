import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { controlDetailKey } from '@/hooks/use-market-maker-controls';
import { ApiError } from '@/lib/api';
import { marketMaker } from '@/test/market-maker';
import { makerControlRequest } from '@/test/market-maker-control';
import { byTestId } from '@/test/render';
import { system } from '@/theme/system';
import type * as Dialogs from './market-review-dialogs';
import { ControlDecisionDialog } from './market-maker-controls';
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
