import { schema, type Db } from '@buddha/db';
import {
  type AdminProposal,
  type AdminProposalMarket,
  type Proposal,
  type ProposalMarket,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Reads that run either inside a transaction or on the pool. */
export type Executor = Db | Tx;

const { marketProposals, categories, profiles } = schema;

/** The adopted market and a 중복's existing market: two joins of `markets`, so two names. */
const adoptedMarket = alias(schema.markets, 'proposal_market');
const duplicateMarket = alias(schema.markets, 'proposal_duplicate_market');
/**
 * The proposer, the operator who started the review, the one who decided, and the one who linked
 * a market after the 채택 (owner decision 2026-10-19).
 */
const proposerProfile = alias(profiles, 'proposal_proposer');
const reviewerProfile = alias(profiles, 'proposal_reviewer');
const deciderProfile = alias(profiles, 'proposal_decider');
const linkerProfile = alias(profiles, 'proposal_linker');

/**
 * What every reader of a proposal selects: the form, the status and its moves, the category and
 * the two markets. Never the number's hash or the internal memo — the proposer's answer cannot
 * carry what it never read; the admin's adds the memo itself (`adminProposalQuery`).
 */
const proposalColumns = {
  id: marketProposals.id,
  userId: marketProposals.userId,
  question: marketProposals.question,
  deadline: marketProposals.deadline,
  yesCondition: marketProposals.yesCondition,
  expectedSources: marketProposals.expectedSources,
  background: marketProposals.background,
  status: marketProposals.status,
  createdAt: marketProposals.createdAt,
  reviewStartedAt: marketProposals.reviewStartedAt,
  reviewStartedBy: marketProposals.reviewStartedBy,
  decidedAt: marketProposals.decidedAt,
  decidedBy: marketProposals.decidedBy,
  retractedAt: marketProposals.retractedAt,
  rejectionReason: marketProposals.rejectionReason,
  rejectionExplanation: marketProposals.rejectionExplanation,
  adoptionMemo: marketProposals.adoptionMemo,
};

const proposalSelection = {
  proposal: proposalColumns,
  // Left joins: drizzle answers null for an object whose columns are all null.
  category: { id: categories.id, slug: categories.slug, nameKo: categories.nameKo },
  // A market's link and status: what both views make of a proposal's market.
  market: {
    id: adoptedMarket.id,
    slug: adoptedMarket.slug,
    title: adoptedMarket.title,
    status: adoptedMarket.status,
  },
  duplicate: {
    id: duplicateMarket.id,
    slug: duplicateMarket.slug,
    title: duplicateMarket.title,
    status: duplicateMarket.status,
  },
};

/** A proposal with its category and markets, for `where` to narrow (the caller's own, one id). */
export function proposalQuery(executor: Executor) {
  return executor
    .select(proposalSelection)
    .from(marketProposals)
    .leftJoin(categories, eq(categories.id, marketProposals.categoryId))
    .leftJoin(adoptedMarket, eq(adoptedMarket.id, marketProposals.marketId))
    .leftJoin(duplicateMarket, eq(duplicateMarket.id, marketProposals.duplicateMarketId))
    .$dynamic();
}

export type ProposalRow = Awaited<ReturnType<ReturnType<typeof proposalQuery>['execute']>>[number];

/**
 * A proposal with what the admin screen shows besides: the internal memo, whether the wished-for
 * category is still in use (a retired wish is no default for a draft, owner decision 2026-10-19),
 * a market linked after the 채택 and when, and the proposer and operators by their current nickname
 * (`AdminAccountActor`, read here — the row stores ids, as every admin record does). Every account
 * has a profile (trigger 0002); the joins are LEFT only so that a missing one could never hide a
 * proposal from the screen that reviews it.
 */
export function adminProposalQuery(executor: Executor) {
  return executor
    .select({
      ...proposalSelection,
      categoryIsActive: categories.isActive,
      internalMemo: marketProposals.internalMemo,
      marketLinkedAt: marketProposals.marketLinkedAt,
      marketLinkedBy: marketProposals.marketLinkedBy,
      proposerNickname: proposerProfile.nickname,
      reviewerNickname: reviewerProfile.nickname,
      deciderNickname: deciderProfile.nickname,
      linkerNickname: linkerProfile.nickname,
    })
    .from(marketProposals)
    .leftJoin(categories, eq(categories.id, marketProposals.categoryId))
    .leftJoin(adoptedMarket, eq(adoptedMarket.id, marketProposals.marketId))
    .leftJoin(duplicateMarket, eq(duplicateMarket.id, marketProposals.duplicateMarketId))
    .leftJoin(proposerProfile, eq(proposerProfile.userId, marketProposals.userId))
    .leftJoin(reviewerProfile, eq(reviewerProfile.userId, marketProposals.reviewStartedBy))
    .leftJoin(deciderProfile, eq(deciderProfile.userId, marketProposals.decidedBy))
    .leftJoin(linkerProfile, eq(linkerProfile.userId, marketProposals.marketLinkedBy))
    .$dynamic();
}

export type AdminProposalRow = Awaited<
  ReturnType<ReturnType<typeof adminProposalQuery>['execute']>
>[number];

type MarketRef = ProposalRow['market'];

/** The market as the proposer may see it: its link once it is public, never a draft. */
function publicMarket(market: MarketRef): ProposalMarket | null {
  if (market === null || market.status === 'draft') return null;
  return { id: market.id, slug: market.slug, title: market.title };
}

function adminMarket(market: MarketRef): AdminProposalMarket | null {
  return market === null ? null : { ...market };
}

/** The fields the proposer and the operators both read. */
function submitted(row: ProposalRow) {
  const { proposal, category } = row;
  return {
    id: proposal.id,
    question: proposal.question,
    deadline: proposal.deadline,
    yesCondition: proposal.yesCondition,
    expectedSources: proposal.expectedSources,
    background: proposal.background,
    category: category === null ? null : { ...category },
    status: proposal.status,
    createdAt: proposal.createdAt.toISOString(),
  };
}

/**
 * The proposer's view (`Proposal`): the status and when it took it, a 반려's reason and
 * explanation, a 채택's memo, and a market's link only while that market is public. No operator,
 * no internal memo.
 */
export function toProposal(row: ProposalRow): Proposal {
  const { proposal } = row;
  const changedAt =
    proposal.retractedAt ?? proposal.decidedAt ?? proposal.reviewStartedAt ?? proposal.createdAt;
  return {
    ...submitted(row),
    statusChangedAt: changedAt.toISOString(),
    rejection:
      proposal.status === 'rejected' && proposal.rejectionReason !== null
        ? {
            reason: proposal.rejectionReason,
            explanation: proposal.rejectionExplanation ?? '',
            duplicateMarket: publicMarket(row.duplicate),
          }
        : null,
    adoption:
      proposal.status === 'adopted'
        ? { memo: proposal.adoptionMemo, market: publicMarket(row.market) }
        : null,
  };
}

const actor = (id: string | null, nickname: string | null) =>
  id === null ? null : { id, nickname: nickname ?? '' };

/**
 * The operators' view (`AdminProposal`): everything, markets in any status, who and when, and
 * whether the wished-for category is still in use.
 */
export function toAdminProposal(row: AdminProposalRow): AdminProposal {
  const { proposal, category } = row;
  return {
    ...submitted(row),
    category: category === null ? null : { ...category, isActive: row.categoryIsActive ?? false },
    proposer: { id: proposal.userId, nickname: row.proposerNickname ?? '' },
    reviewStartedAt: proposal.reviewStartedAt?.toISOString() ?? null,
    reviewStartedBy: actor(proposal.reviewStartedBy, row.reviewerNickname),
    decidedAt: proposal.decidedAt?.toISOString() ?? null,
    decidedBy: actor(proposal.decidedBy, row.deciderNickname),
    retractedAt: proposal.retractedAt?.toISOString() ?? null,
    marketLinkedAt: row.marketLinkedAt?.toISOString() ?? null,
    marketLinkedBy: actor(row.marketLinkedBy, row.linkerNickname),
    rejection:
      proposal.status === 'rejected' && proposal.rejectionReason !== null
        ? {
            reason: proposal.rejectionReason,
            explanation: proposal.rejectionExplanation ?? '',
            duplicateMarket: adminMarket(row.duplicate),
          }
        : null,
    adoption:
      proposal.status === 'adopted'
        ? { memo: proposal.adoptionMemo, market: adminMarket(row.market) }
        : null,
    internalMemo: row.internalMemo,
  };
}
