import * as z from 'zod';
import { normaliseCommentBody } from './comment.js';
import { codePointLength } from './post-document.js';
import { publicIdSchema } from './public-id.js';

/**
 * 공개 프로필 (#41). Owner decisions (ADR-0069 decision 3 #37, decision 4 #41 row, decision 5,
 * decision 7): a member's profile lives at `/u/<publicId>` — the public id that never changes, so
 * an old link keeps pointing at the same person after a nickname change (#37-2) — and anyone reads
 * it, signed in or not, while search engines are kept away (#37-1). It shows the nickname (the
 * current one; earlier ones never, #37-3), the image (#141; the nickname's first letter until
 * then), the 소개 (plain text of at most 160 characters, line breaks kept, no links, #37-3), every
 * interest category picked — nothing when none (#37-5) —, the year and month the account joined
 * (#37-3), its post and comment counts and the likes they received (#37-4), and '운영자' on an
 * admin account (#45-9, #37-7: operating rights only). Nothing else of the account is public
 * (#37-8·#37-11·#37-12·#37-13): no balance, order, holding, fill, PnL, watched market, proposal,
 * verification, restriction, email, real name or number — and no score of any kind (N04 §4).
 *
 * The member edits the 소개 and the interest categories in MY 설정 (decision 4 #41), the nickname
 * there too (#58). During a writing or an account restriction (#185, #139) a public item can be
 * cleared — the 소개 emptied, a category dropped, the image deleted — but never set to a new value,
 * and the nickname never changes (#37-9, decision 7). A withdrawn account's profile answers like an
 * unknown one (#37-16, #140).
 */

// ---- the 소개 ------------------------------------------------------------------------------------

/** A 소개's characters at most (#37-3: «평문 160자»), code points as `codePointLength`. */
export const BIO_MAX_LENGTH = 160;

/**
 * A 소개 as it is kept, the way a comment's text is (`normaliseCommentBody`): line breaks as `\n`,
 * a lone UTF-16 surrogate as U+FFFD (so resending the same text changes nothing), the control
 * characters but a tab and a line feed dropped, and the whole trimmed. The lines are kept as written
 * (#37-3: «줄바꿈 허용»). Plain text, so nothing here reads or refuses an address: «링크 없음» is that
 * the profile draws the 소개 as text and never as a link (ADR-0078).
 */
export function normaliseBio(text: string): string {
  return normaliseCommentBody(text);
}

/*
 * The 소개's refusal comes back as a VALIDATION_ERROR naming `bio`, told apart by its message —
 * written and read here (`bioRefusalOf`), as a comment's are, so the web says it in Korean without
 * matching words the server no longer sends.
 */

const BIO_TOO_LONG_HEAD = `at most ${String(BIO_MAX_LENGTH)} characters, not `;

/** More than BIO_MAX_LENGTH characters. */
export function bioTooLongMessage(length: number): string {
  return `${BIO_TOO_LONG_HEAD}${String(length)}`;
}

/** Which refusal a `bio` issue's message is. */
export type BioRefusal = { kind: 'too_long'; length: number };

export function bioRefusalOf(message: string): BioRefusal | undefined {
  if (message.startsWith(BIO_TOO_LONG_HEAD)) {
    const length = Number(message.slice(BIO_TOO_LONG_HEAD.length));
    if (Number.isSafeInteger(length)) return { kind: 'too_long', length };
  }
  return undefined;
}

/**
 * A 소개 as a request sends it: normalised (`normaliseBio`), refused when more than BIO_MAX_LENGTH
 * characters are left (a line break is one), and none — `null` — when nothing is left: sending an
 * empty or blank one, or `null`, clears it.
 */
export const bioInputSchema = z
  .string()
  .overwrite(normaliseBio)
  .superRefine((text, ctx) => {
    const length = codePointLength(text);
    if (length > BIO_MAX_LENGTH) {
      ctx.addIssue({ code: 'custom', message: bioTooLongMessage(length) });
    }
  })
  .nullable()
  .transform((text) => (text ? text : null))
  .describe(
    `Plain text, line breaks kept, at most ${String(BIO_MAX_LENGTH)} characters after trimming; ` +
      'blank or null clears it',
  );

/**
 * `PUT /me/bio`: the 소개 of MY 설정, replacing what it was — `null` or a blank one clears it — and
 * the account the screen shows (`expectedAccountId`, as every owner write since A-PG-24): the
 * cookie decides whose profile is written, and a window still showing account A after another one
 * signed in as B would otherwise put A's words on B's public profile. Both keys are required.
 */
export const updateBioBodySchema = z
  .object({
    bio: bioInputSchema,
    /** The signed-in user id the screen is showing (better-auth `user.id`, text). */
    expectedAccountId: z.string().min(1).max(255),
  })
  .meta({ id: 'UpdateBioBody' });
export type UpdateBioBody = z.input<typeof updateBioBodySchema>;

// ---- the public profile -------------------------------------------------------------------------

/**
 * Who the profile is, as every public answer names a person (ADR-0069 decision 5): exactly the
 * `member` face of PostAuthor — the public id, the CURRENT nickname, the image (#141; null until it
 * has one, and the web draws the nickname's first letter) and the 운영자 mark — so the profile and a
 * post's byline show a person the same way and registry.test.ts holds both to that face. Never the
 * account id. A withdrawn account has no profile (#37-16: 404), so there is no `former_member` here.
 */
export const profileMemberSchema = z
  .object({
    kind: z.literal('member'),
    publicId: publicIdSchema,
    nickname: z.string(),
    imageUrl: z.string().nullable(),
    isAdmin: z.boolean(),
  })
  .meta({ id: 'ProfileMember' });
export type ProfileMember = z.infer<typeof profileMemberSchema>;

/**
 * One interest category on the profile (#37-5), top-level or a sub-category (#57-7), with the
 * top-level one a sub-category sits under — the same name can sit under two — so the profile can
 * say which.
 */
export const profileInterestCategorySchema = z
  .object({
    slug: z.string(),
    nameKo: z.string(),
    /** The top-level category of a sub-category; null for a top-level one. */
    parent: z.object({ slug: z.string(), nameKo: z.string() }).nullable(),
  })
  .meta({ id: 'ProfileInterestCategory' });
export type ProfileInterestCategory = z.infer<typeof profileInterestCategorySchema>;

/** `YYYY-MM`: the month the account joined, nothing finer (#37-3: «연·월»). */
export const JOINED_MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/**
 * One of the profile's counts (#37-4: «글·댓글 수와 받은 좋아요 합계»): a number shown on the profile,
 * never a score, a rank or a skill of the member (N05 §2, D5), and nothing orders by it.
 */
const profileCountSchema = z.number().int().min(0);

/**
 * `GET /profiles/:publicId`: a member's public profile, the same answer for every reader — whether
 * the reader is the member is the web's to tell, from its own `GET /me` (`Me.profile.publicId`), as
 * for a post's author.
 *
 * The counts read what the profile's lists (#51, #37-14) show: the member's posts and comments
 * (대댓글 included) that are neither deleted nor hidden — those of an ended or voided market and
 * those written during a restriction included — and the likes those posts and comments hold
 * (a withdrawn liker's too, #37-17; the likes of a deleted or hidden one never, owner decision
 * 2026-10-20; the member's own on their own never, owner decision 2026-10-21 answer 3).
 */
export const publicProfileSchema = z
  .object({
    member: profileMemberSchema,
    /** The 소개, plain text with its line breaks (never drawn as a link), or null: show nothing. */
    bio: z.string().nullable(),
    /** Every interest category picked, in the category list's order; empty: show nothing. */
    interestCategories: z.array(profileInterestCategorySchema),
    /** The month the account joined, in Korea time (`YYYY-MM`): '2026년 10월 가입'. */
    joinedMonth: z.string().regex(JOINED_MONTH_PATTERN),
    /** The member's posts that are neither deleted nor hidden. */
    postCount: profileCountSchema,
    /** The member's 댓글 and 대댓글 that are neither deleted nor hidden. */
    commentCount: profileCountSchema,
    /**
     * The likes on those posts and comments, together, but those the member pressed on their own:
     * the sum of the counts each shows, less the member's own likes among them.
     */
    receivedLikeCount: profileCountSchema,
  })
  .meta({ id: 'PublicProfile' });
export type PublicProfile = z.infer<typeof publicProfileSchema>;
