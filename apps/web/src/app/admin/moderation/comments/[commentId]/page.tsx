import { CommentModeration } from '../../item-moderation';

/** A 댓글's or a 대댓글's moderation page (#50, ADR-0081). Access is checked in the admin layout. */
export default async function AdminCommentModerationPage({
  params,
}: {
  params: Promise<{ commentId: string }>;
}) {
  const { commentId } = await params;
  return <CommentModeration commentId={commentId} />;
}
