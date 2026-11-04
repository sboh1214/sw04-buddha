/**
 * The 운영 마켓메이커 account (#115, ADR-0108; ADR-0107 결정 2 #73 11항) at every community write,
 * against the docker `test` profile: a post, a comment, a like of each, a report and a market
 * proposal are refused it and nothing is written. No request can carry its session (it has no
 * sign-in method, auth.test.ts), so the services are called as their guards would hand them the
 * account: each write's own onboarding check refuses it — it has no profile, so no step is done —
 * before the database's refusal of its rows (schema.test.ts) would be reached. Skips when TEST_*
 * are unset.
 */
import { schema } from '@buddha/db';
import {
  createComment,
  createMarket,
  createMarketMakerAccount,
  createPhoneVerification,
  createPost,
  createUser,
  koreanDateFromToday,
} from '@buddha/db/test';
import { postDocumentInputSchema } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommentsService } from '../comments/comments.service.js';
import { LikesService } from '../likes/likes.service.js';
import { ReportsService } from '../moderation/reports.service.js';
import { PostsService } from '../posts/posts.service.js';
import { ProposalsService } from '../proposals/proposals.service.js';
import { createTestApp, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

describe.skipIf(!hasTestInfra)('the 운영 마켓메이커 account writes nothing public (#115)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
  });

  it('refuses its posts, comments, likes, reports and proposals, writing nothing', async () => {
    const market = await createMarket(t.db);
    const { user: author } = await createUser(t.db);
    const post = await createPost(t.db, { marketId: market.id, authorId: author.id });
    const comment = await createComment(t.db, { postId: post.id, authorId: author.id });
    const marketMaker = await createMarketMakerAccount(t.db);
    // With a 본인확인 record, so that only its missing onboarding can refuse a like or a report.
    await createPhoneVerification(t.db, { userId: marketMaker });

    const posts = t.app.get(PostsService);
    const comments = t.app.get(CommentsService);
    const likes = t.app.get(LikesService);
    const reports = t.app.get(ReportsService);
    const proposals = t.app.get(ProposalsService);
    const content = {
      title: '제목',
      body: postDocumentInputSchema.parse({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '근거' }] }],
      }),
    };
    const report = { reason: 'spam', description: null, expectedAccountId: marketMaker } as const;
    const writes = {
      post: () => posts.create(marketMaker, market.id, content),
      comment: () => comments.create(marketMaker, post.id, null, '댓글'),
      reply: () => comments.create(marketMaker, post.id, comment.id, '대댓글'),
      'post like': () => likes.setPostLike(marketMaker, post.id, true),
      'comment like': () => likes.setCommentLike(marketMaker, comment.id, true),
      'post report': () => reports.reportPost(marketMaker, post.id, report),
      'comment report': () => reports.reportComment(marketMaker, comment.id, report),
      proposal: () =>
        proposals.create(marketMaker, {
          question: '운영 계정의 제안',
          deadline: koreanDateFromToday(30),
          yesCondition: '조건',
          expectedSources: '출처',
          expectedAccountId: marketMaker,
        }),
    };
    for (const [what, write] of Object.entries(writes)) {
      const error: unknown = await write().catch((thrown: unknown) => thrown);
      expect({ what, error }).toMatchObject({
        what,
        error: { code: 'ONBOARDING_REQUIRED', status: 409 },
      });
    }

    expect(await t.db.select().from(schema.posts)).toHaveLength(1); // the author's
    expect(await t.db.select().from(schema.postComments)).toHaveLength(1);
    expect(await t.db.select().from(schema.postLikes)).toEqual([]);
    expect(await t.db.select().from(schema.commentLikes)).toEqual([]);
    expect(await t.db.select().from(schema.reports)).toEqual([]);
    expect(await t.db.select().from(schema.marketProposals)).toEqual([]);
    expect(
      await t.db.select().from(schema.profiles).where(eq(schema.profiles.userId, marketMaker)),
    ).toEqual([]);
  });
});
