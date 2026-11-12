import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { treasuryRequestKey } from '@/hooks/use-treasury';
import { ApiError } from '@/lib/api';
import { byTestId } from '@/test/render';
import { treasuryRequest } from '@/test/treasury';
import { system } from '@/theme/system';
import type * as ReviewDialogs from '../markets/[id]/market-review-dialogs';
import { TreasuryDialog } from './treasury-dialogs';

// Replace only the portal container. The real query, pinned proposal and submit guards render.
vi.mock('../markets/[id]/market-review-dialogs', async (importOriginal) => {
  const original = await importOriginal<typeof ReviewDialogs>();
  return {
    ...original,
    ReviewDialogShell: (props: ComponentProps<typeof ReviewDialogs.ReviewDialogShell>) => (
      <section data-testid={props.testId}>
        {props.children}
        {props.refusal !== null && <p data-testid="dialog-refusal">{props.refusal}</p>}
        <button data-testid="dialog-confirm" disabled={props.confirmDisabled}>
          {props.confirmLabel}
        </button>
      </section>
    ),
  };
});
const draw = (client: QueryClient) =>
  renderToStaticMarkup(
    <ChakraProvider value={system}>
      <QueryClientProvider client={client}>
        <TreasuryDialog
          target={{ action: 'approve', requestId: treasuryRequest.id }}
          onClose={() => undefined}
        />
      </QueryClientProvider>
    </ChakraProvider>,
  );

describe('treasury decision read boundaries', () => {
  it('leaves initial GET503 as a retryable failure without claiming the request is missing', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    try {
      client.setQueryData(['me'], { id: 'admin-b' });
      const failure = new ApiError(503, { code: 'INTERNAL', message: 'unavailable' });
      await expect(
        client.fetchQuery({
          queryKey: treasuryRequestKey(treasuryRequest.id),
          queryFn: () => Promise.reject(failure),
        }),
      ).rejects.toBe(failure);
      const html = draw(client);
      expect(html).toContain(copy.errUnknown);
      expect(html).toContain(copy.retry);
      expect(html).not.toContain(copy.treasuryIssueNotFound);
      expect(byTestId(html, 'dialog-confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      client.clear();
    }
  });
  it('keeps the fixed amount and reason visible on a failed refresh, while refusing a decision', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    try {
      client.setQueryData(['me'], { id: 'admin-b' });
      client.setQueryData(treasuryRequestKey(treasuryRequest.id), treasuryRequest);
      await expect(
        client.fetchQuery({
          queryKey: treasuryRequestKey(treasuryRequest.id),
          queryFn: () => Promise.reject(new Error('offline')),
        }),
      ).rejects.toThrow('offline');
      const html = draw(client);
      expect(html).toContain(treasuryRequest.reason);
      expect(html).toContain(copy.errNetwork);
      expect(byTestId(html, 'treasury-issue-amount')).toBeUndefined();
      expect(byTestId(html, 'dialog-confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      client.clear();
    }
  });
  it('shows a confirmed 404 as missing, and a completed request as changed', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    try {
      client.setQueryData(['me'], { id: 'admin-b' });
      const failure = new ApiError(404, { code: 'NOT_FOUND', message: 'missing' });
      await expect(
        client.fetchQuery({
          queryKey: treasuryRequestKey(treasuryRequest.id),
          queryFn: () => Promise.reject(failure),
        }),
      ).rejects.toBe(failure);
      expect(draw(client)).toContain(copy.treasuryIssueNotFound);
      client.setQueryData(treasuryRequestKey(treasuryRequest.id), {
        ...treasuryRequest,
        status: 'rejected',
      });
      const html = draw(client);
      expect(byTestId(html, 'dialog-refusal')?.text).toBe(copy.treasuryIssueChanged);
      expect(byTestId(html, 'dialog-confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      client.clear();
    }
  });
});
