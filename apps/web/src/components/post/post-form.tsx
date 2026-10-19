'use client';

import { Alert, Box, Button, Field, HStack, Input, Stack, Text } from '@chakra-ui/react';
import {
  POST_BODY_MAX_LENGTH,
  POST_IMAGES_MAX,
  POST_TITLE_MAX_LENGTH,
  type PostDocument,
} from '@buddha/shared';
import { useState } from 'react';
import { copy } from '@/copy';
import { countEditorDocument, titleTooLong } from '@/lib/post-editor';
import { PostEditor } from './post-editor';

/** What the form sends: the title (blank is none) and the editor's JSON. */
export interface PostFormValues {
  title: string | null;
  body: unknown;
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
 */
export function PostForm({
  initialTitle = null,
  initialDocument,
  accountId,
  submitLabel,
  pending,
  errorMessage,
  refusedImageIds,
  onSubmit,
}: {
  initialTitle?: string | null;
  initialDocument?: PostDocument;
  accountId: string | undefined;
  submitLabel: string;
  pending: boolean;
  /** The last refusal, in Korean; undefined when there is none. */
  errorMessage: string | undefined;
  /** The images the last refusal named (`refusedImageIds`). */
  refusedImageIds?: readonly string[];
  onSubmit: (values: PostFormValues) => void;
}) {
  const [title, setTitle] = useState(initialTitle ?? '');
  const [body, setBody] = useState<unknown>(initialDocument ?? { type: 'doc', content: [] });
  const [uploading, setUploading] = useState(false);
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
      <Field.Root invalid={titleInvalid}>
        <Field.Label>{copy.postWriteTitleLabel}</Field.Label>
        <Input
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
          initialDocument={initialDocument}
          onChange={setBody}
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
