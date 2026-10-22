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
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
} from 'react';
import { RefusalText } from '@/components/moderation/refusal-text';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useLeaveGuard } from '@/hooks/use-leave-guard';
import { useKeepPostDraftForOnboarding } from '@/hooks/use-post-draft';
import {
  type DraftStart,
  bodyChangedFrom,
  countEditorDocument,
  countWithUploads,
  createImageSlots,
  draftChanged,
  landedDraftStart,
  titleTooLong,
} from '@/lib/post-editor';
import {
  POST_DRAFT_DISCARDED_TOAST,
  type PostDraft,
  type PostDraftKey,
  clearSessionPostDraft,
  hasDraftToKeep,
  heldDraftVersion,
  nextRestoredDraftState,
  readSessionPostDraft,
  restoredDraftState,
} from '@/lib/post-drafts';
import { PostEditor } from './post-editor';

/** What the form sends: the title (blank is none) and the editor's JSON. */
export interface PostFormValues {
  title: string | null;
  body: unknown;
  /**
   * The version of the screen's subject what is sent was typed on (`heldDraftVersion`): a draft
   * taken back's own, else the screen's `draftVersion`. Undefined for a post's form.
   */
  version: string | null | undefined;
}

export interface PostFormProps {
  initialTitle?: string | null;
  initialDocument?: PostDocument;
  /**
   * Which screen's draft this is, where the onboarding gate keeps it (lib/post-drafts.ts): a post's
   * write or edit screen, or a notice's (#138 — the admin screens are gated like the rest, and a
   * notice's draft is kept the same way, 오너 결정 2026-10-21 (3차), ADR-0077).
   */
  draftKey: PostDraftKey;
  /**
   * The version of the screen's subject the form starts from, for a screen that saves against one
   * (a notice's edit screen: the version it was opened from, moved by each save that lands). Kept
   * with the draft when the gate takes it, and what a draft taken back is saved against
   * (`PostFormValues['version']`). Absent for a post's form.
   */
  draftVersion?: string | null;
  accountId: string | undefined;
  submitLabel: string;
  /** Sending, or sent and on the way to the post: the form is locked. */
  pending: boolean;
  /**
   * The write succeeded: the draft is the server's and is not kept. Each time it turns true, what
   * the form holds becomes its start (`landedDraftStart`) — a screen that stays on the form after
   * a save (a notice's edit screen, #138) has nothing to lose, or to keep, until the form changes
   * again.
   */
  saved: boolean;
  /** The last refusal, in Korean; undefined when there is none. */
  errorMessage: string | undefined;
  /**
   * Whether a writing restriction gave it (#185, `isRestricted`): the way to 조치·신고 내역 goes
   * under it (`RefusalText`).
   */
  errorRestricted?: boolean;
  /** The images the last refusal named (`refusedImageIds`). */
  refusedImageIds?: readonly string[];
  onSubmit: (values: PostFormValues) => void;
  /**
   * The post the form edits was deleted — it left every view, or stands as its placeholder with
   * comments under it (#48) — while the form held something of the writer's (the edit screen, 오너
   * 결정 2026-10-24, ADR-0073 9-52): the form stays, read-only, with '없거나 삭제된 글입니다.' and
   * 닫기 (`onClose`) in place of its button.
   */
  gone?: boolean;
  /**
   * Why, while `gone`: '없거나 삭제된 글입니다.' (`copy.errPostGone`, the default) — or, for a post
   * an operator hid under the form (#50, 오너 결정 2026-10-25, ADR-0081 7-29), '운영 정책에 따라
   * 숨긴 글은 고칠 수 없습니다.' (`copy.errPostNotEditable`): each the sentence of the save refused
   * for it.
   */
  goneMessage?: string;
  /** 닫기, while `gone`: the writer is done with what the form held. */
  onClose?: () => void;
  /**
   * Told whether the form holds something of the writer's — a changed title or body, a draft taken
   * back, an upload on its way, and no write that landed: what leaving would lose — each time that
   * changes, and false as the form goes: what the edit screen keeps should its post go (`gone`).
   */
  onHoldingChange?: (holding: boolean) => void;
  /** A notice's form (#138): a required title; absent, a post's, whose title is optional. */
  notice?: NoticeFormOptions;
  /**
   * What the refusal offers beside its message, if anything: a notice's edit refused because the
   * notice was saved since — whoever saved it — offers its latest version (#138, owner decisions
   * 2026-10-21).
   */
  errorAction?: ReactNode;
  /** Where the editor draws an image already in the document (`PostEditor`'s `imageSrc`). */
  imageSrc?: (mediaId: string) => string;
  /**
   * Focus the title when the form mounts: a notice's edit form opened again on the latest version
   * (최신 내용 불러오기, #138) replaces the form the focus was in, which would leave it on nothing.
   */
  autoFocusTitle?: boolean;
}

/**
 * The same form for an operator's notice (#138, ADR-0077 — «글과 같은 서식 편집기»): its title is
 * required, so the send waits for one and the field says so, and the labels say what a notice
 * holds. A notice's title limit is the post title's (`NOTICE_TITLE_MAX_LENGTH`, lib/notices.test.ts
 * checks they are one number), so the count below holds for both.
 */
export interface NoticeFormOptions {
  titleRequired: true;
  titleLabel: string;
  titlePlaceholder: string;
  bodyPlaceholder: string;
}

/**
 * The write and edit screens' form (#46, ADR-0073): an optional one-line title (#45-1, at most
 * 100 characters — owner decision 2026-10-18), the editor, and under it the two counts the server
 * holds the body to (#45-3: 5,000 characters of text without formatting, 10 images), counted the
 * way the server counts (`countEditorDocument`) — the images with the uploads still on their way,
 * as a batch picked past the limit is refused by (owner decision 2026-10-21, `countWithUploads`).
 * Nothing asks for a probability, a position or an order (N05 §2: writing and trading are
 * independent). The send waits for every upload in flight;
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
 * draft is the server's. A notice's forms ask the same (#138, owner decision 2026-10-21 8); the
 * notice's edit screen stays on the form after a save, and what the save sent is the form's start
 * from then on (`saved`, `landedDraftStart`); a refused save moves nothing.
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
 * storage: the form holds it, and guards it like any draft. A notice's forms do the same (#138,
 * 오너 결정 2026-10-21 (3차), ADR-0077 decision 8-20) — a notice edit's draft with the version it was typed
 * on (`draftVersion`), which its save sends — and a write that lands ends what was taken back
 * (`landed`): the notice's edit screen stays on the form, holding the server's content then.
 *
 * The post an edit form edits can be deleted while it is open — in another tab: a save refused as
 * NOT_FOUND, or a read of it that answers so (the edit screen's `postGoneAfter`) or answers the
 * placeholder of a post deleted with comments under it (#48, `postEditDeleted`) — or an operator
 * can hide it (#50, `postEditHidden`). The form then keeps what the writer had in it, as #48's
 * comment boxes keep a text whose place went (오너 결정 2026-10-24, ADR-0073 9-52; 2026-10-25 for a
 * hiding, ADR-0081 7-29; ADR-0074, 오너 결정 2026-10-20 답 4, 2026-10-21 답 1·2): the title and
 * the body stay on screen, read-only — selectable and copyable, never changed or sent — under
 * '없거나 삭제된 글입니다.', or '운영 정책에 따라 숨긴 글은 고칠 수 없습니다.' for a hiding
 * (`GoneNotice`, `goneMessage`), and 닫기 takes the button's place; leaving still asks
 * first, and the draft the onboarding gate would keep is kept as before — the post going clears
 * nothing. The screen decides it as the post goes, by what the form said it held
 * (`onHoldingChange`): a form holding nothing of the writer's is not kept.
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
  // Whether the screen's write had landed as of the last render: its turning true ends what was
  // taken back (a notice's edit screen stays on the form after a save; a post's screen leaves).
  const [landed, setLanded] = useState(props.saved);
  if (landed !== props.saved) {
    setLanded(props.saved);
    if (props.saved) send('landed');
  }
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
          // Nothing to discard into once the post is gone: the form is read-only.
          open={held.asking && props.gone !== true}
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
  draftVersion,
  accountId,
  submitLabel,
  pending,
  saved,
  errorMessage,
  errorRestricted = false,
  refusedImageIds,
  onSubmit,
  gone = false,
  goneMessage = copy.errPostGone,
  onClose,
  onHoldingChange,
  notice,
  errorAction,
  imageSrc,
  autoFocusTitle = false,
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
  // What "changed" is measured from: the title the form started with and the editor's own first
  // JSON (`baseline`, the null body) — and once a write of the form lands (`saved` turns true),
  // what that write sent (`landedDraftStart`). Taken when the form is made, as the editor takes its
  // document: a screen that reads its subject again in the background (a notice's edit screen) does
  // not move it under what is typed.
  const [start, setStart] = useState<DraftStart>({ title: initialTitle, body: null });
  const [uploading, setUploading] = useState(false);
  // The uploads on their way (`createImageSlots`), one set of slots for the form's life (a discard
  // draws a new form, and editor, with new ones): told of every change as it happens, from the
  // editor's own upload code, so an image going into the document (`body`) and leaving the uploads
  // land in one render.
  const [imagesUploading, setImagesUploading] = useState(0);
  const [imageSlots] = useState(() => createImageSlots(POST_IMAGES_MAX, setImagesUploading));
  // The editor's own JSON when it was made (`onReady`), and whether the body differs now from the
  // start (`start.body`, or this baseline while the start has no body of its own).
  const baseline = useRef<string | null>(null);
  const [bodyChanged, setBodyChanged] = useState(false);
  // Whether the screen's write had landed as of the last render: its turning true moves the start.
  const [landed, setLanded] = useState(saved);
  if (landed !== saved) {
    setLanded(saved);
    if (saved) {
      setStart(landedDraftStart(start, { title, body, bodyChanged }));
      setBodyChanged(false);
    }
  }
  // The uploads' small previews, by media id, for a draft the gate keeps: the ones taken back with
  // it, and each new upload's once the editor has drawn it small.
  const [previews] = useState(() => new Map(Object.entries(restored?.previews ?? {})));
  // A draft taken back is something to lose until it is sent or discarded, as typed text is.
  const dirty =
    restored !== null || draftChanged({ title, initialTitle: start.title, bodyChanged, uploading });
  // Held once the post is gone (오너 결정 2026-10-24): leaving asks until the writer closes it.
  useLeaveGuard(gone || (!pending && dirty), copy.postLeaveConfirm);
  // What the edit screen keeps should the post go: what leaving would lose, while no write of it
  // has landed — and, once gone, the form is on screen only while it holds that.
  const holding = gone || (dirty && !saved);
  useEffect(() => {
    onHoldingChange?.(holding);
  }, [holding, onHoldingChange]);
  useEffect(() => () => onHoldingChange?.(false), [onHoldingChange]);
  // What the kept draft can carry: not an upload in flight, which leaving still loses (above).
  const hasDraft = hasDraftToKeep({
    title,
    initialTitle: start.title,
    bodyChanged,
    restored: restored !== null,
  });
  // The version what the form holds was typed on: a draft taken back's, else the screen's.
  const version = heldDraftVersion(restored, draftVersion);
  useKeepPostDraftForOnboarding(
    {
      key: draftKey,
      accountId,
      // Once a write lands, measured from what it sent (the start moved, and what was taken back
      // ended): a change after it — on a notice's edit screen, which stays on the form — is a
      // draft to keep again. Until the form shows it saved, the landing counts by its moment.
      hasDraft,
      title,
      body: body as PostDraft['body'],
      previews,
      ...(version === undefined ? {} : { version }),
    },
    // Locked for a send: what the form holds is what it sent, whatever renders it again meanwhile.
    pending,
  );
  const noticeRef = useRef<HTMLDivElement>(null);
  const noticeTextId = useId();
  useEffect(() => {
    // Each holds for the form's life: a discard draws a new one (PostForm's `generation`).
    if (restored !== null) noticeRef.current?.focus();
    else if (focusTitle) titleRef.current?.focus();
  }, [restored, focusTitle, titleRef]);
  // '이미지 n / 10장' counts the uploads on their way too (owner decision 2026-10-21).
  const count = countWithUploads(countEditorDocument(body), imagesUploading);
  const titleInvalid = titleTooLong(title);
  const titleMissing = notice?.titleRequired === true && title.trim() === '';
  const blocked =
    gone ||
    pending ||
    titleMissing ||
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
        onSubmit({ title: trimmed === '' ? null : trimmed, body, version });
      }}
      data-testid="post-form"
    >
      {gone && <GoneNotice message={goneMessage} />}
      {restored !== null && !gone && (
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

      <Field.Root invalid={titleInvalid} required={notice?.titleRequired}>
        <Field.Label>{notice?.titleLabel ?? copy.postWriteTitleLabel}</Field.Label>
        <Input
          ref={titleRef}
          value={title}
          // UTF-16 units: twice the code points, so an emoji title is never cut short; the count
          // below is the rule.
          maxLength={POST_TITLE_MAX_LENGTH * 2}
          placeholder={notice?.titlePlaceholder ?? copy.postWriteTitlePlaceholder}
          // Read-only rather than disabled once the post is gone: its text is still the writer's to
          // select and copy.
          readOnly={gone}
          disabled={pending && !gone}
          autoFocus={autoFocusTitle}
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
            setBodyChanged(bodyChangedFrom(start.body ?? baseline.current, json));
          }}
          onPreview={(mediaId, preview) => {
            previews.set(mediaId, preview);
          }}
          accountId={accountId}
          imageSlots={imageSlots}
          onUploadingChange={setUploading}
          disabled={pending || gone}
          readOnly={gone}
          invalid={count.tooLong || count.tooManyImages}
          describedBy="post-body-length post-body-images post-body-errors"
          refusedImageIds={refusedImageIds}
          placeholder={notice?.bodyPlaceholder}
          imageSrc={imageSrc}
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

      {/* Once the post is gone, the notice above says why (a save refused for it said the same). */}
      {errorMessage !== undefined && !gone && (
        <Alert.Root status="error" role="alert" data-testid="post-form-error">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              <RefusalText message={errorMessage} restricted={errorRestricted} />
            </Alert.Description>
            {errorAction}
          </Alert.Content>
        </Alert.Root>
      )}

      {gone ? (
        // A button of its own (`key`), not the send's made over: a focus on the send — held there
        // while the refused save was in flight — does not land on 닫기, where the next Enter would
        // close what the form holds.
        <Button
          key="close"
          alignSelf="flex-end"
          variant="outline"
          onClick={onClose}
          data-testid="post-form-close"
        >
          {copy.close}
        </Button>
      ) : (
        <Button
          key="submit"
          type="submit"
          alignSelf="flex-end"
          colorPalette="brand"
          loading={pending}
          disabled={blocked}
          data-testid="post-submit"
        >
          {submitLabel}
        </Button>
      )}
    </Stack>
  );
}

/**
 * '없거나 삭제된 글입니다.' at the top of a form whose post left every view (오너 결정 2026-10-24,
 * ADR-0073 9-52) — the reason #48 puts at the top of a comment text it holds, in the words of a
 * save refused for it (`copy.errPostGone`), or of one refused for a post an operator hid under the
 * form (`copy.errPostNotEditable`, #50, ADR-0081 7-29: `message`). The focus comes here only when
 * it has fallen to the page — the controls a save in flight disabled took it with them — and the
 * sentence, the notice's name, is read out then; otherwise the focus stays where the writer has it
 * and the sentence is an alert, read out as it appears. Decided as it first appears, on the client
 * only (the server's HTML never holds it), as #48's held texts decide it (ADR-0074 7-25).
 */
function GoneNotice({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const textId = useId();
  const [takesFocus] = useState(
    () =>
      typeof document !== 'undefined' &&
      (document.activeElement === null || document.activeElement === document.body),
  );
  useEffect(() => {
    if (takesFocus) ref.current?.focus({ preventScroll: false });
  }, [takesFocus]);
  return (
    <Alert.Root
      ref={ref}
      status="error"
      role={takesFocus ? 'group' : 'alert'}
      tabIndex={-1}
      aria-labelledby={textId}
      data-testid="post-form-gone"
    >
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description id={textId}>{message}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}
