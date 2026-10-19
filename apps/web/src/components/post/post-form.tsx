'use client';

import {
  Alert,
  Box,
  Button,
  Dialog,
  Field,
  HStack,
  Input,
  Portal,
  Stack,
  Text,
} from '@chakra-ui/react';
import {
  POST_BODY_MAX_LENGTH,
  POST_IMAGES_MAX,
  POST_TITLE_MAX_LENGTH,
  type PostDocument,
} from '@buddha/shared';
import { type RefObject, useEffect, useId, useReducer, useRef, useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useLeaveGuard } from '@/hooks/use-leave-guard';
import { useKeepPostDraftForOnboarding } from '@/hooks/use-post-draft';
import {
  bodyChangedFrom,
  countEditorDocument,
  draftChanged,
  titleTooLong,
} from '@/lib/post-editor';
import {
  POST_DRAFT_DISCARDED_TOAST,
  type PostDraft,
  type PostDraftKey,
  clearSessionPostDraft,
  hasDraftToKeep,
  nextRestoredDraftState,
  readSessionPostDraft,
  restoredDraftState,
} from '@/lib/post-drafts';
import { PostEditor } from './post-editor';

/** What the form sends: the title (blank is none) and the editor's JSON. */
export interface PostFormValues {
  title: string | null;
  body: unknown;
}

export interface PostFormProps {
  initialTitle?: string | null;
  initialDocument?: PostDocument;
  /** Which screen's draft this is, where the onboarding gate keeps it (lib/post-drafts.ts). */
  draftKey: PostDraftKey;
  accountId: string | undefined;
  submitLabel: string;
  /** Sending, or sent and on the way to the post: the form is locked. */
  pending: boolean;
  /** The write succeeded: the draft is the server's and is not kept. */
  saved: boolean;
  /** The last refusal, in Korean; undefined when there is none. */
  errorMessage: string | undefined;
  /** The images the last refusal named (`refusedImageIds`). */
  refusedImageIds?: readonly string[];
  onSubmit: (values: PostFormValues) => void;
}

/**
 * The write and edit screens' form (#46, ADR-0073): an optional one-line title (#45-1, at most
 * 100 characters — owner decision 2026-10-18), the editor, and under it the two counts the server
 * holds the body to (#45-3: 5,000 characters of text without formatting, 10 images), counted the
 * way the server counts (`countEditorDocument`). Nothing asks for a probability, a position or an
 * order (N05 §2: writing and trading are independent). The send waits for every upload in flight;
 * a refusal from the server is shown above the button in the server's terms (`errorMessage`), and
 * the images it refused are marked in the editor (`refusedImageIds`).
 *
 * The body is a field like the title for assistive tech: the editor is `aria-invalid` while a
 * limit is passed and described by the counts and the limit's message, which a polite live region
 * announces when it appears (the counts themselves change on every key and are not announced).
 *
 * Leaving with a draft asks first (owner decision 2026-10-19, `useLeaveGuard`): while the title or
 * the body differs from what the form started with, or an image is uploading, and nothing is being
 * sent — once the screen sends (`pending`, which the screens hold through the move to the post) the
 * draft is the server's.
 *
 * The onboarding gate taking the account to a step left keeps the draft in this tab instead, and
 * asks nothing (오너 결정 2026-10-20, lib/post-drafts.ts) — a title or a body changed, or a draft
 * taken back (`hasDraftToKeep`; an image still uploading is not something it can keep): the
 * screen opened again by the same account takes it back — the title, the body and the uploads'
 * previews — says so above the form, and offers to discard it, which puts back what the screen
 * started with; everything typed since the restore goes too, so the discard always asks first in
 * a dialog that says so (오너 결정 2026-10-20 3차 답 3, `nextRestoredDraftState`), and a discard
 * says so in a toast like the app's other completions — on screen and, once, to screen readers
 * (오너 결정 2026-10-20 3차 답 5, `POST_DRAFT_DISCARDED_TOAST`). Taken back, it is removed from the
 * storage: the form holds it, and guards it like any draft.
 *
 * Focus: the notice is focused when the form is drawn with a draft taken back — it appears with
 * its text already in it, which a live region may not announce, and the reader lands on it with
 * the discard right after. The dialog opens on 취소 (the first of its buttons; nothing is lost on
 * Enter), and closing it without discarding puts the focus back on the discard button. A discard
 * redraws the form and removes that button: the title field is focused rather than the focus
 * falling back to the page, and the toast '되살린 내용을 버렸습니다.' appears. Its one announcement
 * is the toaster's (components/ui/toaster.tsx): the toaster's region is a polite live region
 * (`aria-live="polite"`, zag's toast group) mounted with the app and portalled to <body>, and the
 * modal dialog, which hides the other children of <body> from assistive tech while it is open and
 * is still open when 버리기 adds the toast, leaves a child of <body> with `aria-live` exposed (zag's
 * `hideOthers`) — so the sentence goes into a region exposed all along, and no other region says it.
 */
export function PostForm(props: PostFormProps) {
  const { draftKey, accountId } = props;
  // Read once, when the form is made (the editor takes its first document then).
  const [kept] = useState(() => ({
    key: draftKey,
    draft: accountId === undefined ? null : readSessionPostDraft(draftKey, accountId),
  }));
  const [held, send] = useReducer(nextRestoredDraftState, kept.draft, restoredDraftState);
  // The title field of the fields on screen: where a discard leaves the focus.
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (kept.draft !== null) clearSessionPostDraft(kept.key);
  }, [kept]);
  return (
    <>
      <PostFormFields
        // A discard draws the form afresh from what the screen started with.
        key={held.generation}
        {...props}
        restored={held.restored}
        focusTitle={held.generation > 0}
        titleRef={titleRef}
        onDiscard={() => send('ask')}
      />
      {kept.draft !== null && (
        <DiscardDialog
          open={held.asking}
          discarded={held.discarded}
          titleRef={titleRef}
          onCancel={() => send('cancel')}
          onDiscard={() => {
            // Once: a second click on 버리기 while the dialog closes discards nothing, and says
            // nothing either.
            if (!held.asking) return;
            clearSessionPostDraft(kept.key);
            send('discard');
            toaster.create(POST_DRAFT_DISCARDED_TOAST);
          }}
        />
      )}
    </>
  );
}

/**
 * The confirm of '되살린 내용 버리기' (오너 결정 2026-10-20 3차 답 3): asked every time — what was
 * typed since the restore goes with the draft. 버리기 discards; 취소, Escape and a click outside keep
 * the form as it is. Its focus comes back to the discard button when it closes, or — once
 * discarded, the button gone with the fields it was in — goes to the redrawn title field
 * (`finalFocusEl`).
 */
function DiscardDialog({
  open,
  discarded,
  titleRef,
  onCancel,
  onDiscard,
}: {
  open: boolean;
  discarded: boolean;
  titleRef: RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onDiscard: () => void;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        if (!details.open) onCancel();
      }}
      role="alertdialog"
      lazyMount
      unmountOnExit
      closeOnInteractOutside
      {...(discarded ? { finalFocusEl: () => titleRef.current } : {})}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content data-testid="post-draft-discard-dialog">
            <Dialog.Header>
              <Dialog.Title>{copy.postDraftDiscard}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Dialog.Description>{copy.postDraftDiscardQuestion}</Dialog.Description>
            </Dialog.Body>
            <Dialog.Footer>
              <Button
                variant="outline"
                size="sm"
                onClick={onCancel}
                data-testid="post-draft-discard-cancel"
              >
                {copy.cancel}
              </Button>
              <Button
                size="sm"
                colorPalette="no"
                onClick={onDiscard}
                data-testid="post-draft-discard-confirm"
              >
                {copy.postDraftDiscardConfirm}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function PostFormFields({
  initialTitle = null,
  initialDocument,
  draftKey,
  accountId,
  submitLabel,
  pending,
  saved,
  errorMessage,
  refusedImageIds,
  onSubmit,
  restored,
  focusTitle,
  titleRef,
  onDiscard,
}: PostFormProps & {
  restored: PostDraft | null;
  /** Drawn afresh by a discard: the title field takes the focus the discard button had. */
  focusTitle: boolean;
  titleRef: RefObject<HTMLInputElement | null>;
  /** The discard button: asks first (`DiscardDialog`). */
  onDiscard: () => void;
}) {
  const [title, setTitle] = useState(restored?.title ?? initialTitle ?? '');
  const [body, setBody] = useState<unknown>(
    restored?.body ?? initialDocument ?? { type: 'doc', content: [] },
  );
  const [uploading, setUploading] = useState(false);
  // The editor's own JSON when it was made (`onReady`), and whether the body differs from it now.
  const baseline = useRef<string | null>(null);
  const [bodyChanged, setBodyChanged] = useState(false);
  // The uploads' small previews, by media id, for a draft the gate keeps: the ones taken back with
  // it, and each new upload's once the editor has drawn it small.
  const [previews] = useState(() => new Map(Object.entries(restored?.previews ?? {})));
  // A draft taken back is something to lose until it is sent or discarded, as typed text is.
  const dirty = restored !== null || draftChanged({ title, initialTitle, bodyChanged, uploading });
  useLeaveGuard(!pending && dirty, copy.postLeaveConfirm);
  useKeepPostDraftForOnboarding({
    key: draftKey,
    accountId,
    // What the kept draft can carry: not an upload in flight, which leaving still loses (above).
    hasDraft: hasDraftToKeep({ title, initialTitle, bodyChanged, restored: restored !== null }),
    saved,
    title,
    body: body as PostDraft['body'],
    previews,
  });
  const noticeRef = useRef<HTMLDivElement>(null);
  const noticeTextId = useId();
  useEffect(() => {
    // Each holds for the form's life: a discard draws a new one (PostForm's `generation`).
    if (restored !== null) noticeRef.current?.focus();
    else if (focusTitle) titleRef.current?.focus();
  }, [restored, focusTitle, titleRef]);
  const count = countEditorDocument(body);
  const titleInvalid = titleTooLong(title);
  const blocked =
    pending ||
    uploading ||
    accountId === undefined ||
    count.empty ||
    count.tooLong ||
    count.tooManyImages ||
    titleInvalid;

  return (
    <Stack
      as="form"
      gap="4"
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        const trimmed = title.trim();
        onSubmit({ title: trimmed === '' ? null : trimmed, body });
      }}
      data-testid="post-form"
    >
      {restored !== null && (
        <Alert.Root
          ref={noticeRef}
          status="info"
          role="status"
          // Focused when drawn (above), named by its sentence so that is what is read out.
          tabIndex={-1}
          aria-labelledby={noticeTextId}
          data-testid="post-draft-restored"
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description id={noticeTextId}>{copy.postDraftRestored}</Alert.Description>
          </Alert.Content>
          <Button
            size="xs"
            variant="outline"
            alignSelf="center"
            disabled={pending}
            onClick={onDiscard}
            data-testid="post-draft-discard"
          >
            {copy.postDraftDiscard}
          </Button>
        </Alert.Root>
      )}

      <Field.Root invalid={titleInvalid}>
        <Field.Label>{copy.postWriteTitleLabel}</Field.Label>
        <Input
          ref={titleRef}
          value={title}
          // UTF-16 units: twice the code points, so an emoji title is never cut short; the count
          // below is the rule.
          maxLength={POST_TITLE_MAX_LENGTH * 2}
          placeholder={copy.postWriteTitlePlaceholder}
          disabled={pending}
          onChange={(event) => setTitle(event.target.value.replace(/[\r\n]+/g, ' '))}
          data-testid="post-title-input"
        />
        {titleInvalid && <Field.ErrorText>{copy.errPostTitle}</Field.ErrorText>}
      </Field.Root>

      <Stack gap="1.5">
        <Text as="span" textStyle="emphasisSm" id="post-body-label">
          {copy.postWriteBodyLabel}
        </Text>
        <PostEditor
          initialDocument={restored?.body ?? initialDocument}
          initialPreviews={restored?.previews}
          onReady={(json) => {
            baseline.current = JSON.stringify(json);
          }}
          onChange={(json) => {
            setBody(json);
            setBodyChanged(bodyChangedFrom(baseline.current, json));
          }}
          onPreview={(mediaId, preview) => {
            previews.set(mediaId, preview);
          }}
          accountId={accountId}
          onUploadingChange={setUploading}
          disabled={pending}
          invalid={count.tooLong || count.tooManyImages}
          describedBy="post-body-length post-body-images post-body-errors"
          refusedImageIds={refusedImageIds}
        />
        <HStack gap="3" justify="flex-end" textStyle="bodyXs" color="fg.muted">
          <Text
            as="span"
            id="post-body-length"
            color={count.tooLong ? 'fg.error' : undefined}
            data-testid="post-body-length"
          >
            {`${count.length.toLocaleString('ko-KR')} / ${POST_BODY_MAX_LENGTH.toLocaleString('ko-KR')}${copy.postWriteLength}`}
          </Text>
          <Text
            as="span"
            id="post-body-images"
            color={count.tooManyImages ? 'fg.error' : undefined}
            data-testid="post-body-images"
          >
            {`${copy.postWriteImages} ${String(count.images)} / ${String(POST_IMAGES_MAX)}${copy.postWriteImagesUnit}`}
          </Text>
        </HStack>
        {/* Mounted before anything is in it, so the message is announced when it appears. */}
        <Box id="post-body-errors" role="status" aria-live="polite" data-testid="post-body-errors">
          {count.tooLong && (
            <Text textStyle="bodyXs" color="fg.error">
              {copy.errPostBodyTooLong}
            </Text>
          )}
          {count.tooManyImages && (
            <Text textStyle="bodyXs" color="fg.error">
              {copy.errPostTooManyImages}
            </Text>
          )}
        </Box>
      </Stack>

      {errorMessage !== undefined && (
        <Alert.Root status="error" role="alert" data-testid="post-form-error">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{errorMessage}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      <Button
        type="submit"
        alignSelf="flex-end"
        colorPalette="brand"
        loading={pending}
        disabled={blocked}
        data-testid="post-submit"
      >
        {submitLabel}
      </Button>
    </Stack>
  );
}
