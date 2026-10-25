'use client';

import {
  Badge,
  Box,
  Button,
  HStack,
  Heading,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { adminMediaPath } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { type ReactNode } from 'react';
import { PostBody } from '@/components/post/post-body';
import { copy } from '@/copy';
import { useAdminCommentModeration, useAdminPostModeration } from '@/hooks/use-admin-moderation';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import {
  type AdminCommentModeration,
  type AdminPostComment,
  type AdminPostModeration,
  type AdminReport,
  type ModerationItemState,
  type ModerationUser,
  type WarningSubject,
  isApiError,
} from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  ADMIN_REPORTS_PATH,
  adminCommentLine,
  adminCommentModerationPath,
  adminPostModerationPath,
  concernsOperator,
  countText,
  moderationItemStateLabel,
  pendingReportIds,
} from '@/lib/moderation';
import { postPath } from '@/lib/posts';
import {
  ActionRows,
  Block,
  ClosedMemberNotice,
  type DialogSpec,
  Line,
  LoadFailedNotice,
  ModerationDialog,
  OwnNotice,
  ReportRows,
  type SubjectOption,
  UserName,
  accountRestrictDialog,
  dismissDialog,
  restrictDialog,
} from './moderation-parts';

/**
 * The moderation pages of a 근거 글 and of a 댓글 or 대댓글 (#50, ADR-0081; #50 guidance: «target
 * detail (content incl. deleted original and revision history, reporter count, past actions on the
 * user), action dialogs with required reason»): the item whatever its state — the deleted original
 * and a hidden one too (until #184's retention empties it once its period has passed — a hidden
 * one only a withdrawn member's, owner decision 2026-10-24 3: then that it was emptied, and when),
 * its images at their operator address (`adminMediaPath`) — its earlier versions (#45-4) still
 * kept, the reports on it with their reporters, the actions about it and every action its author
 * received — and, on a post's page, every comment under it with the way to its own page
 * (`CommentRows`), reported or not. The actions, chosen by the violation's weight
 * (#45-11): 숨기기 (while it is public), 경고 (about this item or about nothing in particular), 작성 제한 of
 * its author (#185, ADR-0082 — a term and a reason, about this item, whose pending reports it
 * resolves, or nothing in particular), the request of its author's 계정 제한 (#139, ADR-0085 —
 * the report queue's way to it, ADR-0069 decision 2 #45-11: about this item, whose pending reports
 * its approval resolves, or nothing in particular; another admin approves it on the member's page
 * or the requests' list) and 신고 기각 (the pending reports on screen); 조치 취소, and a standing
 * restriction's 조기 해제 and 감경 — an account restriction's as requests — in the lists. None is
 * offered on the operator's own item (decision 4 #50 — `OwnNotice`), and none while the operator
 * on screen is unknown.
 */

function BackLink() {
  return (
    <ChakraLink asChild alignSelf="flex-start" fontSize="sm" color="fg.muted">
      <NextLink href={ADMIN_REPORTS_PATH}>{copy.adminReportQueue}</NextLink>
    </ChakraLink>
  );
}

function StateBadge({
  state,
  testId = 'moderation-item-state',
}: {
  state: ModerationItemState;
  testId?: string;
}) {
  return (
    <Badge
      size="sm"
      variant="subtle"
      colorPalette={state === 'published' ? 'gray' : 'orange'}
      data-testid={testId}
    >
      {moderationItemStateLabel(state)}
    </Badge>
  );
}

/**
 * The item's times: written, edited, deleted by its author, hidden by an operator — and when #184's
 * retention emptied it (`purgedAt`): a deleted original once its period had passed since the
 * deletion, or a withdrawn member's item an operator still hides once the 신고·제재 period had
 * passed since the later of the withdrawal and the hiding (owner decision 2026-10-24 3 — it stays
 * hidden, its hiding's action deleted).
 */
function Times({
  item,
}: {
  item: {
    createdAt: string;
    editedAt: string | null;
    deletedAt: string | null;
    hiddenAt: string | null;
    purgedAt: string | null;
  };
}) {
  return (
    <Stack gap="0.5">
      <Line label={copy.adminModerationCreatedAt}>{formatKst(item.createdAt)}</Line>
      {item.editedAt !== null && (
        <Line label={copy.adminModerationEditedAt}>{formatKst(item.editedAt)}</Line>
      )}
      {item.deletedAt !== null && (
        <Line label={copy.adminModerationDeletedAt}>{formatKst(item.deletedAt)}</Line>
      )}
      {item.hiddenAt !== null && (
        <Line label={copy.adminModerationHiddenAt}>{formatKst(item.hiddenAt)}</Line>
      )}
      {item.purgedAt !== null && (
        <Line label={copy.adminModerationPurgedAt} testId="moderation-purged-at">
          {formatKst(item.purgedAt)}
        </Line>
      )}
    </Stack>
  );
}

/**
 * In place of a deleted or a still-hidden original #184's retention emptied: that it is gone. The
 * row stays — the comments, likes, reports and actions that name it keep naming it — with no
 * title, text or image (`posts_purged_check`, `post_comments_purged_check`), and nothing brings it
 * back.
 */
function PurgedNotice() {
  return (
    <Text fontSize="sm" color="fg.muted" data-testid="moderation-purged">
      {copy.adminModerationPurged}
    </Text>
  );
}

/**
 * A warning's or a restriction's two choices on an item's page: about this item (the default — its
 * pending reports are resolved), or nothing in particular.
 */
function itemSubjects(thisItem: WarningSubject): SubjectOption[] {
  return [
    { value: 'this', label: copy.adminModerationWarnSubjectThis, subject: thisItem },
    { value: 'none', label: copy.adminModerationWarnSubjectNone, subject: null },
  ];
}

/** The warning on an item's page: about this item (the default), or nothing. */
function warnDialog(author: ModerationUser, thisItem: WarningSubject): DialogSpec {
  return {
    kind: 'action',
    title: copy.adminModerationWarnTitle,
    body: copy.adminModerationWarnBody,
    success: copy.adminModerationWarned,
    testId: 'moderation-warn-dialog',
    subjects: itemSubjects(thisItem),
    build: ({ reason, note, subject, expectedAccountId }) => ({
      kind: 'warn',
      userId: author.id,
      body: { reason, note, subject, expectedAccountId },
    }),
  };
}

/**
 * The page's action bar, or the notice that the item is the operator's own. Nothing while the
 * operator is unknown.
 */
function ActionBar({
  author,
  reports,
  hide,
  warnSubject,
  onOpen,
}: {
  author: ModerationUser;
  reports: readonly AdminReport[];
  /** The hiding's button and dialog, while the item is public; null otherwise. */
  hide: { label: string; spec: DialogSpec } | null;
  warnSubject: WarningSubject;
  onOpen: (spec: DialogSpec) => void;
}) {
  const own = concernsOperator(author.id, useOperatorId());
  if (own === undefined) return null;
  if (own) return <OwnNotice />;
  return (
    <HStack gap="2" flexWrap="wrap" data-testid="moderation-action-bar">
      {hide !== null && (
        <Button
          size="sm"
          colorPalette="no"
          onClick={() => onOpen(hide.spec)}
          data-testid="moderation-hide"
        >
          {hide.label}
        </Button>
      )}
      {/* An author who closed the account (#140, the only one with no nickname) takes no new
          action (owner decision 2026-10-23 (2차) 1); the item is still hidden, and its reports
          dismissed, as any. */}
      {author.nickname === null ? (
        <ClosedMemberNotice />
      ) : (
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpen(warnDialog(author, warnSubject))}
            data-testid="moderation-warn"
          >
            {copy.adminModerationWarn}
          </Button>
          <Button
            size="sm"
            variant="outline"
            colorPalette="no"
            onClick={() => onOpen(restrictDialog(author, itemSubjects(warnSubject)))}
            data-testid="moderation-restrict"
          >
            {copy.adminModerationRestrict}
          </Button>
          <Button
            size="sm"
            variant="outline"
            colorPalette="no"
            onClick={() => onOpen(accountRestrictDialog(author, itemSubjects(warnSubject)))}
            data-testid="moderation-account-restrict"
          >
            {copy.adminModerationAccountRestrict}
          </Button>
        </>
      )}
      {pendingReportIds(reports).length > 0 && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onOpen(dismissDialog(reports))}
          data-testid="moderation-dismiss"
        >
          {copy.adminModerationDismiss}
        </Button>
      )}
    </HStack>
  );
}

/**
 * The comments under a post, reported or not, each leading to its own moderation page: where an
 * operator starts an action on a comment nobody reported (decision 4 #50 «신고 없는 조치») — the
 * public screens give a comment no address of its own. A 대댓글 set in under its 댓글; the start of
 * the text whatever the state (a deleted original too, kept for operators, #45-5).
 */
function CommentRows({ comments }: { comments: readonly AdminPostComment[] }) {
  if (comments.length === 0) {
    return (
      <Text color="fg.muted" fontSize="sm">
        {copy.adminModerationNoComments}
      </Text>
    );
  }
  return (
    <Stack as="ul" gap="2" listStyleType="none" data-testid="moderation-comments">
      {comments.map((comment) => (
        <Stack
          as="li"
          key={comment.id}
          gap="1"
          borderWidth="1px"
          borderRadius="l2"
          p="3"
          ms={comment.parentId === null ? '0' : '4'}
          data-testid={`moderation-comment-${comment.id}`}
        >
          <HStack gap="2" flexWrap="wrap">
            <Text as="span" fontSize="sm" fontWeight="medium">
              {comment.parentId === null ? copy.authoredCommentKind : copy.authoredReplyKind}
            </Text>
            {comment.state !== 'published' && (
              <StateBadge state={comment.state} testId="moderation-comment-state" />
            )}
            <UserName user={comment.author} />
            <Text as="span" fontSize="sm" color="fg.muted">
              {formatKst(comment.createdAt)}
            </Text>
          </HStack>
          <ChakraLink asChild color="brand.fg" fontSize="sm" wordBreak="break-word">
            <NextLink
              href={adminCommentModerationPath(comment.id) as Route}
              data-testid="moderation-comment-open"
            >
              {adminCommentLine(comment.excerpt)}
            </NextLink>
          </ChakraLink>
        </Stack>
      ))}
    </Stack>
  );
}

/** The blocks every item's page ends with: reports, this item's actions, the author's record. */
function RecordBlocks({
  item,
  revisions,
  onOpen,
}: {
  item: Pick<AdminPostModeration, 'reports' | 'reporterCount' | 'actions' | 'authorActions'>;
  revisions: ReactNode;
  onOpen: (spec: DialogSpec) => void;
}) {
  return (
    <>
      <Block
        title={copy.adminModerationReports}
        testId="moderation-reports-block"
        aside={
          <Text fontSize="sm" color="fg.muted" data-testid="moderation-reporter-count">
            {countText(copy.adminReporterCount, item.reporterCount, copy.adminCountUnitPeople)}
          </Text>
        }
      >
        <ReportRows reports={item.reports} />
      </Block>
      <Block title={copy.adminModerationItemActions} testId="moderation-item-actions">
        <ActionRows actions={item.actions} onOpen={onOpen} />
      </Block>
      <Block title={copy.adminModerationRevisions} testId="moderation-revisions">
        {revisions}
      </Block>
      <Block title={copy.adminModerationMemberActions} testId="moderation-author-actions">
        <ActionRows actions={item.authorActions} onOpen={onOpen} />
      </Block>
    </>
  );
}

function Page({
  query,
  children,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => Promise<unknown> };
  children: () => ReactNode;
}) {
  if (query.isPending) return <Skeleton height="48" />;
  if (query.isError) {
    return (
      <LoadFailedNotice
        notFound={isApiError(query.error, 'NOT_FOUND')}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return <>{children()}</>;
}

export function PostModeration({ postId }: { postId: string }) {
  const query = useAdminPostModeration(postId);
  // Held for the admin on screen: a dialog opened on A's page is not B's to send (ADR-0091).
  const [dialog, setDialog] = useHeldForOperator<DialogSpec>();
  return (
    <Stack gap="5" data-testid="admin-post-moderation">
      <BackLink />
      <Page query={query}>
        {() => {
          const post = query.data;
          if (post === undefined) return null;
          return <PostView post={post} onOpen={setDialog} />;
        }}
      </Page>
      {dialog !== null && <ModerationDialog spec={dialog} onClose={() => setDialog(null)} />}
    </Stack>
  );
}

function PostView({
  post,
  onOpen,
}: {
  post: AdminPostModeration;
  onOpen: (spec: DialogSpec) => void;
}) {
  const hide =
    post.state === 'published'
      ? {
          label: copy.adminModerationHidePost,
          spec: {
            kind: 'action',
            title: copy.adminModerationHidePostTitle,
            body: copy.adminModerationHideBody,
            success: copy.adminModerationHidden,
            testId: 'moderation-hide-dialog',
            build: ({ reason, note, expectedAccountId }) => ({
              kind: 'hide-post',
              postId: post.id,
              body: { reason, note, expectedAccountId },
            }),
          } satisfies DialogSpec,
        }
      : null;
  return (
    <Stack gap="5">
      <HStack gap="2" flexWrap="wrap">
        <Heading as="h3" size="lg">
          {copy.adminModerationPost}
        </Heading>
        <StateBadge state={post.state} />
      </HStack>
      <Stack gap="1">
        <Line label={copy.adminModerationAuthor}>
          <UserName user={post.author} />
        </Line>
        <Line label={copy.adminModerationMarket}>
          <ChakraLink asChild color="brand.fg">
            <NextLink href={`/markets/${post.market.slug}` as Route}>{post.market.title}</NextLink>
          </ChakraLink>
        </Line>
        <Times item={post} />
      </Stack>
      <ActionBar
        author={post.author}
        reports={post.reports}
        hide={hide}
        warnSubject={{ type: 'post', postId: post.id }}
        onOpen={onOpen}
      />
      <Block
        title={copy.adminModerationContent}
        testId="moderation-content"
        aside={
          post.state !== 'gone' ? (
            <ChakraLink asChild fontSize="sm" color="brand.fg">
              <NextLink href={postPath(post.id) as Route}>
                {copy.adminModerationOpenPublic}
              </NextLink>
            </ChakraLink>
          ) : undefined
        }
      >
        {post.purgedAt !== null ? (
          <PurgedNotice />
        ) : (
          <Stack gap="3">
            <Text fontWeight="semibold" wordBreak="break-word" data-testid="moderation-post-title">
              {post.title ?? copy.adminModerationUntitled}
            </Text>
            <PostBody document={post.body} imageSrc={adminMediaPath} headingFrom={5} />
          </Stack>
        )}
      </Block>
      <RecordBlocks
        item={post}
        onOpen={onOpen}
        revisions={
          post.revisions.length === 0 ? (
            <Text fontSize="sm" color="fg.muted">
              {copy.adminModerationNone}
            </Text>
          ) : (
            <Stack as="ol" gap="3" listStyleType="none">
              {post.revisions.map((revision) => (
                <Stack as="li" key={revision.id} gap="2" borderWidth="1px" borderRadius="l2" p="3">
                  <Text fontSize="xs" color="fg.muted">
                    {`${copy.adminModerationRevisionWrittenAt} ${formatKst(revision.writtenAt)} · ${copy.adminModerationRevisionReplacedAt} ${formatKst(revision.replacedAt)}`}
                  </Text>
                  <Text fontWeight="semibold">
                    {revision.title ?? copy.adminModerationUntitled}
                  </Text>
                  <PostBody document={revision.body} imageSrc={adminMediaPath} headingFrom={5} />
                </Stack>
              ))}
            </Stack>
          )
        }
      />
      <Block title={copy.adminModerationComments} testId="moderation-comments-block">
        <CommentRows comments={post.comments} />
      </Block>
    </Stack>
  );
}

export function CommentModeration({ commentId }: { commentId: string }) {
  const query = useAdminCommentModeration(commentId);
  // Held for the admin on screen: a dialog opened on A's page is not B's to send (ADR-0091).
  const [dialog, setDialog] = useHeldForOperator<DialogSpec>();
  return (
    <Stack gap="5" data-testid="admin-comment-moderation">
      <BackLink />
      <Page query={query}>
        {() => {
          const comment = query.data;
          if (comment === undefined) return null;
          return <CommentView comment={comment} onOpen={setDialog} />;
        }}
      </Page>
      {dialog !== null && <ModerationDialog spec={dialog} onClose={() => setDialog(null)} />}
    </Stack>
  );
}

function CommentView({
  comment,
  onOpen,
}: {
  comment: AdminCommentModeration;
  onOpen: (spec: DialogSpec) => void;
}) {
  const hide =
    comment.state === 'published'
      ? {
          label: copy.adminModerationHideComment,
          spec: {
            kind: 'action',
            title: copy.adminModerationHideCommentTitle,
            body: copy.adminModerationHideBody,
            success: copy.adminModerationHidden,
            testId: 'moderation-hide-dialog',
            build: ({ reason, note, expectedAccountId }) => ({
              kind: 'hide-comment',
              commentId: comment.id,
              body: { reason, note, expectedAccountId },
            }),
          } satisfies DialogSpec,
        }
      : null;
  return (
    <Stack gap="5">
      <HStack gap="2" flexWrap="wrap">
        <Heading as="h3" size="lg">
          {comment.parentId === null ? copy.authoredCommentKind : copy.authoredReplyKind}
        </Heading>
        <StateBadge state={comment.state} />
      </HStack>
      <Stack gap="1">
        <Line label={copy.adminModerationAuthor}>
          <UserName user={comment.author} />
        </Line>
        <Line label={copy.adminModerationPost}>
          <HStack as="span" gap="2" display="inline-flex" flexWrap="wrap">
            <ChakraLink asChild color="brand.fg">
              <NextLink href={adminPostModerationPath(comment.post.id) as Route}>
                {comment.post.title ?? copy.adminModerationUntitled}
              </NextLink>
            </ChakraLink>
            {comment.post.state !== 'published' && (
              <StateBadge state={comment.post.state} testId="moderation-post-state" />
            )}
          </HStack>
        </Line>
        <Times item={comment} />
      </Stack>
      <ActionBar
        author={comment.author}
        reports={comment.reports}
        hide={hide}
        warnSubject={{ type: 'comment', commentId: comment.id }}
        onOpen={onOpen}
      />
      <Block
        title={copy.adminModerationContent}
        testId="moderation-content"
        aside={
          comment.state !== 'gone' && comment.post.state !== 'gone' ? (
            <ChakraLink asChild fontSize="sm" color="brand.fg">
              <NextLink href={postPath(comment.post.id) as Route}>
                {copy.adminModerationOpenPublic}
              </NextLink>
            </ChakraLink>
          ) : undefined
        }
      >
        {comment.purgedAt !== null ? (
          <PurgedNotice />
        ) : (
          <Box whiteSpace="pre-wrap" wordBreak="break-word" data-testid="moderation-comment-body">
            {comment.body}
          </Box>
        )}
      </Block>
      <RecordBlocks
        item={comment}
        onOpen={onOpen}
        revisions={
          comment.revisions.length === 0 ? (
            <Text fontSize="sm" color="fg.muted">
              {copy.adminModerationNone}
            </Text>
          ) : (
            <Stack as="ol" gap="3" listStyleType="none">
              {comment.revisions.map((revision) => (
                <Stack as="li" key={revision.id} gap="1" borderWidth="1px" borderRadius="l2" p="3">
                  <Text fontSize="xs" color="fg.muted">
                    {`${copy.adminModerationRevisionWrittenAt} ${formatKst(revision.writtenAt)} · ${copy.adminModerationRevisionReplacedAt} ${formatKst(revision.replacedAt)}`}
                  </Text>
                  <Box whiteSpace="pre-wrap" wordBreak="break-word" fontSize="sm">
                    {revision.body}
                  </Box>
                </Stack>
              ))}
            </Stack>
          )
        }
      />
    </Stack>
  );
}
