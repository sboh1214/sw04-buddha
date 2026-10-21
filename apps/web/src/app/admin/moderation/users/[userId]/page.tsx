import { UserModeration } from '../../user-moderation';

/** A member's moderation page (#50, ADR-0081). Access is checked in the admin layout. */
export default async function AdminUserModerationPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  return <UserModeration userId={userId} />;
}
