'use client';

import {
  Box,
  Button,
  Field,
  HStack,
  Input,
  NativeSelect,
  Skeleton,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import {
  IMAGE_CONTENT_TYPES,
  mediaPath,
  type PostDocument,
  type PostHeadingLevel,
  type PostTextColor,
} from '@buddha/shared';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { TextStyle } from '@tiptap/extension-text-style';
import { Placeholder } from '@tiptap/extensions';
import { NodeSelection } from '@tiptap/pm/state';
import {
  EditorContent,
  Extension,
  Node,
  mergeAttributes,
  useEditor,
  useEditorState,
  type Editor,
  type JSONContent,
} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { restrictedToastAction } from '@/components/moderation/refusal-text';
import { toaster } from '@/components/ui/toaster';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { useUploadPostImage } from '@/hooks/use-posts';
import { type Me } from '@/lib/api';
import { needsOnboarding } from '@/lib/onboarding';
import {
  POST_TEXT_COLOR_LABEL,
  POST_TEXT_COLOR_OPTIONS,
  countEditorDocument,
  createUploadQueue,
  imageRefusalMessage,
  imageUploadErrorMessage,
  insertHeldImage,
  isPostTextColor,
  linkInputHref,
  pastedLinkHref,
  pause,
  sendRetrying,
  takeImageBatch,
  uploadImageBatch,
  uploadWithPreview,
  type ImageSlots,
} from '@/lib/post-editor';
import { previewSize } from '@/lib/post-drafts';
import { isRestricted } from '@/lib/restriction';
import { useSession } from '@/lib/use-session';
import { POST_CONTENT_CSS } from './post-content-style';

/**
 * The post editor (#46, ADR-0073): TipTap 3 over ProseMirror, set up to make only what the owner
 * allowed (ADR-0069 decision 2 #45-3: «기본 서식 제목 코드 구분선 이미지 표 글자 색», the basics being
 * 굵게·기울임·취소선·목록·인용·링크). Its JSON (`editor.getJSON()`) is the post's body as the server
 * takes it — the node and mark names are TipTap's — and the server keeps only its allow-list of it
 * (`sanitizePostDocument`), so this file is a convenience and never a boundary: underline is off,
 * headings stop at 3, a link must be http(s), a colour is one of six names, and an image is one of
 * our uploads by its id. HTML pasted from elsewhere is read through the same schema, so a pasted
 * `<script>`, a `javascript:` link or a foreign `<img>` never becomes a node, and its links are
 * first made the server's (`keepServerLinks`): what the saved post would not keep as a link is not
 * shown as one.
 *
 * An image is uploaded the moment it is picked (`POST /media/images`), and the node takes the id
 * the answer names. The server serves an upload only once a post shows it, so a new image is drawn
 * from a small copy of the file picked (`boundedPreviewOf` — a `data:` URL, as the page's CSP
 * allows `data:` images, not `blob:`; never the file itself) until the post is saved; an image
 * already in the post is drawn from `GET /media/:id`. A draft the onboarding gate kept
 * (lib/post-drafts.ts) comes back with that copy of each new upload (`initialPreviews`) — the file
 * picked is gone with the page — which `onPreview` hands the form as each upload goes in. The
 * upload counts as under way until then (`onUploadingChange`), so the form sends nothing before
 * it: a write the onboarding refuses — the gate's usual way of taking a draft away — finds every
 * image's preview there to keep.
 */

/** The image node: `{ type: 'image', attrs: { mediaId } }` — never a `src` the writer chose. */
const PostImageNode = Node.create<{ srcOf: (mediaId: string) => string }>({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addOptions() {
    return { srcOf: mediaPath };
  },
  addAttributes() {
    return {
      mediaId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-media-id'),
        renderHTML: (attributes: { mediaId?: unknown }) =>
          typeof attributes.mediaId === 'string' ? { 'data-media-id': attributes.mediaId } : {},
      },
    };
  },
  // Only our own images: an `<img>` pasted from another page has no media id and is dropped.
  parseHTML() {
    return [{ tag: 'img[data-media-id]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const mediaId = (node.attrs as { mediaId?: unknown }).mediaId;
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        src: typeof mediaId === 'string' ? this.options.srcOf(mediaId) : '',
        alt: copy.postImageAlt,
      }),
    ];
  },
});

/**
 * The text colour as a NAME on the `textStyle` mark (`{ color: 'red' }`), drawn as `data-color` and
 * painted by the theme (post-content-style.ts) — never an inline colour. Read back from
 * `data-color` only when it is one of the six, so a pasted `style="color: …"` leaves no colour.
 */
const PaletteColor = Extension.create({
  name: 'paletteColor',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          color: {
            default: null,
            parseHTML: (element) => {
              const color = element.getAttribute('data-color');
              return isPostTextColor(color) ? color : null;
            },
            renderHTML: (attributes: { color?: unknown }) =>
              isPostTextColor(attributes.color) ? { 'data-color': attributes.color } : {},
          },
        },
      },
    ];
  },
});

/** `TextStyle` that also reads its own `span[data-color]` back (a copy within the editor). */
const PostTextStyle = TextStyle.extend({
  parseHTML() {
    return [{ tag: 'span[data-color]', consuming: false }, ...(this.parent?.() ?? [])];
  },
});

/**
 * HTML pasted or dropped from elsewhere, with its links made the server's: an `<a>` keeps its
 * link only for an address the server keeps, written as the server writes it (`pastedLinkHref`),
 * and is unwrapped to its text otherwise — a page's relative `/about` or an app's
 * `href="example.com"` would show as a link here and be dropped from the saved post. Parsed with
 * DOMParser, whose document runs no script and loads nothing.
 */
function keepServerLinks(html: string): string {
  if (!/<a[\s>]/i.test(html)) return html;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const anchor of Array.from(parsed.querySelectorAll('a'))) {
    const href = pastedLinkHref(anchor.getAttribute('href'));
    if (href === undefined) anchor.replaceWith(...Array.from(anchor.childNodes));
    else anchor.setAttribute('href', href);
  }
  return parsed.body.innerHTML;
}

/** The accepted file types, for the file picker; the server decides by the bytes anyway. */
const IMAGE_ACCEPT = IMAGE_CONTENT_TYPES.join(',');

/** Reads a picked file as a `data:` URL, to be drawn (`boundedPreviewOf`). */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('unreadable'));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * The preview of a new upload: what the editor draws it from until the post is saved, and what a
 * kept draft takes with it (`onPreview`). A copy at most DRAFT_PREVIEW_MAX_SIDE on its longer side
 * (`previewSize`) — WebP, or JPEG on white where the browser does not write WebP (Safari) — never
 * the file picked itself: the file is read as a `data:` URL (the page's CSP takes `data:` images,
 * not `blob:`) only to be drawn into the copy, and let go once drawn. A photo of a few MB decodes
 * to tens of MB, and the editor drew each upload from its whole file for its life (Codex review of
 * #219, round 2): a few large photos could freeze or end a phone's tab. The first frame of an
 * animation (a GIF moves once the post is saved). Undefined when the browser cannot draw it: the
 * image then shows as the saved post would before it is served — not at all — rather than from its
 * whole file.
 */
async function boundedPreviewOf(file: File): Promise<string | undefined> {
  const image = new Image();
  try {
    image.src = await readAsDataUrl(file);
    await image.decode();
    const { width, height } = previewSize(image.naturalWidth, image.naturalHeight);
    const encode = (type: string, background?: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context === null) return undefined;
      if (background !== undefined) {
        context.fillStyle = background;
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(image, 0, 0, width, height);
      return canvas.toDataURL(type, 0.8);
    };
    const webp = encode('image/webp');
    return webp?.startsWith('data:image/webp') ? webp : encode('image/jpeg', '#ffffff');
  } catch {
    return undefined;
  } finally {
    // The decoded file is the copy's source only.
    image.removeAttribute('src');
  }
}

export interface PostEditorProps {
  /**
   * The stored body, when editing, or the editor's own JSON of a draft taken back; a new post
   * starts empty.
   */
  initialDocument?: PostDocument | JSONContent;
  /** A kept draft's previews of its uploads, by media id (`data:` URLs). */
  initialPreviews?: Readonly<Record<string, string>>;
  /** Each new upload's preview (the small copy the editor draws it from), for a kept draft. */
  onPreview?: (mediaId: string, preview: string) => void;
  /** Every change, as the editor's JSON (what the write sends). */
  onChange: (json: unknown) => void;
  /**
   * The editor's JSON once it is made, before any change: what the form compares a change with to
   * tell a draft from the document it started from (the editor fills in attributes the stored
   * body leaves out, so the stored body itself is no baseline). Told as the editor is mounted —
   * before its view is on the page, so before any key can reach it.
   */
  onReady?: (json: unknown) => void;
  /** The account on screen, which an upload names; no upload while it is unknown. */
  accountId: string | undefined;
  /**
   * The image slots of the uploads on their way (`createImageSlots`), one for the editor's life:
   * the form's, which counts them with the document's images ('이미지 n / 10장', owner decision
   * 2026-10-21) and hears each change as it happens — an image going into the document leaves the
   * uploads in the same render, so the count holds still.
   */
  imageSlots: ImageSlots;
  /** Uploads in flight, so the form can hold its submit until they land. */
  onUploadingChange: (uploading: boolean) => void;
  /** While the post is being sent, and while `readOnly`: nothing changes the document. */
  disabled?: boolean;
  /**
   * The edit screen's post left every view, and the form holds what the writer had in it (오너
   * 결정 2026-10-24, ADR-0073 9-52): the body is there to select and copy, never to change — the
   * form passes `disabled` with it, and the editor says it is read-only to assistive tech. Held
   * so, the editor sends no more files, and an upload already on its way goes in after what is
   * selected (오너 결정 2026-10-25 (2차), 9-53).
   */
  readOnly?: boolean;
  /** Whether the body is over a limit (the form's counts): the editor says so to assistive tech. */
  invalid?: boolean;
  /** Ids of what describes the body (the counts, the limit messages), space-separated. */
  describedBy?: string;
  /** Images the server refused (`refusedImageIds`), drawn with a border until they are replaced. */
  refusedImageIds?: readonly string[];
  /** The empty editor's hint: a post's by default; a notice's (#138) says what a notice holds. */
  placeholder?: string;
  /**
   * Where an image already in the document is drawn from, by its media id: the public
   * `GET /media/:id` by default; a notice's edit screen passes the admin route (#138), since the
   * public one serves a pinned notice's current images only. Read when the editor is made.
   */
  imageSrc?: (mediaId: string) => string;
}

export function PostEditor({
  initialDocument,
  initialPreviews,
  onPreview,
  onChange,
  onReady,
  accountId,
  imageSlots: slots,
  onUploadingChange,
  disabled = false,
  readOnly = false,
  invalid = false,
  describedBy,
  refusedImageIds = [],
  placeholder = copy.postWriteBodyPlaceholder,
  imageSrc = mediaPath,
}: PostEditorProps) {
  /**
   * Previews of this session's uploads, by media id; read by the image node's `srcOf` whenever
   * ProseMirror draws an image. One Map for the editor's life (state, so render never reads a ref);
   * filled as uploads land, which is outside render, with each upload's small copy and never its
   * file (`boundedPreviewOf`) — and, for a draft taken back, with the copies it kept.
   */
  const [previews] = useState(() => new Map<string, string>(Object.entries(initialPreviews ?? {})));
  // The editors whose baseline was told (`onMount`): once each, as its view is made.
  const [settled] = useState(() => new WeakSet<Editor>());
  const format = useFormatDateTime();
  const router = useRouter();
  const editor = useEditor({
    // Next renders this component on the server too; the editor exists in the browser only.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        underline: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          // The server keeps http(s) links only (`postLinkHref`); the editor makes no other. Lenient
          // on purpose: autolink and a pasted plain-text address check linkify's value, which has
          // no scheme for a typed 'example.com', and store linkify's href, which has one. A link
          // pasted as HTML keeps its own href instead — `keepServerLinks` has already made that
          // the server's.
          isAllowedUri: (url) => linkInputHref(url) !== undefined,
          HTMLAttributes: { rel: 'noopener noreferrer nofollow ugc', target: '_blank' },
        },
      }),
      PostTextStyle,
      PaletteColor,
      PostImageNode.configure({
        srcOf: (mediaId) => previews.get(mediaId) ?? imageSrc(mediaId),
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder }),
    ],
    content: initialDocument ?? '',
    editable: !disabled,
    editorProps: {
      attributes: {
        'aria-label': copy.postWriteBodyLabel,
        'aria-multiline': 'true',
        role: 'textbox',
        'data-testid': 'post-editor-content',
      },
      transformPastedHTML: keepServerLinks,
      handleDOMEvents: {
        // Locked (a send in flight, or `readOnly`): the browser's own selection — a drag, a double
        // or a triple click — so the text can be selected and copied. ProseMirror's would take a
        // triple click and draw its selection only in a view holding the focus, which a locked
        // one cannot take: it selected nothing.
        mousedown: (view) => !view.editable,
      },
    },
    // The baseline as the view is made (`mount`, in TipTap's constructor), not on `create`, which
    // TipTap runs a task later: by then the view may be on the page, and a key pressed before it —
    // the editor shown, the text typed at once — went into the baseline and counted as no change,
    // so a form whose post went could hold nothing for it (ADR-0073 9-52).
    onMount: ({ editor: made }) => {
      if (settled.has(made)) return;
      settled.add(made);
      // Settled first: StarterKit's trailing node adds an empty paragraph after a body that ends in
      // anything else (a heading, an image, a table — a body the API took from elsewhere) on the
      // editor's first transaction of any kind, a focus too. Run now, outside the undo history, the
      // baseline is the document the writer sees, and clicking into it changes nothing.
      made.view.dispatch(made.state.tr.setMeta('addToHistory', false));
      onReady?.(made.getJSON());
    },
    onUpdate: ({ editor: changed }) => {
      onChange(changed.getJSON());
    },
  });

  const [uploads, setUploads] = useState(0);
  // Every batch's files go up one at a time through this line, for the editor's life: a batch
  // picked or dropped while another uploads waits its turn, so the writer's page holds one of the
  // account's three uploads in flight on the API (`createUploadQueue`).
  const [sends] = useState(createUploadQueue);
  const { refetch: refetchSession } = useSession();
  // A refused upload runs a refused send's side effects (`postImageUploader`).
  const upload = useUploadPostImage(() => void refetchSession());
  const queryClient = useQueryClient();
  const pathname = usePathname();
  // Whether the onboarding gate (components/auth/onboarding-gate.tsx) is taking the account away
  // from this page, by `['me']` as the cache holds it at the call — after a refused upload has read
  // it again — rather than as this render saw it.
  const gateMoves = () =>
    needsOnboarding(pathname, queryClient.getQueryData<Me>(ME_QUERY_KEY)?.onboarding);
  const fileInput = useRef<HTMLInputElement>(null);

  // `editable` above is read once, when the editor is made; a send in flight locks it after that.
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  // Whether the form holds this editor read-only, its post gone (`readOnly`, ADR-0073 9-52), as an
  // upload reads it when its turn comes or it lands: the held state itself, never the editor's lock
  // (`isEditable`), which a send in flight sets too. From the commit that draws the form held.
  const heldRef = useRef(readOnly);
  useLayoutEffect(() => {
    heldRef.current = readOnly;
  }, [readOnly]);

  // The body's state for assistive tech, on ProseMirror's element as a field's would be on its
  // input. Set on the element itself: the `attributes` above are read when the editor is made, and
  // ProseMirror leaves alone the attributes it did not set.
  useEffect(() => {
    if (editor === null || editor.isDestroyed) return;
    const dom = editor.view.dom as HTMLElement | undefined;
    if (dom === undefined) return;
    if (invalid) dom.setAttribute('aria-invalid', 'true');
    else dom.removeAttribute('aria-invalid');
    if (readOnly) dom.setAttribute('aria-readonly', 'true');
    else dom.removeAttribute('aria-readonly');
    if (describedBy !== undefined && describedBy !== '') {
      dom.setAttribute('aria-describedby', describedBy);
    } else {
      dom.removeAttribute('aria-describedby');
    }
  }, [editor, invalid, readOnly, describedBy]);

  const changeUploads = (delta: number) => {
    setUploads((count) => count + delta);
  };
  // The form learns of uploads after the render that counted them (never from inside an updater,
  // which would set the form's state while this one renders).
  useEffect(() => {
    onUploadingChange(uploads > 0);
  }, [uploads, onUploadingChange]);

  const insertImages = async (files: File[]) => {
    if (editor === null || accountId === undefined) return;
    // Whether the editor is there: the writer has not left, the gate has not taken the form away.
    const alive = () => !editor.isDestroyed;
    // Whether the form is held read-only, its post gone (ADR-0073 9-52): it sends no next file —
    // no batch's start, no file's turn — and an upload already on its way goes on, sent again
    // after a 429 as it would be, and goes in after what is selected, never over it
    // (`uploadImageBatch`, 오너 결정 2026-10-25 (2차) «남긴 양식에 넣음», 9-53). The held state,
    // not the lock: a send in flight locks the editor too, and drops or stops nothing.
    const held = () => heldRef.current;
    const sendsMore = () => alive() && !held();
    // A pick whose dialog was open as the post went takes nothing, as a drop does not.
    if (!sendsMore()) return;
    // A file the precheck refuses is said at once and takes no slot; the others take theirs beside
    // the document's images and the uploads still on their way (`takeImageBatch`): a batch picked
    // or dropped while another uploads cannot pass the limit together with it.
    const batch = takeImageBatch(files, countEditorDocument(editor.getJSON()).images, slots);
    for (const reason of batch.refusals) {
      toaster.create({ type: 'error', title: imageRefusalMessage(reason) });
    }
    if (!batch.taken) {
      toaster.create({ type: 'error', title: copy.errPostTooManyImages });
      return;
    }
    if (batch.sending.length === 0) return;
    // One file after another, behind the files of the editor's other batches; a refusal about the
    // account, or an editor gone or held by a file's turn, ends the batch (`uploadImageBatch`).
    await uploadImageBatch(batch.sending, slots, sends, {
      alive,
      held,
      send: async (file, place) => {
        changeUploads(1);
        try {
          // The preview is drawn while the file goes up, and only it is kept (`boundedPreviewOf`).
          // A failed upload is said once its copy has settled too, so the line decodes one file
          // at a time however fast the uploads fail. A 429 that asks to wait is waited out and the
          // file sent again, twice at most, still counted as uploading (`sendRetrying`, owner
          // decision 2026-10-22 (2차) answer 3) — the same upload, so a form held meanwhile still
          // sends it again and takes its image (9-53); only an editor gone gives it up.
          const { uploaded, preview } = await uploadWithPreview(
            file,
            (picked) =>
              sendRetrying(() => upload(picked, accountId), {
                sleep: pause,
                alive,
              }),
            boundedPreviewOf,
          );
          // Only while the editor is there (`place`): landed after it went, nothing goes in — nor
          // is its preview kept, nor handed to the form for a draft.
          const placed = place((heldNow) => {
            if (preview !== undefined) previews.set(uploaded.id, preview);
            const image = editor.schema.nodeFromJSON({
              type: 'image',
              attrs: { mediaId: uploaded.id },
            });
            if (heldNow) {
              // The form held read-only (9-52): the image goes in after what is selected, the text
              // held to be copied left as it is — and so are the selection, kept to what it held,
              // and the focus, wherever the writer has them (`insertHeldImage`).
              editor
                .chain()
                .command(({ tr }) => {
                  insertHeldImage(tr, image);
                  return true;
                })
                .run();
              return;
            }
            const { selection } = editor.state;
            // After an image goes in, the selection is that image (a node selection, which is where
            // ProseMirror puts the cursor after an atom at the end): the next one goes after it
            // rather than replacing it, so every image of a batch stays — and so does an image the
            // writer had selected. A text selection is replaced, as typing over it would.
            editor
              .chain()
              .focus()
              .insertContentAt(
                selection instanceof NodeSelection
                  ? selection.to
                  : { from: selection.from, to: selection.to },
                image,
              )
              .run();
          });
          // Drawn before the image went in, so the form has it — for a draft it keeps, a held
          // form's too (9-52) — before this upload stops counting (the `finally` below) and the
          // form may send.
          if (placed && preview !== undefined) onPreview?.(uploaded.id, preview);
        } finally {
          changeUploads(-1);
        }
      },
      // A refusal for the onboarding or as another account has already put the account's state
      // on screen (`useUploadPostImage`), as a refused send does. The onboarding's says nothing
      // while the gate takes the account to its step, the draft kept in the tab — a toast would
      // follow it there (owner decision 2026-10-21); should `['me']` fail to be read again, the
      // gate stays, and it says what a refused send says (owner decision 2026-10-21
      // answer 6). An upload given up for the editor gone while it waited says nothing. Any other
      // is said: that file's failure alone — a writing restriction's (#185) with the way to
      // 조치·신고 내역 as the toast's action: the end is in the sentence, the appeal's guidance there.
      failed: (error) => {
        const message = imageUploadErrorMessage(error, gateMoves(), format);
        if (message === undefined) return;
        toaster.create({
          type: 'error',
          title: message,
          action: isRestricted(error)
            ? restrictedToastAction((href) => router.push(href))
            : undefined,
        });
      },
    });
  };

  if (editor === null) {
    return <Skeleton height="240px" borderRadius="row" data-testid="post-editor-loading" />;
  }

  // A refused image's border: its media id is a uuid (`postBodyRefusalOf` checked it), so it is
  // safe in a selector.
  const refusedCss = Object.fromEntries(
    refusedImageIds.map((mediaId) => [
      `& .tiptap img[data-media-id="${mediaId}"]`,
      { outline: '3px solid', outlineColor: 'fg.error', outlineOffset: '2px' },
    ]),
  );

  return (
    <Stack
      gap="0"
      borderWidth="1px"
      borderColor="border.emphasized"
      borderRadius="row"
      overflow="hidden"
      data-testid="post-editor"
    >
      <Toolbar
        editor={editor}
        disabled={disabled}
        onPickImage={() => fileInput.current?.click()}
        canUpload={accountId !== undefined}
      />
      <input
        ref={fileInput}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Cleared at once, so picking the same file again is a change too.
          event.target.value = '';
          void insertImages(files);
        }}
        data-testid="post-editor-file"
      />
      <Box
        px="4"
        py="3"
        minH="240px"
        css={{
          ...POST_CONTENT_CSS,
          // The blocks sit one level down here (EditorContent's div, then ProseMirror's), so the
          // body's spacing between blocks is restated for ProseMirror's children.
          '& .tiptap': { outline: 'none', minHeight: '216px' },
          '& .tiptap > * + *': { marginTop: '3' },
          '& .tiptap p.is-editor-empty:first-of-type::before': {
            content: 'attr(data-placeholder)',
            color: 'fg.muted',
            float: 'left',
            height: '0',
            pointerEvents: 'none',
          },
          '& .tiptap img.ProseMirror-selectednode': {
            outline: '2px solid',
            outlineColor: 'brand.focusRing',
          },
          '& .tiptap .selectedCell': { bg: 'bg.muted' },
          ...refusedCss,
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files);
          if (files.length === 0) return;
          event.preventDefault();
          // A locked editor takes no file, as its toolbar's image button does not: not while the
          // post is sent, nor once it is read-only (the browser does not open the file either).
          if (!disabled) void insertImages(files);
        }}
      >
        <EditorContent editor={editor} />
      </Box>
      {/* Always there, so a screen reader announces the line when it appears: an upload holds
          the form's submit, and the writer should know why. */}
      <Box role="status" aria-live="polite">
        {uploads > 0 && (
          <HStack px="4" pb="3" gap="2" color="fg.muted" data-testid="post-editor-uploading">
            <Spinner size="xs" />
            <Text textStyle="bodyXs">{copy.postWriteUploading}</Text>
          </HStack>
        )}
      </Box>
    </Stack>
  );
}

/** One button of the toolbar: its label is its name, `aria-pressed` says whether it is on. */
function Tool({
  label,
  active,
  onPress,
  disabled,
  testId,
}: {
  label: string;
  /** A toggle's state; undefined for an action (a rule, an image), which has none. */
  active?: boolean;
  onPress: () => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <Button
      size="xs"
      variant={active === true ? 'subtle' : 'ghost'}
      aria-pressed={active}
      disabled={disabled}
      onClick={onPress}
      // The editor keeps its selection: a toolbar press must not take the focus first.
      onMouseDown={(event) => event.preventDefault()}
      data-testid={testId}
    >
      {label}
    </Button>
  );
}

const HEADING_LEVELS: readonly PostHeadingLevel[] = [1, 2, 3];

/**
 * The toolbar: one control per allowed format, and nothing else (#45-3). Its state follows the
 * selection through `useEditorState`, so a toggle shows whether the format is on where the caret
 * is. Headings and the colour are selects (one choice of several); the link opens a field under the
 * toolbar that takes an address and keeps it only when it is one the server keeps (`linkInputHref`).
 */
function Toolbar({
  editor,
  disabled,
  onPickImage,
  canUpload,
}: {
  editor: Editor;
  disabled: boolean;
  onPickImage: () => void;
  canUpload: boolean;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      strike: current.isActive('strike'),
      code: current.isActive('code'),
      bulletList: current.isActive('bulletList'),
      orderedList: current.isActive('orderedList'),
      blockquote: current.isActive('blockquote'),
      codeBlock: current.isActive('codeBlock'),
      link: current.isActive('link'),
      table: current.isActive('table'),
      heading: HEADING_LEVELS.find((level) => current.isActive('heading', { level })) ?? 0,
      color: (current.getAttributes('textStyle') as { color?: unknown }).color,
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
    }),
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [linkInvalid, setLinkInvalid] = useState(false);
  const chain = () => editor.chain().focus();
  const color: PostTextColor | '' = isPostTextColor(state.color) ? state.color : '';

  const applyLink = () => {
    const href = linkInputHref(linkValue);
    if (href === undefined) {
      // Said under the field the writer is still in, tied to it (Field.ErrorText).
      setLinkInvalid(true);
      return;
    }
    chain().extendMarkRange('link').setLink({ href }).run();
    setLinkOpen(false);
    setLinkValue('');
    setLinkInvalid(false);
  };

  return (
    <Stack gap="0" borderBottomWidth="1px" borderColor="border.subtle" bg="bg.subtle">
      <HStack
        role="toolbar"
        aria-label={copy.editorToolbar}
        gap="1"
        px="2"
        py="1.5"
        flexWrap="wrap"
        data-testid="post-editor-toolbar"
      >
        <NativeSelect.Root size="xs" width="auto" disabled={disabled}>
          <NativeSelect.Field
            aria-label={copy.editorHeading}
            value={String(state.heading)}
            onChange={(event) => {
              const level = Number(event.target.value);
              if (level === 0) chain().setParagraph().run();
              else
                chain()
                  .setHeading({ level: level as PostHeadingLevel })
                  .run();
            }}
            data-testid="post-editor-heading"
          >
            <option value="0">{copy.editorParagraph}</option>
            {HEADING_LEVELS.map((level) => (
              <option key={level} value={String(level)}>
                {`${copy.editorHeading} ${String(level)}`}
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
        <Tool
          label={copy.editorBold}
          active={state.bold}
          disabled={disabled}
          onPress={() => chain().toggleBold().run()}
          testId="post-editor-bold"
        />
        <Tool
          label={copy.editorItalic}
          active={state.italic}
          disabled={disabled}
          onPress={() => chain().toggleItalic().run()}
          testId="post-editor-italic"
        />
        <Tool
          label={copy.editorStrike}
          active={state.strike}
          disabled={disabled}
          onPress={() => chain().toggleStrike().run()}
          testId="post-editor-strike"
        />
        <Tool
          label={copy.editorCode}
          active={state.code}
          disabled={disabled}
          onPress={() => chain().toggleCode().run()}
          testId="post-editor-code"
        />
        <NativeSelect.Root size="xs" width="auto" disabled={disabled}>
          <NativeSelect.Field
            aria-label={copy.editorColor}
            value={color}
            onChange={(event) => {
              const picked = event.target.value;
              if (isPostTextColor(picked)) chain().setMark('textStyle', { color: picked }).run();
              else chain().setMark('textStyle', { color: null }).removeEmptyTextStyle().run();
            }}
            data-testid="post-editor-color"
          >
            <option value="">{copy.editorColorNone}</option>
            {POST_TEXT_COLOR_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {POST_TEXT_COLOR_LABEL[option]}
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
        <Tool
          label={copy.editorBulletList}
          active={state.bulletList}
          disabled={disabled}
          onPress={() => chain().toggleBulletList().run()}
          testId="post-editor-bullet-list"
        />
        <Tool
          label={copy.editorOrderedList}
          active={state.orderedList}
          disabled={disabled}
          onPress={() => chain().toggleOrderedList().run()}
          testId="post-editor-ordered-list"
        />
        <Tool
          label={copy.editorBlockquote}
          active={state.blockquote}
          disabled={disabled}
          onPress={() => chain().toggleBlockquote().run()}
          testId="post-editor-blockquote"
        />
        <Tool
          label={copy.editorCodeBlock}
          active={state.codeBlock}
          disabled={disabled}
          onPress={() => chain().toggleCodeBlock().run()}
          testId="post-editor-code-block"
        />
        <Tool
          label={copy.editorHorizontalRule}
          disabled={disabled}
          onPress={() => chain().setHorizontalRule().run()}
          testId="post-editor-rule"
        />
        <Tool
          label={copy.editorLink}
          active={state.link || linkOpen}
          disabled={disabled}
          onPress={() => {
            const current = (editor.getAttributes('link') as { href?: unknown }).href;
            setLinkValue(typeof current === 'string' ? current : '');
            setLinkInvalid(false);
            setLinkOpen((open) => !open);
          }}
          testId="post-editor-link"
        />
        <Tool
          label={copy.editorImage}
          disabled={disabled || !canUpload}
          onPress={onPickImage}
          testId="post-editor-image"
        />
        <Tool
          label={copy.editorTable}
          disabled={disabled || state.table}
          onPress={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          testId="post-editor-table"
        />
        <Tool
          label={copy.editorUndo}
          disabled={disabled || !state.canUndo}
          onPress={() => chain().undo().run()}
          testId="post-editor-undo"
        />
        <Tool
          label={copy.editorRedo}
          disabled={disabled || !state.canRedo}
          onPress={() => chain().redo().run()}
          testId="post-editor-redo"
        />
      </HStack>
      {state.table && (
        <HStack gap="1" px="2" pb="1.5" flexWrap="wrap" data-testid="post-editor-table-tools">
          <Tool
            label={copy.editorTableAddRow}
            disabled={disabled}
            onPress={() => chain().addRowAfter().run()}
            testId="post-editor-table-add-row"
          />
          <Tool
            label={copy.editorTableAddColumn}
            disabled={disabled}
            onPress={() => chain().addColumnAfter().run()}
            testId="post-editor-table-add-column"
          />
          <Tool
            label={copy.editorTableDeleteRow}
            disabled={disabled}
            onPress={() => chain().deleteRow().run()}
            testId="post-editor-table-delete-row"
          />
          <Tool
            label={copy.editorTableDeleteColumn}
            disabled={disabled}
            onPress={() => chain().deleteColumn().run()}
            testId="post-editor-table-delete-column"
          />
          <Tool
            label={copy.editorTableDelete}
            disabled={disabled}
            onPress={() => chain().deleteTable().run()}
            testId="post-editor-table-delete"
          />
        </HStack>
      )}
      {linkOpen && (
        <HStack gap="2" px="2" pb="2" align="flex-start" data-testid="post-editor-link-form">
          <Field.Root flex="1" invalid={linkInvalid}>
            <Field.Label srOnly>{copy.editorLinkPrompt}</Field.Label>
            <Input
              size="xs"
              value={linkValue}
              placeholder={copy.editorLinkPrompt}
              inputMode="url"
              onChange={(event) => {
                setLinkValue(event.target.value);
                setLinkInvalid(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyLink();
                }
              }}
              data-testid="post-editor-link-input"
            />
            {linkInvalid && (
              <Field.ErrorText data-testid="post-editor-link-invalid">
                {copy.editorLinkInvalid}
              </Field.ErrorText>
            )}
          </Field.Root>
          <Button size="xs" onClick={applyLink} data-testid="post-editor-link-apply">
            {copy.editorLinkApply}
          </Button>
          {state.link && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                chain().extendMarkRange('link').unsetLink().run();
                setLinkOpen(false);
              }}
              data-testid="post-editor-unlink"
            >
              {copy.editorUnlink}
            </Button>
          )}
        </HStack>
      )}
    </Stack>
  );
}
