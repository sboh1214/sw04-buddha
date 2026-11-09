import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { correctionDetailKey } from '@/hooks/use-reconciliation-corrections';
import { ApiError } from '@/lib/api';
import { correctionDetail, correctionRequest } from '@/test/reconciliation-corrections';
import { byTestId } from '@/test/render';
import { system } from '@/theme/system';
import type * as ReviewDialogs from '../markets/[id]/market-review-dialogs';
import { CorrectionDialog } from './reconciliation-correction-dialogs';

// Only replace the portal container, which renders outside SSR markup. The actual correction
// query, state decisions, warnings and submit guard still render through CorrectionDialog.
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

function draw(client: QueryClient) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <QueryClientProvider client={client}>
        <CorrectionDialog
          target={{
            action: 'approve',
            resultId: correctionDetail.result.id,
            requestId: correctionRequest.id,
          }}
          onClose={() => undefined}
        />
      </QueryClientProvider>
    </ChakraProvider>,
  );
}

describe('correction decision read outcomes', () => {
  it('keeps an initial GET503 as a read failure with retry, without claiming the request is missing', async () => {
    // Render the settled first read, without a mount retry changing that observed state.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    try {
      client.setQueryData(['me'], { id: 'admin-b' });
      const unavailable = new ApiError(503, {
        code: 'INTERNAL',
        message: 'temporarily unavailable',
      });
      await expect(
        client.fetchQuery({
          queryKey: correctionDetailKey(correctionDetail.result.id),
          queryFn: () => Promise.reject(unavailable),
        }),
      ).rejects.toBe(unavailable);
      expect(client.getQueryData(correctionDetailKey(correctionDetail.result.id))).toBeUndefined();
      const html = draw(client);
      expect(html).toContain(copy.errUnknown);
      expect(html).toContain(copy.retry);
      expect(html).not.toContain(copy.reconciliationCorrectionNotFound);
      expect(byTestId(html, 'dialog-refusal')).toBeUndefined();
      expect(byTestId(html, 'dialog-confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      client.clear();
    }
  });
  it('reports a missing request only when a successful detail response proves its absence', () => {
    const client = new QueryClient();
    try {
      client.setQueryData(['me'], { id: 'admin-b' });
      client.setQueryData(correctionDetailKey(correctionDetail.result.id), {
        ...correctionDetail,
        requests: [],
      });
      const html = draw(client);
      expect(byTestId(html, 'dialog-refusal')?.text).toBe(copy.reconciliationCorrectionNotFound);
      expect(byTestId(html, 'dialog-confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      client.clear();
    }
  });
});
