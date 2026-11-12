import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { FillClassificationRequest, FillClassificationWrite } from '@/lib/api';
import {
  classifiedWrite,
  classificationFill,
  classificationRequest,
} from '@/test/fill-classifications';
import {
  applyClassificationWrite,
  classifiableFillKey,
  classificationRequestKey,
  CLASSIFICATIONS_KEY,
  joinClassificationRequests,
} from './use-fill-classifications';
type Pages = InfiniteData<
  { items: FillClassificationRequest[]; nextCursor: string | null },
  string | undefined
>;
const page = (items: FillClassificationRequest[]): Pages => ({
  pages: [{ items, nextCursor: null }],
  pageParams: [undefined],
});
const by = 'decider';
const key = (all: boolean, fillId: string | undefined = undefined) => [
  ...CLASSIFICATIONS_KEY,
  by,
  fillId,
  'list',
  all,
];
const pending: FillClassificationWrite = {
  request: classificationRequest,
  fill: classificationFill,
};
describe('committed fill classification cache', () => {
  it('keeps authoritative terminal status and participant classification after stale writes and a failed GET', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      client.setQueryData(['me'], { id: by });
      client.setQueryData(key(false), page([classificationRequest]));
      client.setQueryData(key(true), page([classificationRequest]));
      expect(await applyClassificationWrite(client, by, classifiedWrite)).toBe(true);
      expect(await applyClassificationWrite(client, by, pending)).toBe(true);
      expect(client.getQueryData(key(false))).toEqual(page([]));
      expect(client.getQueryData(key(true))).toEqual(page([classifiedWrite.request]));
      expect(client.getQueryData(classifiableFillKey(by, classificationFill.id))).toEqual(
        classifiedWrite.fill,
      );
      await expect(
        client.fetchQuery({
          queryKey: classifiableFillKey(by, classificationFill.id),
          queryFn: () => Promise.reject(new Error('503')),
        }),
      ).rejects.toThrow('503');
      expect(client.getQueryData(classifiableFillKey(by, classificationFill.id))).toEqual(
        classifiedWrite.fill,
      );
      expect(
        client.getQueryData(
          classificationRequestKey(by, classificationFill.id, classificationRequest.id),
        ),
      ).toEqual(classifiedWrite);
    } finally {
      client.clear();
    }
  });
  it('retains a newer clear while an older mark response updates a different request', async () => {
    const client = new QueryClient();
    try {
      client.setQueryData(['me'], { id: by });
      const cleared = {
        ...classifiedWrite.fill,
        excluded: false,
        classificationRevision: '2',
        classification: {
          ...classifiedWrite.fill.classification!,
          revision: '2',
          action: 'clear' as const,
        },
      };
      client.setQueryData(classifiableFillKey(by, classificationFill.id), cleared);
      await applyClassificationWrite(client, by, classifiedWrite);
      expect(client.getQueryData(classifiableFillKey(by, classificationFill.id))).toEqual(cleared);
      expect(
        client.getQueryData<FillClassificationWrite>(
          classificationRequestKey(by, classificationFill.id, classificationRequest.id),
        )?.request,
      ).toEqual(classifiedWrite.request);
    } finally {
      client.clear();
    }
  });
  it('aborts a first GET before an approved snapshot, and discards a response after account switching', async () => {
    const client = new QueryClient();
    let resolve!: (value: typeof classificationFill) => void;
    try {
      client.setQueryData(['me'], { id: by });
      const fetching = client
        .fetchQuery({
          queryKey: classifiableFillKey(by, classificationFill.id),
          queryFn: () =>
            new Promise<typeof classificationFill>((done) => {
              resolve = done;
            }),
        })
        .catch(() => undefined);
      await applyClassificationWrite(client, by, classifiedWrite);
      resolve(classificationFill);
      await fetching;
      expect(client.getQueryData(classifiableFillKey(by, classificationFill.id))).toEqual(
        classifiedWrite.fill,
      );
      client.clear();
      client.setQueryData(['me'], { id: 'new-account' });
      expect(await applyClassificationWrite(client, by, classifiedWrite)).toBe(false);
      expect(client.getQueryData(classifiableFillKey(by, classificationFill.id))).toBeUndefined();
    } finally {
      client.clear();
    }
  });
  it('does not graft another fill or an older unloaded request ahead of paginated results', async () => {
    const client = new QueryClient();
    try {
      client.setQueryData(['me'], { id: by });
      const newer = {
        ...classificationRequest,
        id: '33333333-3333-4333-8333-333333333333',
        requestedAt: '2026-11-11T03:00:00.000Z',
      };
      client.setQueryData(key(true), page([newer]));
      client.setQueryData(key(true, '99'), page([newer]));
      await applyClassificationWrite(client, by, classifiedWrite);
      expect(client.getQueryData(key(true))).toEqual(page([newer]));
      expect(client.getQueryData(key(true, '99'))).toEqual(page([newer]));
    } finally {
      client.clear();
    }
  });
  it('holds terminal list rows against an older REST page but follows the incoming page shape', () => {
    expect(
      joinClassificationRequests(
        page([classifiedWrite.request]),
        page([classificationRequest]),
        true,
      ),
    ).toEqual(page([classifiedWrite.request]));
    expect(
      joinClassificationRequests(
        page([classifiedWrite.request]),
        page([classificationRequest]),
        false,
      ),
    ).toEqual(page([]));
    expect(joinClassificationRequests(page([classifiedWrite.request]), page([]), true)).toEqual(
      page([]),
    );
  });
});
