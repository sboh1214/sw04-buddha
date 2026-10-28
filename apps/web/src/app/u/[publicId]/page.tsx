import { Container } from '@chakra-ui/react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProfileView } from '@/components/profile/profile-view';
import { fetchProfileServer } from '@/lib/api.server';
import { profilePageMetadata } from '@/lib/profile';

/**
 * Rendered per request: a nickname, a 소개 or a count can change at any moment, and the page must
 * show the member as they are now (#37-3: the current nickname).
 */
export const dynamic = 'force-dynamic';

/**
 * Every answer — the profile, and the 404 — is `noindex` (#37-1, `profilePageMetadata`), and the
 * tab names the member by the current nickname.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ publicId: string }>;
}): Promise<Metadata> {
  const { publicId } = await params;
  // The same React-cached call the body makes.
  return profilePageMetadata(await fetchProfileServer(publicId));
}

/**
 * `/u/<publicId>`: a member's public profile (#41, ADR-0078; ADR-0069 decision 3 #37-1·#37-2) —
 * the address is the public id, never the account id or the nickname, so an old link finds the
 * member after a nickname change. Anyone reads it, signed in or not; search engines are kept away.
 * An unknown public id — and anything that cannot be one, and once #140 is there a withdrawn
 * account (#37-16: «없는 계정처럼») — is a 404.
 *
 * The profile is read here, once, without a cookie, and drawn into the HTML: the same page for
 * every reader. Whether the reader is the member — and so the link to MY 설정 — is decided in the
 * browser (`OwnProfileLink`).
 */
export default async function ProfilePage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const profile = await fetchProfileServer(publicId);
  if (profile === null) notFound();
  return (
    <Container maxW="760px" px="6" py={{ base: '6', md: '10' }}>
      <ProfileView profile={profile} />
    </Container>
  );
}
