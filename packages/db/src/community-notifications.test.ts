import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import {
  MODERATION_ACTION_TYPES,
  NOTIFICATION_DEFINITIONS,
  PROPOSAL_QUESTION_MAX,
  PROPOSAL_STATUSES,
  RESTRICTION_ACTION_TYPES,
  notificationTargetSchema,
  type ModerationActionType,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  commentEventKey,
  moderationActionNotificationInput,
  moderationCancelNotificationInput,
  proposalDecisionNotificationInput,
  proposalEventKey,
  replyNotificationInput,
  restrictionEndChangeEventKey,
  restrictionEndChangeNotificationInput,
} from './community-notifications.js';
import {
  createNotifications,
  markNotificationRead,
  notifiedUserIds,
  type NotificationInput,
  type NotificationOutcome,
} from './notifications.js';
import { moderationActionEventKey } from './order-notifications.js';
import {
  notificationKeys,
  notifications,
  postComments,
  restrictionEndChanges,
} from './schema/index.js';
import {
  closeAccount,
  createComment,
  createMarket,
  createMarketMakerAccount,
  createModerationAction,
  createPost,
  createProposal,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';

/*
 * 커뮤니티 알림 (#135, ADR-0161): the five builders (pure), their inputs through the real write
 * path with real rows (the factories write the rows only and never notify), and the static pins of
 * who tells of a reply, an action, its cancellation, a restriction's end change or a proposal's
 * decision, and who never does (52-7, 52-15~52-19, 135-1~135-7).
 */

const AT = new Date('2026-11-22T04:00:00.000Z');
const LATER = new Date('2026-11-22T04:00:00.001Z');
const END = new Date('2026-11-29T04:00:00.000Z');
const POST = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const COMMENT = '6fa459ea-ee8a-3ca4-894e-db77e160355e';
const REPLY = '9b2f1c6e-1d4a-4c7b-8e3f-2a5d6c7b8e9f';
const ACTION = '0c9d8e7f-6a5b-4c3d-9e1f-0a1b2c3d4e5f';
const CHANGE = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a';
const PROPOSAL = '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b';
const OTHERS = MODERATION_ACTION_TYPES.filter(
  (type) => !(RESTRICTION_ACTION_TYPES as readonly string[]).includes(type),
);

/** The input as the write path would check it: its definition's params and a target it leads to. */
function expectAccepted(input: NotificationInput): void {
  const definition = NOTIFICATION_DEFINITIONS.find((d) => d.type === input.type);
  expect(definition, input.type).toBeDefined();
  expect(definition!.params.parse(input.params), input.type).toEqual(input.params);
  expect(notificationTargetSchema.parse(input.target), input.type).toEqual(input.target);
  expect(definition!.targets as readonly string[], input.type).toContain(input.target.kind);
  expect(input.mergeKey !== undefined, input.type).toBe(definition!.merge !== null);
}

describe('the builders (pure, #135)', () => {
  it('keys a reply, a restriction’s end change and a proposal; an action keeps #134’s key', () => {
    expect(commentEventKey(REPLY)).toBe(`comment:${REPLY}`);
    expect(restrictionEndChangeEventKey(CHANGE)).toBe(`restriction_end_change:${CHANGE}`);
    expect(proposalEventKey(PROPOSAL)).toBe(`proposal:${PROPOSAL}`);
    expect(moderationActionEventKey(ACTION)).toBe(`moderation_action:${ACTION}`);
  });

  it('replyNotificationInput: a 댓글 to the post’s author, merged by the post, at the reply’s time (R1, 52-18)', () => {
    const input = replyNotificationInput(
      { id: REPLY, createdAt: AT, authorId: 'user-writer' },
      { kind: 'post', postId: POST, authorId: 'user-author' },
    );
    expect(input).toEqual({
      userId: 'user-author',
      type: 'post_replied',
      eventKey: `comment:${REPLY}`,
      occurredAt: AT,
      mergeKey: POST,
      target: { kind: 'post', postId: POST },
      params: { replyId: REPLY, replyCreatedAt: '2026-11-22T04:00:00.000Z' },
    });
    expectAccepted(input!);
  });

  it('replyNotificationInput: a 대댓글 to the thread 댓글’s author, merged by that 댓글 — never by the reply (R2, 52-18)', () => {
    const input = replyNotificationInput(
      { id: REPLY, createdAt: LATER, authorId: 'user-writer' },
      { kind: 'comment', postId: POST, commentId: COMMENT, authorId: 'user-thread' },
    );
    expect(input).toEqual({
      userId: 'user-thread',
      type: 'comment_replied',
      eventKey: `comment:${REPLY}`,
      occurredAt: LATER,
      mergeKey: COMMENT,
      target: { kind: 'comment', postId: POST, commentId: COMMENT },
      params: { replyId: REPLY, replyCreatedAt: '2026-11-22T04:00:00.001Z' },
    });
    expectAccepted(input!);
  });

  it('replyNotificationInput: nothing for a self-reply — on one’s own post or in one’s own thread (135-3)', () => {
    const reply = { id: REPLY, createdAt: AT, authorId: 'user-a' };
    expect(replyNotificationInput(reply, { kind: 'post', postId: POST, authorId: 'user-a' })).toBe(
      null,
    );
    // Also when it answers someone else's 대댓글 in one's own thread: the thread's author is the
    // recipient (52-18), and that is the writer.
    expect(
      replyNotificationInput(reply, {
        kind: 'comment',
        postId: POST,
        commentId: COMMENT,
        authorId: 'user-a',
      }),
    ).toBe(null);
  });

  it('moderationActionNotificationInput: any of the seven to the member acted on, kind and a restriction’s own end (M1–M7, A1; 135-2, 135-6)', () => {
    for (const type of MODERATION_ACTION_TYPES) {
      const input = moderationActionNotificationInput({
        id: ACTION,
        type,
        userId: 'user-member',
        endsAt: null,
        createdAt: AT,
      });
      expect(input, type).toEqual({
        userId: 'user-member',
        type: 'moderation_action_taken',
        eventKey: `moderation_action:${ACTION}`,
        occurredAt: AT,
        target: { kind: 'moderation_action', actionId: ACTION },
        params: { action: type, endsAt: null },
      });
      expectAccepted(input);
    }
    for (const type of RESTRICTION_ACTION_TYPES) {
      const input = moderationActionNotificationInput({
        id: ACTION,
        type,
        userId: 'user-member',
        endsAt: END,
        createdAt: AT,
      });
      expect(input.params).toEqual({ action: type, endsAt: END.toISOString() });
      expectAccepted(input);
    }
  });

  it('moderationActionNotificationInput: throws on an end of anything but a restriction and on an unknown type, naming no account', () => {
    const builds: [string, () => unknown][] = [
      ...OTHERS.map(
        (type) =>
          [
            type,
            () =>
              moderationActionNotificationInput({
                id: ACTION,
                type,
                userId: 'user-member',
                endsAt: END,
                createdAt: AT,
              }),
          ] as [string, () => unknown],
      ),
      [
        'dismiss',
        () =>
          moderationActionNotificationInput({
            id: ACTION,
            type: 'dismiss',
            userId: 'user-member',
            endsAt: null,
            createdAt: AT,
          }),
      ],
    ];
    for (const [label, build] of builds) {
      expect(build, label).toThrow(/^community notice: /);
      expect(build, label).not.toThrow(/user-/);
    }
  });

  it('moderationCancelNotificationInput: the cancelled action’s kind under its own type and the action’s key (M8, A2; 53-4)', () => {
    for (const type of MODERATION_ACTION_TYPES) {
      const input = moderationCancelNotificationInput(
        { id: ACTION, type, userId: 'user-member' },
        LATER,
      );
      expect(input, type).toEqual({
        userId: 'user-member',
        type: 'moderation_action_cancelled',
        eventKey: `moderation_action:${ACTION}`,
        occurredAt: LATER,
        target: { kind: 'moderation_action', actionId: ACTION },
        params: { action: type },
      });
      expectAccepted(input);
    }
    const build = () =>
      moderationCancelNotificationInput({ id: ACTION, type: 'report', userId: 'user-m' }, AT);
    expect(build).toThrow(/^community notice: /);
    expect(build).not.toThrow(/user-/);
  });

  it('restrictionEndChangeNotificationInput: a 감경 with its new end, a 조기 해제 at its instant, keyed by the change, to the action (M9, A3; 135-5 (h))', () => {
    for (const type of RESTRICTION_ACTION_TYPES) {
      const action = { id: ACTION, type, userId: 'user-member' };
      const shorten = restrictionEndChangeNotificationInput(
        { id: CHANGE, kind: 'shorten', endsAt: END, createdAt: AT },
        action,
      );
      expect(shorten).toEqual({
        userId: 'user-member',
        type: 'moderation_restriction_end_changed',
        eventKey: `restriction_end_change:${CHANGE}`,
        occurredAt: AT,
        target: { kind: 'moderation_action', actionId: ACTION },
        params: { action: type, change: 'shorten', endsAt: END.toISOString() },
      });
      expectAccepted(shorten);
      const lift = restrictionEndChangeNotificationInput(
        { id: CHANGE, kind: 'lift', endsAt: AT, createdAt: AT },
        action,
      );
      expect(lift.params).toEqual({ action: type, change: 'lift', endsAt: AT.toISOString() });
      expectAccepted(lift);
    }
  });

  it('restrictionEndChangeNotificationInput: throws on a non-restriction, a lift not at its instant and a shortening not after it, naming no account', () => {
    const change = (kind: string, endsAt: Date, createdAt = AT) =>
      ({ id: CHANGE, kind, endsAt, createdAt }) as Parameters<
        typeof restrictionEndChangeNotificationInput
      >[0];
    const restriction = { id: ACTION, type: 'writing_restriction', userId: 'user-member' };
    const builds: [string, () => unknown][] = [
      ...OTHERS.map(
        (type) =>
          [
            `end change of a ${type}`,
            () =>
              restrictionEndChangeNotificationInput(change('shorten', END), {
                ...restriction,
                type,
              }),
          ] as [string, () => unknown],
      ),
      ['lift later', () => restrictionEndChangeNotificationInput(change('lift', END), restriction)],
      [
        'lift earlier',
        () => restrictionEndChangeNotificationInput(change('lift', AT, LATER), restriction),
      ],
      [
        'shorten to now',
        () => restrictionEndChangeNotificationInput(change('shorten', AT), restriction),
      ],
      [
        'shorten to the past',
        () => restrictionEndChangeNotificationInput(change('shorten', AT, LATER), restriction),
      ],
      ['extend', () => restrictionEndChangeNotificationInput(change('extend', END), restriction)],
    ];
    for (const [label, build] of builds) {
      expect(build, label).toThrow(/^community notice: /);
      expect(build, label).not.toThrow(/user-/);
    }
  });

  it('proposalDecisionNotificationInput: 채택 or 반려 and the proposer’s own question, keyed by the proposal (P1, P2; 52-19)', () => {
    for (const status of ['adopted', 'rejected'] as const) {
      const input = proposalDecisionNotificationInput(
        { id: PROPOSAL, userId: 'user-proposer', question: '첫눈이 서울에 올까?', status },
        AT,
      );
      expect(input).toEqual({
        userId: 'user-proposer',
        type: 'proposal_decided',
        eventKey: `proposal:${PROPOSAL}`,
        occurredAt: AT,
        target: { kind: 'proposal', proposalId: PROPOSAL },
        params: { decision: status, question: '첫눈이 서울에 올까?' },
      });
      expectAccepted(input);
    }
    // The question as stored, whatever it holds: a raw '' or the longest one never refused.
    for (const question of ['', '𝔸'.repeat(PROPOSAL_QUESTION_MAX), '{question} $& $1 $$ {{x}}']) {
      expectAccepted(
        proposalDecisionNotificationInput(
          { id: PROPOSAL, userId: 'user-proposer', question, status: 'adopted' },
          AT,
        ),
      );
    }
    for (const status of PROPOSAL_STATUSES.filter((s) => s !== 'adopted' && s !== 'rejected')) {
      const build = () =>
        proposalDecisionNotificationInput(
          { id: PROPOSAL, userId: 'user-proposer', question: '질문', status },
          AT,
        );
      expect(build, status).toThrow(/^community notice: /);
      expect(build, status).not.toThrow(/user-/);
    }
  });
});

describe.skipIf(!hasTestDb())('커뮤니티 알림 against the test database (#135)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const member = async (role: 'user' | 'admin' = 'user') =>
    (await createUser(t.db, { role })).user.id;
  const rowsOf = (userId: string) =>
    t.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(asc(notifications.type), asc(notifications.createdAt), asc(notifications.id));
  const keysOf = async (userId: string) =>
    (
      await t.db
        .select({ type: notificationKeys.type, eventKey: notificationKeys.eventKey })
        .from(notificationKeys)
        .where(eq(notificationKeys.userId, userId))
        .orderBy(asc(notificationKeys.type), asc(notificationKeys.eventKey))
    ).map((key) => `${key.type} ${key.eventKey}`);
  const deliver = (inputs: readonly (NotificationInput | null)[]) =>
    t.db.transaction((tx) =>
      createNotifications(
        tx,
        inputs.filter((input): input is NotificationInput => input !== null),
      ),
    );
  const kinds = (outcomes: readonly NotificationOutcome[]) => outcomes.map((o) => o.kind);

  /** A market and a post by `authorId` on it. */
  const postBy = async (authorId: string) => {
    const market = await createMarket(t.db);
    return createPost(t.db, { marketId: market.id, authorId });
  };
  type Comment = Awaited<ReturnType<typeof createComment>>;
  const onPost = (post: { id: string; authorId: string }) =>
    ({ kind: 'post', postId: post.id, authorId: post.authorId }) as const;
  const onThread = (thread: Comment) =>
    ({
      kind: 'comment',
      postId: thread.postId,
      commentId: thread.id,
      authorId: thread.authorId,
    }) as const;

  describe('replies (52-7, 52-15, 52-18, 135-3, 135-4)', () => {
    it('merges a post’s 댓글 while unread to the later one, in either order, at its time', async () => {
      const [author, b, c] = [await member(), await member(), await member()];
      const first = await postBy(author);
      const second = await postBy(author);
      const replies = async (post: { id: string }) => [
        await createComment(t.db, { postId: post.id, authorId: b, createdAt: AT }),
        await createComment(t.db, { postId: post.id, authorId: c, createdAt: LATER }),
      ];
      const [early1, late1] = await replies(first);
      const [early2, late2] = await replies(second);
      // The first post hears the replies in their order; the second the later one first (a
      // later transaction committing first).
      expect(kinds(await deliver([replyNotificationInput(early1!, onPost(first))]))).toEqual([
        'created',
      ]);
      expect(kinds(await deliver([replyNotificationInput(late1!, onPost(first))]))).toEqual([
        'merged',
      ]);
      expect(kinds(await deliver([replyNotificationInput(late2!, onPost(second))]))).toEqual([
        'created',
      ]);
      expect(kinds(await deliver([replyNotificationInput(early2!, onPost(second))]))).toEqual([
        'merged',
      ]);
      const rows = await rowsOf(author);
      expect(rows).toHaveLength(2);
      for (const [row, post, late] of [
        [rows.find((r) => r.mergeKey === first.id), first, late1],
        [rows.find((r) => r.mergeKey === second.id), second, late2],
      ] as const) {
        expect(row).toMatchObject({
          type: 'post_replied',
          category: 'community',
          eventCount: 2,
          occurredAt: LATER,
          readAt: null,
          target: { kind: 'post', postId: post.id },
          params: { replyId: late!.id, replyCreatedAt: LATER.toISOString() },
        });
      }
      expect(await keysOf(author)).toEqual(
        [early1, early2, late1, late2].map((reply) => `post_replied comment:${reply!.id}`).sort(),
      );
    });

    it('breaks a tie of instants by the larger reply id', async () => {
      const [author, b, c] = [await member(), await member(), await member()];
      const post = await postBy(author);
      const one = await createComment(t.db, { postId: post.id, authorId: b, createdAt: AT });
      const two = await createComment(t.db, { postId: post.id, authorId: c, createdAt: AT });
      const larger = one.id > two.id ? one : two;
      const smaller = larger === one ? two : one;
      await deliver([replyNotificationInput(larger, onPost(post))]);
      await deliver([replyNotificationInput(smaller, onPost(post))]);
      const [row] = await rowsOf(author);
      expect(row).toMatchObject({ eventCount: 2, params: { replyId: larger.id } });
    });

    it('merges a thread’s 대댓글 — one answering a 대댓글 there included — per 댓글, apart from the post’s', async () => {
      const [author, b, c, d] = [await member(), await member(), await member(), await member()];
      const post = await postBy(author);
      const bThread = await createComment(t.db, { postId: post.id, authorId: b, createdAt: AT });
      const bOther = await createComment(t.db, { postId: post.id, authorId: b, createdAt: AT });
      // C answers B's 댓글; D answers C's 대댓글 — a 대댓글 of the same 댓글 (ADR-0074).
      const cReply = await createComment(t.db, {
        postId: post.id,
        authorId: c,
        parentId: bThread.id,
        createdAt: LATER,
      });
      const dReply = await createComment(t.db, {
        postId: post.id,
        authorId: d,
        parentId: bThread.id,
        createdAt: new Date(LATER.getTime() + 1),
      });
      const cOther = await createComment(t.db, {
        postId: post.id,
        authorId: c,
        parentId: bOther.id,
        createdAt: LATER,
      });
      expect(
        kinds(
          await deliver([
            replyNotificationInput(bThread, onPost(post)),
            replyNotificationInput(bOther, onPost(post)),
          ]),
        ).sort(),
      ).toEqual(['created', 'merged']);
      for (const reply of [cReply, dReply, cOther]) {
        await deliver([
          replyNotificationInput(reply, onThread(reply === cOther ? bOther : bThread)),
        ]);
      }
      expect(
        (await rowsOf(b)).map((row) => [row.type, row.mergeKey, row.eventCount, row.params]),
      ).toEqual(
        expect.arrayContaining([
          [
            'comment_replied',
            bThread.id,
            2,
            { replyId: dReply.id, replyCreatedAt: dReply.createdAt.toISOString() },
          ],
          [
            'comment_replied',
            bOther.id,
            1,
            { replyId: cOther.id, replyCreatedAt: cOther.createdAt.toISOString() },
          ],
        ]),
      );
      expect(await rowsOf(b)).toHaveLength(2);
      // The post's author hears the two 댓글 (one merged row) and none of the 대댓글 (52-18).
      expect((await rowsOf(author)).map((row) => [row.type, row.eventCount])).toEqual([
        ['post_replied', 2],
      ]);
      expect(await rowsOf(c)).toEqual([]);
    });

    it('writes nothing for a self-reply: no row, no key, no signal (135-3)', async () => {
      const [author, b] = [await member(), await member()];
      const post = await postBy(author);
      const own = await createComment(t.db, { postId: post.id, authorId: author });
      const thread = await createComment(t.db, { postId: post.id, authorId: b });
      const ownInThread = await createComment(t.db, {
        postId: post.id,
        authorId: b,
        parentId: thread.id,
      });
      const outcomes = await deliver([
        replyNotificationInput(own, onPost(post)),
        replyNotificationInput(ownInThread, onThread(thread)),
      ]);
      expect(outcomes).toEqual([]);
      expect(notifiedUserIds(outcomes)).toEqual([]);
      expect(await rowsOf(author)).toEqual([]);
      expect(await rowsOf(b)).toEqual([]);
    });

    it('starts a new notice after the held one is read; a reply reprocessed is a duplicate', async () => {
      const [author, b, c] = [await member(), await member(), await member()];
      const post = await postBy(author);
      const first = await createComment(t.db, { postId: post.id, authorId: b, createdAt: AT });
      const next = await createComment(t.db, { postId: post.id, authorId: c, createdAt: LATER });
      const [created] = await deliver([replyNotificationInput(first, onPost(post))]);
      expect(kinds(await deliver([replyNotificationInput(first, onPost(post))]))).toEqual([
        'duplicate',
      ]);
      await t.db.transaction((tx) =>
        markNotificationRead(tx, author, (created as { id: string }).id),
      );
      const [again] = await deliver([replyNotificationInput(next, onPost(post))]);
      expect(again!.kind).toBe('created');
      // The read row kept its reply; the new one holds the next (rows by creation).
      expect(
        (await rowsOf(author)).map((row) => [row.eventCount, row.readAt === null, row.params]),
      ).toEqual([
        [1, false, { replyId: first.id, replyCreatedAt: AT.toISOString() }],
        [1, true, { replyId: next.id, replyCreatedAt: LATER.toISOString() }],
      ]);
      // Reprocessing the first reply after its row was read is still that reply's duplicate.
      expect(kinds(await deliver([replyNotificationInput(first, onPost(post))]))).toEqual([
        'duplicate',
      ]);
    });

    it('two concurrent replies to one post end as one row of two', async () => {
      const [author, b, c] = [await member(), await member(), await member()];
      const post = await postBy(author);
      const one = await createComment(t.db, { postId: post.id, authorId: b, createdAt: AT });
      const two = await createComment(t.db, { postId: post.id, authorId: c, createdAt: LATER });
      const outcomes = await Promise.all([
        deliver([replyNotificationInput(one, onPost(post))]),
        deliver([replyNotificationInput(two, onPost(post))]),
      ]);
      expect(
        outcomes
          .flat()
          .map((o) => o.kind)
          .sort(),
      ).toEqual(['created', 'merged']);
      const [row, ...rest] = await rowsOf(author);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        eventCount: 2,
        occurredAt: LATER,
        params: { replyId: two.id, replyCreatedAt: LATER.toISOString() },
      });
    });

    it('keeps the notice when its reply is hidden or deleted afterwards (135-4)', async () => {
      const [author, b] = [await member(), await member()];
      const post = await postBy(author);
      const reply = await createComment(t.db, { postId: post.id, authorId: b });
      await deliver([replyNotificationInput(reply, onPost(post))]);
      const before = await rowsOf(author);
      await t.db
        .update(postComments)
        .set({ hiddenAt: new Date() })
        .where(eq(postComments.id, reply.id));
      expect(await rowsOf(author)).toEqual(before);
      await t.db
        .update(postComments)
        .set({ deletedAt: new Date() })
        .where(eq(postComments.id, reply.id));
      expect(await rowsOf(author)).toEqual(before);
    });
  });

  describe('moderation (52-16, 53-4, 135-2)', () => {
    it('tells an action and its cancellation under one key as two notices; each reprocessed is a duplicate', async () => {
      const [admin, target] = [await member('admin'), await member()];
      const action = await createModerationAction(t.db, {
        userId: target,
        createdBy: admin,
        type: 'warning',
        createdAt: AT,
      });
      expect(kinds(await deliver([moderationActionNotificationInput(action)]))).toEqual([
        'created',
      ]);
      expect(kinds(await deliver([moderationCancelNotificationInput(action, LATER)]))).toEqual([
        'created',
      ]);
      expect(
        kinds(
          await deliver([
            moderationActionNotificationInput(action),
            moderationCancelNotificationInput(action, LATER),
          ]),
        ),
      ).toEqual(['duplicate', 'duplicate']);
      const rows = await rowsOf(target);
      expect(
        rows.map((row) => [row.type, row.category, row.occurredAt, row.target, row.params]),
      ).toEqual([
        [
          'moderation_action_cancelled',
          'community',
          LATER,
          { kind: 'moderation_action', actionId: action.id },
          { action: 'warning' },
        ],
        [
          'moderation_action_taken',
          'community',
          AT,
          { kind: 'moderation_action', actionId: action.id },
          { action: 'warning', endsAt: null },
        ],
      ]);
      expect(await keysOf(target)).toEqual([
        `moderation_action_cancelled moderation_action:${action.id}`,
        `moderation_action_taken moderation_action:${action.id}`,
      ]);
      // The admin who acted, the reason and the note are nowhere in what the member keeps.
      const stored = JSON.stringify(rows);
      expect(stored).not.toContain(admin);
      expect(stored).not.toContain('spam');
    });

    it('tells two end changes of one restriction as two notices, each with its new end (135-5 (h))', async () => {
      const [admin, target] = [await member('admin'), await member()];
      const action = await createModerationAction(t.db, {
        userId: target,
        createdBy: admin,
        type: 'writing_restriction',
        createdAt: AT,
        endsAt: END,
      });
      const shortenedTo = new Date(END.getTime() - 86_400_000);
      const shortenedAt = new Date(AT.getTime() + 3_600_000);
      const liftedAt = new Date(AT.getTime() + 7_200_000);
      const changes = await t.db
        .insert(restrictionEndChanges)
        .values([
          {
            actionId: action.id,
            kind: 'shorten',
            previousEndsAt: END,
            endsAt: shortenedTo,
            reason: '감경 사유',
            createdBy: admin,
            createdAt: shortenedAt,
          },
          {
            actionId: action.id,
            kind: 'lift',
            previousEndsAt: shortenedTo,
            endsAt: liftedAt,
            reason: '해제 사유',
            createdBy: admin,
            createdAt: liftedAt,
          },
        ])
        .returning();
      await deliver([moderationActionNotificationInput(action)]);
      for (const change of changes) {
        expect(
          kinds(
            await deliver([
              restrictionEndChangeNotificationInput(
                {
                  id: change.id,
                  kind: change.kind as 'shorten' | 'lift',
                  endsAt: change.endsAt,
                  createdAt: change.createdAt,
                },
                action,
              ),
            ]),
          ),
        ).toEqual(['created']);
      }
      const rows = (await rowsOf(target)).filter(
        (row) => row.type === 'moderation_restriction_end_changed',
      );
      expect(
        rows
          .map((row) => [row.occurredAt.getTime(), row.target, row.params])
          .sort((a, b) => (a[0] as number) - (b[0] as number)),
      ).toEqual([
        [
          shortenedAt.getTime(),
          { kind: 'moderation_action', actionId: action.id },
          { action: 'writing_restriction', change: 'shorten', endsAt: shortenedTo.toISOString() },
        ],
        [
          liftedAt.getTime(),
          { kind: 'moderation_action', actionId: action.id },
          { action: 'writing_restriction', change: 'lift', endsAt: liftedAt.toISOString() },
        ],
      ]);
      const taken = (await rowsOf(target)).find((row) => row.type === 'moderation_action_taken');
      expect(taken?.params).toEqual({ action: 'writing_restriction', endsAt: END.toISOString() });
      const stored = JSON.stringify(await rowsOf(target));
      for (const hidden of [admin, '감경 사유', '해제 사유']) expect(stored).not.toContain(hidden);
    });

    it('joins #134’s orders_cancelled in an account restriction’s one call: two types under one key (A1, ADR-0158 결과 6)', async () => {
      const [admin, approver, target] = [
        await member('admin'),
        await member('admin'),
        await member(),
      ];
      const action = await createModerationAction(t.db, {
        userId: target,
        createdBy: admin,
        approvedBy: approver,
        type: 'account_restriction',
        reason: 'abnormal_trading',
        createdAt: AT,
        endsAt: null,
      });
      const ordersCancelled: NotificationInput = {
        userId: target,
        type: 'orders_cancelled',
        eventKey: moderationActionEventKey(action.id),
        occurredAt: AT,
        target: { kind: 'order_history', marketId: null },
        params: { reason: 'restricted', orderCount: 2, marketCount: 2, marketTitle: null },
      };
      const outcomes = await deliver([ordersCancelled, moderationActionNotificationInput(action)]);
      expect(kinds(outcomes)).toEqual(['created', 'created']);
      // One signal however many types reached the member.
      expect(notifiedUserIds(outcomes)).toEqual([target]);
      expect((await rowsOf(target)).map((row) => [row.type, row.params])).toEqual([
        ['moderation_action_taken', { action: 'account_restriction', endsAt: null }],
        ['orders_cancelled', ordersCancelled.params],
      ]);
    });

    it('reaches admins and restricted members; skips a closed account and the 운영 마켓메이커 (53-5, 53-6)', async () => {
      const [admin, otherAdmin, restricted, closed] = [
        await member('admin'),
        await member('admin'),
        await member(),
        await member(),
      ];
      await createModerationAction(t.db, {
        userId: restricted,
        createdBy: admin,
        type: 'writing_restriction',
        endsAt: null,
      });
      await closeAccount(t.db, closed);
      const bot = await createMarketMakerAccount(t.db);
      const action = (userId: string) => ({
        id: randomUUID(),
        type: 'warning' as ModerationActionType,
        userId,
        endsAt: null,
        createdAt: AT,
      });
      const outcomes = await deliver(
        [otherAdmin, restricted, closed, bot].map((userId) =>
          moderationActionNotificationInput(action(userId)),
        ),
      );
      const byUser = new Map(outcomes.map((o) => [o.userId, o.kind]));
      expect(byUser.get(otherAdmin)).toBe('created');
      expect(byUser.get(restricted)).toBe('created');
      expect(byUser.get(closed)).toBe('skipped');
      expect(byUser.get(bot)).toBe('skipped');
      expect(notifiedUserIds(outcomes).sort()).toEqual([otherAdmin, restricted].sort());
    });
  });

  describe('proposals (52-19)', () => {
    it('tells 채택 and 반려 to the proposer with the question, at the decision; a reprocess is a duplicate', async () => {
      const proposer = await member();
      const adopted = await createProposal(t.db, {
        userId: proposer,
        status: 'adopted',
        question: '첫눈이 서울에 올까?',
        decidedAt: AT,
      });
      const rejected = await createProposal(t.db, {
        userId: proposer,
        status: 'rejected',
        question: '𝔸'.repeat(PROPOSAL_QUESTION_MAX),
        decidedAt: LATER,
        rejectionExplanation: '반려 설명',
      });
      const inputs = [adopted, rejected].map((proposal) =>
        proposalDecisionNotificationInput(proposal, proposal.decidedAt!),
      );
      expect(kinds(await deliver(inputs))).toEqual(['created', 'created']);
      expect(kinds(await deliver(inputs))).toEqual(['duplicate', 'duplicate']);
      const rows = await rowsOf(proposer);
      expect(
        rows
          .map((row) => [row.occurredAt, row.target, row.params])
          .sort((a, b) => (a[0] as Date).getTime() - (b[0] as Date).getTime()),
      ).toEqual([
        [
          AT,
          { kind: 'proposal', proposalId: adopted.id },
          { decision: 'adopted', question: '첫눈이 서울에 올까?' },
        ],
        [
          LATER,
          { kind: 'proposal', proposalId: rejected.id },
          { decision: 'rejected', question: '𝔸'.repeat(PROPOSAL_QUESTION_MAX) },
        ],
      ]);
      expect(JSON.stringify(rows)).not.toContain('반려 설명');
    });
  });
});

// ---- static -------------------------------------------------------------------------------------

const ROOT = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

/**
 * Every production source of every app and package (judgement-notifications.test.ts's scan),
 * relative to the repository root: no test, and no fixture under `packages/db/src/test/`.
 */
function sourceFiles(): string[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(new URL(`${group}/`, ROOT), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const src = `${group}/${entry.name}/src`;
        let files: string[];
        try {
          files = readdirSync(new URL(`${src}/`, ROOT), { recursive: true, encoding: 'utf8' });
        } catch {
          return [];
        }
        return files
          .map((file) => file.replaceAll('\\', '/'))
          .filter((file) => /\.(ts|tsx|mts)$/.test(file) && !/\.test\.tsx?$/.test(file))
          .map((file) => `${src}/${file}`)
          .filter((file) => !file.startsWith('packages/db/src/test/'));
      }),
  );
}

/** A drizzle write (`.insert(` / `.update(`) of a table, by its import or through `schema.`. */
const writeOf = (table: string, verbs = 'insert|update') =>
  new RegExp(`\\.(?:${verbs})\\(\\s*(?:schema\\.)?${table}\\b`);
/** A CALL of a builder, not its definition. */
const callOf = (name: string) => new RegExp(`(?<!function\\s+)\\b${name}\\(`);

const WRITES = /\bcreateNotifications\(/;
const BUILDS_REPLY = callOf('replyNotificationInput');
const BUILDS_ACTION = callOf('moderationActionNotificationInput');
const BUILDS_CANCEL = callOf('moderationCancelNotificationInput');
const BUILDS_END_CHANGE = callOf('restrictionEndChangeNotificationInput');
const BUILDS_PROPOSAL = callOf('proposalDecisionNotificationInput');
const BUILDERS = [
  BUILDS_REPLY,
  BUILDS_ACTION,
  BUILDS_CANCEL,
  BUILDS_END_CHANGE,
  BUILDS_PROPOSAL,
] as const;
const buildsAny = (source: string) => BUILDERS.some((pattern) => pattern.test(source));

const COMMENTS = 'apps/api/src/comments/comments.service.ts';
const MODERATION = 'apps/api/src/moderation/moderation.service.ts';
const ACCOUNT_RESTRICTIONS = 'apps/api/src/moderation/account-restrictions.service.ts';
const ADMIN_PROPOSALS = 'apps/api/src/proposals/admin-proposals.service.ts';

/** The four tables whose writes are #135's events (or touch them), and the decision's status. */
const TABLES = ['postComments', 'moderationActions', 'restrictionEndChanges', 'marketProposals'];
const WRITES_ANY_TABLE = TABLES.map((table) => writeOf(table));
const DECIDES_PROPOSAL = /\bstatus:\s*'(?:adopted|rejected)'/;

/**
 * Each #135 event's writing statement, the production files that run it and what each holds: the
 * builder of its notice and the transaction's one `createNotifications` call. A new writer fails
 * the pin until it is listed (and builds); a stale one fails too.
 */
const EVENTS: Record<
  string,
  { writes: (source: string) => boolean; files: readonly string[]; holds: readonly RegExp[] }
> = {
  'R1/R2 a 댓글 or a 대댓글 — insert into post_comments (52-18)': {
    writes: (source) => writeOf('postComments', 'insert').test(source),
    files: [COMMENTS],
    holds: [BUILDS_REPLY, WRITES],
  },
  'M1–M7/A1 an action — insert into moderation_actions (52-16)': {
    writes: (source) => writeOf('moderationActions', 'insert').test(source),
    files: [ACCOUNT_RESTRICTIONS, MODERATION],
    holds: [BUILDS_ACTION, WRITES],
  },
  'M8/A2 a cancellation (and M9/A3 the new end) — update of moderation_actions (52-16)': {
    writes: (source) => writeOf('moderationActions', 'update').test(source),
    files: [ACCOUNT_RESTRICTIONS, MODERATION],
    holds: [BUILDS_CANCEL, WRITES],
  },
  'M9/A3 a 감경 or 조기 해제 — insert into restriction_end_changes (52-16, 135-5 (h))': {
    writes: (source) => writeOf('restrictionEndChanges', 'insert').test(source),
    files: [ACCOUNT_RESTRICTIONS, MODERATION],
    holds: [BUILDS_END_CHANGE, WRITES],
  },
  'P1/P2 채택·반려 — market_proposals set adopted or rejected (52-19)': {
    writes: (source) =>
      writeOf('marketProposals', 'update').test(source) && DECIDES_PROPOSAL.test(source),
    files: [ADMIN_PROPOSALS],
    holds: [BUILDS_PROPOSAL, WRITES],
  },
};

/**
 * The files that write one of the four tables and tell nothing, with why. The map must equal the
 * matched set minus the building files: a new writer fails until it is listed or builds. The pin
 * is file-level: a silent path inside a building file — `dismiss` (135-1, 52-17), `startReview`,
 * `linkMarket` and the internal memo (52-19 "결론만"), a comment's `update` and `delete` (135-3,
 * 135-4) — is proven silent by that file's API tests (ADR-0160 결정 8's wording).
 */
const SILENT: Record<string, string> = {
  'apps/api/src/proposals/proposals.service.ts':
    'a proposal’s submission and the proposer’s own 철회 — 52-19 tells 채택·반려 only',
  'apps/worker/src/jobs/retention-purge.ts':
    'empties the bodies of purged comments (#184) — no event; its deletes are not matched',
};

describe('who tells of a reply, an action or a proposal’s decision (#135, static)', () => {
  const files = sourceFiles();
  const writersOf = (writes: (source: string) => boolean) =>
    files.filter((file) => writes(read(file))).sort();

  it('reads the source tree and matches writes and calls only', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'packages/db/src/community-notifications.ts',
        COMMENTS,
        MODERATION,
        ACCOUNT_RESTRICTIONS,
        ADMIN_PROPOSALS,
      ]),
    );
    expect(files.some((file) => file.startsWith('packages/db/src/test/'))).toBe(false);
    for (const [pattern, text] of [
      [writeOf('postComments', 'insert'), 'await tx.insert(postComments).values({'],
      [writeOf('postComments'), 'tx\n        .update(schema.postComments)\n'],
      [writeOf('moderationActions', 'update'), 'tx.update(moderationActions).set({ endsAt })'],
      [writeOf('restrictionEndChanges', 'insert'), 'await tx.insert(restrictionEndChanges)'],
      [writeOf('marketProposals', 'update'), '.update( marketProposals )'],
      [BUILDS_REPLY, 'const input = replyNotificationInput(reply, on);'],
      [BUILDS_ACTION, '[moderationActionNotificationInput({ id, type })]'],
      [BUILDS_PROPOSAL, 'proposalDecisionNotificationInput(\n  current,'],
      [DECIDES_PROPOSAL, "set({ status: 'adopted', decidedAt })"],
    ] as const) {
      expect(pattern.test(text), text).toBe(true);
    }
    for (const [pattern, text] of [
      // A delete, a read, a type and another table are not writes of the table.
      [writeOf('restrictionEndChanges'), 'tx.delete(restrictionEndChanges).where('],
      [writeOf('postComments'), '.from(postComments).where('],
      [writeOf('postComments'), 'type PostComment = typeof postComments.$inferSelect;'],
      [writeOf('moderationActions'), '.insert(moderationActionsArchive)'],
      // A definition and an import are not calls.
      [BUILDS_REPLY, 'export function replyNotificationInput(\n  reply: ReplyNoticeReply,'],
      [BUILDS_CANCEL, 'import { moderationCancelNotificationInput } from'],
      [BUILDS_END_CHANGE, '`restrictionEndChangeNotificationInput` to the member'],
      [DECIDES_PROPOSAL, "status: 'reviewing'"],
    ] as const) {
      expect(pattern.test(text), text).toBe(false);
    }
  });

  it('builds and writes the notice in every production writer of a #135 event (R1–R2, M1–M9, A1–A3, P1–P2)', () => {
    const problems: string[] = [];
    for (const [event, spec] of Object.entries(EVENTS)) {
      const writers = writersOf(spec.writes);
      if (JSON.stringify(writers) !== JSON.stringify([...spec.files].sort())) {
        problems.push(`${event}: written by ${writers.join(', ')}`);
      }
      for (const file of writers) {
        for (const pattern of spec.holds) {
          if (!pattern.test(read(file))) problems.push(`${file} (${event}): no ${pattern.source}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('maps every other writer of the four tables with a reason, and proves each silent', () => {
    const matched = files.filter((file) => WRITES_ANY_TABLE.some((p) => p.test(read(file))));
    const building = new Set(Object.values(EVENTS).flatMap((spec) => spec.files));
    expect(matched.filter((file) => !building.has(file)).sort()).toEqual(
      Object.keys(SILENT).sort(),
    );
    for (const [file, reason] of Object.entries(SILENT)) {
      expect(reason.trim(), file).not.toBe('');
      const source = read(file);
      expect(buildsAny(source), `${file} builds a #135 notice`).toBe(false);
      expect(WRITES.test(source), `${file} writes a notification`).toBe(false);
    }
  });

  it('builds the five notices in the four producers only — no reporter, closure or worker path (52-16, 52-17, 135-1)', () => {
    expect(files.filter((file) => buildsAny(read(file))).sort()).toEqual(
      [COMMENTS, MODERATION, ACCOUNT_RESTRICTIONS, ADMIN_PROPOSALS].sort(),
    );
    // Neither writes one of the four tables, so neither is in the silent map: a report's intake
    // is not an action (52-20), a closure's rejection of pending requests changes nothing (#140).
    for (const file of [
      'apps/api/src/moderation/reports.service.ts',
      'apps/api/src/account-closure/account-closure.service.ts',
    ]) {
      expect(files, file).toContain(file);
      expect(buildsAny(read(file)), file).toBe(false);
    }
    // No expiry notice: nothing in the worker builds one (52-16 "기간이 끝나 저절로 풀리는 것은
    // 알리지 않는다").
    const worker = files.filter((file) => file.startsWith('apps/worker/src/'));
    expect(worker.length).toBeGreaterThan(0);
    expect(worker.filter((file) => buildsAny(read(file)))).toEqual([]);
  });

  it('keeps the builders pure: no transaction, no write, no SQL', () => {
    const builders = read('packages/db/src/community-notifications.ts');
    expect(builders).not.toMatch(/\.transaction\(/);
    expect(builders).not.toMatch(/\bcreateNotifications\(/);
    expect(builders).not.toMatch(/\bsql`/);
    expect(builders).not.toMatch(/from 'drizzle-orm'/);
  });
});
