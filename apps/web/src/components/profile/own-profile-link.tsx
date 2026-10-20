'use client';

import { Button } from '@chakra-ui/react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { PROFILE_SETTINGS_PATH, isOwnProfile } from '@/lib/profile';

/**
 * 'MY 설정에서 고치기' on the member's own profile (ADR-0069 decision 4 #41): the public items are
 * edited in MY 설정, and this is the way there. Whether the viewer is the member is decided here,
 * in the browser, once `GET /me` has answered (`isOwnProfile`, by the public id): the server reads
 * the profile without a cookie, so the HTML is the same for every reader and holds no such link —
 * and the first client render, before the session is known, draws nothing either, as the server
 * did.
 */
export function OwnProfileLink({ publicId }: { publicId: string }) {
  const { data: me } = useMe();
  if (!isOwnProfile(publicId, me?.profile.publicId)) return null;
  return (
    <Button asChild size="sm" variant="outline" alignSelf="flex-start">
      <NextLink href={PROFILE_SETTINGS_PATH} data-testid="profile-edit">
        {copy.profileEdit}
      </NextLink>
    </Button>
  );
}
