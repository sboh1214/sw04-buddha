'use client';

import { Alert, Avatar, Button, Dialog, HStack, Portal, Stack, Text } from '@chakra-ui/react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useDeleteProfileImage, useMe, useUploadProfileImage } from '@/hooks/use-me';
import { nameInitial } from '@/lib/posts';
import {
  PROFILE_IMAGE_ACCEPT,
  profileImageDeleteFailure,
  profileImagePrecheck,
  profileImageRefusalMessage,
  profileImageUploadFailure,
} from '@/lib/profile';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

/**
 * 프로필 이미지 (#141, ADR-0079; ADR-0069 decision 3 #37-6, decision 4 #141): the public profile's
 * image, set here (decision 4 #41: «MY 설정») by a direct upload — never a social login's photo —
 * and shown on the profile and as the small round image of every byline (#37-6). Without one, both
 * draw the nickname's first letter, as this card does.
 */
export function ProfileImageSection() {
  const { data: me, isPending } = useMe();
  return (
    <SettingsSection
      title={copy.settingsProfileImage}
      hint={copy.settingsProfileImageHint}
      testId="settings-profile-image"
    >
      {isPending || !me ? (
        <ProfileUnavailable height="24" />
      ) : (
        // Keyed by account: a tab that switched accounts starts from the new one's image.
        <ProfileImageFields
          key={me.id}
          accountId={me.id}
          nickname={me.profile.nickname}
          imageUrl={me.profile.imageUrl}
        />
      )}
    </SettingsSection>
  );
}

/**
 * The image as the profile shows it, and the two ways to change it:
 *
 * - 올리기 / 바꾸기 opens the file picker and sends the file the moment it is picked — the server
 *   checks it by its bytes, crops the middle to the 512px square and strips the metadata, so what
 *   the card then shows is the stored image itself, not the picked file. A file that is empty, over
 *   5MB or declared as another type than JPEG·PNG·WebP is refused here with the server's own reason
 *   (`profileImagePrecheck`), as the post editor does. Replacing removes the earlier image at once
 *   (decision 4 #141): picking the file is the deliberate step, and nothing more is asked.
 * - 삭제 asks first — the image is removed at once and never comes back (decision 4 #141), as a
 *   post's or a comment's deletion asks — and then the nickname's first letter is drawn again.
 *   Sign-in is all the server asks of a deletion, during a restriction too (#37-9, decision 7).
 *
 * Each answer is the whole profile, whose image address goes into `['me']` (the hooks), and the
 * router drops the pages it kept for Back and Forward (`router.refresh()`, bio-section.tsx says
 * why): Back to the profile, or to a post with the member's byline, shows the change. A refusal is
 * said in the card, where the member is looking — each one a new alert, so the same sentence twice
 * (a second GIF picked) is announced twice; a success is a toast, as the other cards do.
 */
function ProfileImageFields({
  accountId,
  nickname,
  imageUrl,
}: {
  accountId: string;
  nickname: string;
  imageUrl: string | null;
}) {
  const upload = useUploadProfileImage();
  const remove = useDeleteProfileImage();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  // Whether the dialog closes on a deletion that went through: the 삭제 button it opened from is
  // gone then (no image, no button), and focus would fall to the page's start (WCAG 2.4.3) — so it
  // goes to the card's 올리기 instead. A 취소, an Escape or a refused deletion return to 삭제.
  const deleted = useRef(false);
  // A new key per refusal: each mounts an alert of its own, which a screen reader announces — the
  // same sentence set again (a second GIF picked) would leave the page as it was, and say nothing.
  const [notice, setNotice] = useState<{ text: string; key: number } | null>(null);
  const refusals = useRef(0);
  const say = (text: string) => {
    refusals.current += 1;
    setNotice({ text, key: refusals.current });
  };
  const [confirming, setConfirming] = useState(false);
  const busy = upload.isPending || remove.isPending;

  const send = async (file: File) => {
    const refusal = profileImagePrecheck(file);
    if (refusal !== undefined) {
      say(profileImageRefusalMessage(refusal));
      return;
    }
    setNotice(null);
    try {
      await upload.mutateAsync({ file, expectedAccountId: accountId });
      toaster.create({ type: 'success', title: copy.profileImageSaved });
      router.refresh();
    } catch (error) {
      say(profileImageUploadFailure(error));
    }
  };

  const onDelete = async () => {
    setNotice(null);
    try {
      await remove.mutateAsync({ expectedAccountId: accountId });
      deleted.current = true;
      toaster.create({ type: 'success', title: copy.profileImageDeleted });
      router.refresh();
    } catch (error) {
      say(profileImageDeleteFailure(error));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Stack gap="4">
      {notice && (
        <Alert.Root key={notice.key} status="error" role="alert" data-testid="profile-image-notice">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{notice.text}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <HStack gap="4" align="center" flexWrap="wrap">
        {/* The profile's own image area, decorative as there: the card's heading names it. Keyed
            by the address, so a new image starts its own loading rather than the old one's. */}
        <Avatar.Root
          key={imageUrl ?? 'none'}
          size="2xl"
          flexShrink="0"
          aria-hidden="true"
          data-testid="profile-image-preview"
        >
          <Avatar.Fallback>{nameInitial(nickname)}</Avatar.Fallback>
          {imageUrl !== null && (
            <Avatar.Image src={imageUrl} alt="" data-testid="profile-image-preview-image" />
          )}
        </Avatar.Root>
        <HStack gap="2" flexWrap="wrap">
          <Button
            ref={uploadButton}
            size="sm"
            variant="outline"
            loading={upload.isPending}
            loadingText={copy.profileImageUploading}
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            data-testid="profile-image-upload"
          >
            {imageUrl === null ? copy.profileImageUpload : copy.profileImageReplace}
          </Button>
          {imageUrl !== null && (
            <Button
              size="sm"
              variant="outline"
              colorPalette="no"
              disabled={busy}
              onClick={() => {
                deleted.current = false;
                setConfirming(true);
              }}
              data-testid="profile-image-delete"
            >
              {copy.profileImageDelete}
            </Button>
          )}
        </HStack>
      </HStack>
      <input
        ref={fileInput}
        type="file"
        accept={PROFILE_IMAGE_ACCEPT}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared at once, so picking the same file again is a change too.
          event.target.value = '';
          if (file !== undefined) void send(file);
        }}
        data-testid="profile-image-file"
      />
      <Dialog.Root
        open={confirming}
        onOpenChange={(details) => {
          if (!details.open && !remove.isPending) setConfirming(false);
        }}
        role="alertdialog"
        lazyMount
        unmountOnExit
        closeOnInteractOutside={!remove.isPending}
        closeOnEscape={!remove.isPending}
        finalFocusEl={() => (deleted.current ? uploadButton.current : null)}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content data-testid="profile-image-delete-dialog">
              <Dialog.Header>
                <Dialog.Title>{copy.profileImageDeleteTitle}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text>{copy.profileImageDeleteBody}</Text>
              </Dialog.Body>
              <Dialog.Footer>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => setConfirming(false)}
                  data-testid="profile-image-delete-cancel"
                >
                  {copy.cancel}
                </Button>
                <Button
                  size="sm"
                  colorPalette="no"
                  loading={remove.isPending}
                  onClick={() => void onDelete()}
                  data-testid="profile-image-delete-confirm"
                >
                  {copy.profileImageDeleteConfirm}
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Stack>
  );
}
