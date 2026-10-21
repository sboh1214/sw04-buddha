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
  /**
   * A draft the storage can carry that leaving would lose (`hasDraftToKeep`). A write that lands
   * moves the form's start to what it sent (`landedDraftStart`) and ends what was taken back, so
   * from the render that shows it saved the form holds none until something changes again — on a
   * notice's edit screen, which stays on the form after a save (#138), what is typed then is a
   * draft again. Before that render, a landed write counts through its moment
   * (`keepHeldPostDraft`).
   */
  hasDraft: boolean;
  /**
   * The uploads' small previews the form holds, by media id — read when the draft is kept (a
   * preview is drawn after its image went in, maybe after the form's last render), and only for
   * the images the body still has.
   */
  previews: ReadonlyMap<string, string>;
}

/** A form's draft as the hook holds it: with the moment of the render it is from. */
export interface HeldPostDraftAt extends HeldPostDraft {
  /**
   * A `postDraftMoment`: of the render it is from — or, while the form is locked for a send, of
   * the last render before it (`heldPostDraftAt`).
   */
  moment: number;
}

/** Each mounted form's draft, by the form, written after every render. */
const held = new Map<symbol, HeldPostDraftAt>();

/**
 * What a form's render leaves for the hook to hold: its draft, at a new moment — unless the form is
 * locked for a send (`pending`), when what it holds cannot change and the moment stays the one of
 * the render before (`prev`, the last one unlocked: what was sent). A write that lands re-renders
 * the form before the form shows it saved: TanStack Query marks the mutation succeeded only once
 * its `onSuccess` is done, and that `onSuccess` puts the answer in the cache — the notice's, which
 * its edit screen reads, as a post's edit does the post's — and reads the lists again. A new moment
 * then would come after the landing (`postDraftLanded`), and the form going away in between would
 * keep, as not yet saved, what was just saved (with the version before the save, on a notice's
 * edit screen). A form made while locked takes a new moment.
 */
export function heldPostDraftAt(
  prev: HeldPostDraftAt | undefined,
  draft: HeldPostDraft,
  pending: boolean,
): HeldPostDraftAt {
  return { ...draft, moment: pending && prev !== undefined ? prev.moment : postDraftMoment() };
}

/**
 * What a form going away does with `last`, its draft as of its last render, given `me` — `GET /me`
 * as the cache holds it now: keeps it in this tab when the gate is taking its writer to a step left
 * (`shouldKeepPostDraft`), for that account only. A write of the screen that account sent and that
 * landed after `last`'s moment counts as saved (`postDraftLandedSince`): its success is being
 * handled and has not reached the form yet — the form, locked since it sent, holds what was sent
 * (`heldPostDraftAt`). Once the form shows the success, what it holds is measured from what was
 * sent (`hasDraft`). Whether it kept it.
 */
export function keepHeldPostDraft(last: HeldPostDraftAt, me: Me | undefined): boolean {
  if (last.accountId === undefined || me?.id !== last.accountId) return false;
  const saved = postDraftLandedSince(last.key, last.accountId, last.moment);
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
    ...(last.version === undefined ? {} : { version: last.version }),
  });
}

/**
 * Keeps the form's draft in this tab when the onboarding gate takes the account away (오너 결정
 * 2026-10-20, lib/post-drafts.ts). The gate replaces the page with its placeholder in the render
 * that finds a step left, so the form is unmounted before anything of it could ask; it is the form
 * going that decides — with what it held at its last render (`heldPostDraftAt`: `pending`, the
 * form locked for a send, keeps the moment of the render that sent), and what `['me']` says now: a
 * step left is the gate taking the account to it (`keepHeldPostDraft`). That is also how a write
 * refused with ONBOARDING_REQUIRED ends (use-posts.ts reads `['me']` again, and the gate follows).
 * `['me']` is read from the cache rather than through `useMe`: the form never renders again with
 * the answer that unmounts it. The gate moves an admin as it moves anyone (/admin is not exempt,
 * lib/onboarding.ts), and a notice's forms keep their drafts the same way (#138, 오너 결정
 * 2026-10-22, ADR-0077).
 */
export function useKeepPostDraftForOnboarding(draft: HeldPostDraft, pending: boolean): void {
  const queryClient = useQueryClient();
  const [form] = useState(() => Symbol('post-draft'));
  useEffect(() => {
    held.set(form, heldPostDraftAt(held.get(form), draft, pending));
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
