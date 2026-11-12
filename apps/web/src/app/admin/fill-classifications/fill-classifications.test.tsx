import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { classificationRequestKey, classifiableFillKey } from '@/hooks/use-fill-classifications';
import {
  classificationFill,
  classificationRequest,
  classifiedWrite,
} from '@/test/fill-classifications';
import { byTestId } from '@/test/render';
import { system } from '@/theme/system';
import type * as ReviewDialogs from '../markets/[id]/market-review-dialogs';
import { ClassifiableFillFacts, DecisionDialog, RequestDialog } from './fill-classifications';
vi.mock('../markets/[id]/market-review-dialogs', async (importOriginal) => {
  const original = await importOriginal<typeof ReviewDialogs>();
  return {
    ...original,
    ReviewDialogShell: (props: ComponentProps<typeof ReviewDialogs.ReviewDialogShell>) => (
      <section data-testid={props.testId}>
        {props.children}
        {props.refusal && <p data-testid="refusal">{props.refusal}</p>}
        <button data-testid="confirm" disabled={props.confirmDisabled}>
          {props.confirmLabel}
        </button>
      </section>
    ),
  };
});
const draw = (client: QueryClient, node: ReactNode) =>
  renderToStaticMarkup(
    <ChakraProvider value={system}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </ChakraProvider>,
  );
const fresh = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
const dialog = (action: 'approve' | 'reject' | 'retract' = 'approve') => (
  <DecisionDialog
    target={{
      kind: 'decision',
      action,
      fillId: classificationFill.id,
      id: classificationRequest.id,
    }}
    onClose={() => undefined}
  />
);
describe('fixed fill classification dialog boundaries', () => {
  it('keeps an initial GET503 retryable and disabled without claiming a missing request', async () => {
    const c = fresh();
    try {
      c.setQueryData(['me'], { id: 'decider' });
      await expect(
        c.fetchQuery({
          queryKey: classificationRequestKey(
            'decider',
            classificationFill.id,
            classificationRequest.id,
          ),
          queryFn: () => Promise.reject(new Error('503')),
        }),
      ).rejects.toThrow('503');
      const html = draw(c, dialog());
      expect(html).toContain(copy.classificationsReadFailed);
      expect(html).toContain(copy.retry);
      expect(html).not.toContain(copy.classificationsNotFound);
      expect(byTestId(html, 'confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      c.clear();
    }
  });
  it('pins the original proposal and blocks approval after the fill classification changed', () => {
    const c = fresh();
    try {
      c.setQueryData(['me'], { id: 'decider' });
      c.setQueryData(
        classificationRequestKey('decider', classificationFill.id, classificationRequest.id),
        { request: classificationRequest, fill: classifiedWrite.fill },
      );
      const html = draw(c, dialog());
      expect(html).toContain(classificationRequest.reason);
      expect(html).toContain(copy.classificationsStale);
      expect(byTestId(html, 'confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      c.clear();
    }
  });
  it('allows the requester to retract a stale pending request, but not a completed one', () => {
    const c = fresh();
    try {
      c.setQueryData(['me'], { id: 'requester' });
      const key = classificationRequestKey(
        'requester',
        classificationFill.id,
        classificationRequest.id,
      );
      c.setQueryData(key, { request: classificationRequest, fill: classifiedWrite.fill });
      expect(byTestId(draw(c, dialog('retract')), 'confirm')?.attributes).not.toHaveProperty(
        'disabled',
      );
      c.setQueryData(key, classifiedWrite);
      expect(byTestId(draw(c, dialog('retract')), 'confirm')?.attributes).toHaveProperty(
        'disabled',
      );
    } finally {
      c.clear();
    }
  });
  it('holds original fill facts during a failed refresh and refuses a new request', async () => {
    const c = fresh();
    try {
      c.setQueryData(['me'], { id: 'requester' });
      const key = classifiableFillKey('requester', classificationFill.id);
      c.setQueryData(key, classificationFill);
      await expect(
        c.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error('503')) }),
      ).rejects.toThrow('503');
      const html = draw(
        c,
        <RequestDialog
          target={{ kind: 'request', action: 'mark', fill: classificationFill }}
          onClose={() => undefined}
        />,
      );
      expect(html).toContain(classificationFill.marketTitle);
      expect(html).toContain(copy.classificationsReadFailed);
      expect(byTestId(html, 'confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      c.clear();
    }
  });
  it('renders the private fixed fill summary without adding account or editable financial controls', () => {
    const c = fresh();
    try {
      const html = draw(c, <ClassifiableFillFacts fill={classificationFill} />);
      expect(html).toContain('120 Coin');
      expect(html).not.toContain('Coin Coin');
      expect(html).toContain(copy.classificationsNormal);
      expect(html).not.toContain('<input');
      expect(html).not.toContain('requester');
    } finally {
      c.clear();
    }
  });
});
