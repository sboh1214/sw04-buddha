import { PostModeration } from '../../item-moderation';

/** A post's moderation page (#50, ADR-0081). Access is checked in the admin layout. */
export default async function AdminPostModerationPage({
  params,
}: {
  params: Promise<{ postId: string }>;
}) {
  const { postId } = await params;
  return <PostModeration postId={postId} />;
}
