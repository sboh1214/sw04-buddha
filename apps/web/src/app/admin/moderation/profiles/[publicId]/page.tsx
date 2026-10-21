import { ProfileModeration } from '../../user-moderation';

/**
 * A member's moderation page found by their profile's public id — where a public profile's '운영'
 * link goes (#50, ADR-0081, owner decision 2026-10-21). Access is checked in the admin layout.
 */
export default async function AdminProfileModerationPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  return <ProfileModeration publicId={publicId} />;
}
