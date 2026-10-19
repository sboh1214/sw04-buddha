'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { type Me } from '@/lib/api';
import { editorImageIds } from '@/lib/post-editor';
import {
  type PostDraft,
  type PostDraftKey,
  keepSessionPostDraft,
  postDraftLandedSince,
  postDraftMoment,
  shouldKeepPostDraft,
} from '@/lib/post-drafts';

/** A mounted form's draft as of its last render: what its screen would keep. */
export interface HeldPostDraft extends Omit<PostDraft, 'previews'> {
  key: PostDraftKey;
  /** The account on screen, the draft's writer. */
  accountId: string | undefined;
  /** A draft the storage can carry that leaving would lose (`hasDraftToKeep`). */
  hasDraft: boolean;
  /** The write it sent succeeded: the draft is the server's. */
  saved: boolean;
  /**
   * The uploads' small previews the form holds, by media id — read when the draft is kept (a
   * preview is drawn after its image went in, maybe after the form's last render), and only for
   * the images the body still has.
   */
  previews: ReadonlyMap<string, string>;
}

/** A form's draft as the hook holds it: with the moment of the render it is from. */
export interface HeldPostDraftAt extends HeldPostDraft {
  /** A `postDraftMoment` taken when the render was committed. */
  moment: number;
}

/** Each mounted form's draft, by the form, written after every render. */
const held = new Map<symbol, HeldPostDraftAt>();

/**
 * What a form going away does with `last`, its draft as of its last render, given `me` — `GET /me`
 * as the cache holds it now: keeps it in this tab when the gate is taking its writer to a step left
 * (`shouldKeepPostDraft`), for that account only. A write of the screen that landed after that
 * render counts as saved (`postDraftLandedSince`): its success is being handled and has not reached
 * the form yet. Whether it kept it.
 */
export function keepHeldPostDraft(last: HeldPostDraftAt, me: Me | undefined): boolean {
  if (last.accountId === undefined || me?.id !== last.accountId) return false;
  const saved = last.saved || postDraftLandedSince(last.key, last.moment);
  if (!shouldKeepPostDraft({ hasDraft: last.hasDraft, saved, onboarding: me.onboarding })) {
    return false;
  }
  return keepSessionPostDraft(last.key, last.accountId, {
    title: last.title,
    body: last.body,
    previews: Object.fromEntries(
      editorImageIds(last.body).flatMap((mediaId) => {
        const preview = last.previews.get(mediaId);
        return preview === undefined ? [] : [[mediaId, preview] as const];
      }),
    ),
  });
}

/**
 * Keeps the form's draft in this tab when the onboarding gate takes the account away (오너 결정
 * 2026-10-20, lib/post-drafts.ts). The gate replaces the page with its placeholder in the render
 * that finds a step left, so the form is unmounted before anything of it could ask; it is the form
 * going that decides — with what it held at its last render, and what `['me']` says now: a step
 * left is the gate taking the account to it (`keepHeldPostDraft`). That is also how a write
 * refused with ONBOARDING_REQUIRED ends (use-posts.ts reads `['me']` again, and the gate follows).
 * `['me']` is read from the cache rather than through `useMe`: the form never renders again with
 * the answer that unmounts it.
 */
export function useKeepPostDraftForOnboarding(draft: HeldPostDraft): void {
  const queryClient = useQueryClient();
  const [form] = useState(() => Symbol('post-draft'));
  useEffect(() => {
    held.set(form, { ...draft, moment: postDraftMoment() });
  });
  useEffect(
    () => () => {
      const last = held.get(form);
      held.delete(form);
      if (last !== undefined) keepHeldPostDraft(last, queryClient.getQueryData<Me>(ME_QUERY_KEY));
    },
    [form, queryClient],
  );
}
