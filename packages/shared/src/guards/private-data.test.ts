import { describe, expect, it } from 'vitest';
import {
  PRIVATE_DATA,
  PRIVATE_DATA_IDS,
  type PrivateDataId,
  findPrivateField,
} from './private-data.js';

const items = (name: string) => [...new Set(findPrivateField(name).map((hit) => hit.item))];

describe('PRIVATE_DATA (#113)', () => {
  it('lists each item once, in the order of its ids, with a basis and fields', () => {
    expect(PRIVATE_DATA.map((item) => item.id)).toEqual([...PRIVATE_DATA_IDS]);
    for (const item of PRIVATE_DATA) {
      expect(item.name.trim(), item.id).not.toBe('');
      expect(item.basis.trim(), item.id).not.toBe('');
      // Something names it: a run of words, or a thing and whose it is.
      if (item.owned === undefined) expect(item.fields.length, item.id).toBeGreaterThan(0);
      else {
        expect(item.owned.words.length, item.id).toBeGreaterThan(0);
        expect(item.owned.whose.length, item.id).toBeGreaterThan(0);
      }
      for (const run of item.fields) {
        expect(run.length, item.id).toBeGreaterThan(0);
        for (const word of run) expect(word, item.id).toMatch(/^[a-z]+$/);
      }
      for (const word of [...(item.owned?.words ?? []), ...(item.owned?.whose ?? [])]) {
        expect(word, item.id).toMatch(/^[a-z]+$/);
      }
      if (item.pending !== undefined) expect(item.pending.trim(), item.id).not.toBe('');
    }
  });

  it('names the items #113 lists, the ones nothing stores yet included', () => {
    expect(PRIVATE_DATA_IDS).toEqual(
      expect.arrayContaining([
        'email',
        'real-name',
        'phone',
        'time-zone',
        'watchlist',
        'search-history',
        'likers',
        'identity-verification',
        'consent',
        'former-nickname',
        'risk-flag',
        'author-holding',
        'moderation',
        'reports',
        'market-maker',
      ]),
    );
    expect(
      PRIVATE_DATA.filter((item) => item.pending !== undefined).map((item) => item.id),
    ).toEqual(['market-maker']);
  });
});

describe('findPrivateField', () => {
  it.each<[string, PrivateDataId]>([
    ['balance', 'balance'],
    ['availableCoin', 'balance'],
    ['locked_coin', 'balance'],
    ['startGrant', 'balance'],
    ['start_grants', 'balance'],
    ['start_grant_numbers', 'balance'],
    ['orderId', 'orders'],
    ['counterparty_order_id', 'orders'],
    ['orders', 'orders'],
    ['idempotencyKey', 'orders'],
    ['position', 'holdings'],
    ['holdings', 'holdings'],
    ['costBasisCoin', 'holdings'],
    ['realizedPnlCoin', 'pnl'],
    ['unrealizedProfit', 'pnl'],
    ['myFills', 'fills'],
    ['userFills', 'fills'],
    ['accountFills', 'fills'],
    ['fillsByUser', 'fills'],
    ['fills_by_account', 'fills'],
    ['traderFills', 'fills'],
    ['ownFills', 'fills'],
    ['memberTradeHistory', 'fills'],
    ['userTrades', 'fills'],
    ['userId', 'counterparty'],
    ['accountId', 'counterparty'],
    ['counterpartyType', 'counterparty'],
    ['makerOrderId', 'counterparty'],
    ['traderId', 'counterparty'],
    ['email', 'email'],
    ['realName', 'real-name'],
    ['buyer_full_name', 'real-name'],
    ['phone', 'phone'],
    ['mobileNumber', 'phone'],
    ['userTimeZone', 'time-zone'],
    ['profileTimeZone', 'time-zone'],
    ['memberZone', 'time-zone'],
    ['myTimeZone', 'time-zone'],
    ['viewer_tz', 'time-zone'],
    ['timeZoneOfAccount', 'time-zone'],
    ['traderTimezone', 'time-zone'],
    ['watchCount', 'watchlist'],
    ['watcherCount', 'watchlist'],
    ['isWatched', 'watchlist'],
    ['myWatchlist', 'watchlist'],
    ['isInterested', 'watchlist'],
    ['recentSearches', 'search-history'],
    ['searchHistory', 'search-history'],
    ['lastSearchedAt', 'search-history'],
    ['userQueries', 'search-history'],
    ['mySearch', 'search-history'],
    ['likedByMe', 'likers'],
    ['isLiked', 'likers'],
    ['liked_by', 'likers'],
    ['likerIds', 'likers'],
    ['likers', 'likers'],
    ['identityVerification', 'identity-verification'],
    ['verification', 'identity-verification'],
    ['verifiedAt', 'identity-verification'],
    ['phoneVerified', 'identity-verification'],
    ['otpSentAt', 'identity-verification'],
    ['ci', 'identity-verification'],
    ['birthDate', 'identity-verification'],
    ['clientIp', 'identity-verification'],
    ['ip_address', 'identity-verification'],
    ['consents', 'consent'],
    ['consentedAt', 'consent'],
    ['marketingConsent', 'consent'],
    ['agreedAt', 'consent'],
    ['userAgent', 'consent'],
    ['user_agent', 'consent'],
    ['previousNickname', 'former-nickname'],
    ['nicknameHistory', 'former-nickname'],
    ['nickname_changed_at', 'former-nickname'],
    ['nicknameChangeAvailableAt', 'former-nickname'],
    ['releasedNickname', 'former-nickname'],
    ['nickname_holds', 'former-nickname'],
    ['passwordHash', 'auth-secret'],
    ['sessionToken', 'auth-secret'],
    ['riskFlags', 'risk-flag'],
    ['needsReview', 'risk-flag'],
    ['isSuspended', 'risk-flag'],
    ['sanctionEndsAt', 'risk-flag'],
    ['activeSanctions', 'risk-flag'],
    ['warningCount', 'risk-flag'],
    ['warned_at', 'risk-flag'],
    ['authorPosition', 'author-holding'],
    ['author_side', 'author-holding'],
    ['hidden', 'moderation'],
    ['hiddenAt', 'moderation'],
    ['isHidden', 'moderation'],
    ['hiddenReason', 'moderation'],
    ['hide_reason', 'moderation'],
    ['hidingReason', 'moderation'],
    ['moderationStatus', 'moderation'],
    ['moderations', 'moderation'],
    ['moderatedAt', 'moderation'],
    ['moderatorId', 'moderation'],
    ['moderators', 'moderation'],
    ['reportCount', 'reports'],
    ['reports', 'reports'],
    ['reporterId', 'reports'],
    ['reported_by', 'reports'],
    ['isReported', 'reports'],
    ['reportingUsers', 'reports'],
    ['hasBot', 'market-maker'],
    ['bot_status', 'market-maker'],
    ['marketMakerInventory', 'market-maker'],
    ['liquidityB', 'market-maker'],
    ['liquiditySettings', 'market-maker'],
    ['maxLossCoin', 'market-maker'],
    ['safetyTicks', 'market-maker'],
    ['utilizationBp', 'market-maker'],
    ['allocatedCoin', 'market-maker'],
    ['vaultBalance', 'market-maker'],
    ['topHolderConcentration', 'market-maker'],
  ])('finds %s (%s)', (name, item) => {
    expect(items(name)).toContain(item);
  });

  it.each([
    'id',
    'marketId',
    'nameKo',
    'title',
    'lastPrice',
    'volumeCoin',
    'tradeCount',
    'traderCount',
    'participantCount',
    'fills',
    'recentFills',
    'fillCount',
    'lastFill',
    'marketFills',
    'trades',
    'outcome',
    'side',
    'qty',
    'priceAvgBp',
    'amountCoin',
    'orderBook',
    'statusEventId',
    'resolvedResult',
    'resolution',
    'uptimeSeconds',
    'latencyMs',
    'sortOrder',
    'parentId',
    'nextCursor',
    'myriad',
    'bottom',
    'robot',
    'limit',
    'liquid',
    // A market's judging time zone (#22): a zone with no whose-word is public.
    'timeZone',
    'time_zone',
    'timezone',
    'tz',
    'zone',
    'judgingTimeZone',
    'resolutionTimeZone',
    'judging_zone',
    'marketTimeZone',
    'closeAtTz',
    // A market's open interest is a trading figure, not a watch (ADR-0064), in the plural too;
    // a stopwatch is one word; the realtime room message is a subscription, not a watch.
    'openInterest',
    'openInterests',
    'stopwatch',
    'subscribe',
    // A search's own words with nobody's beside them (ADR-0066): the request's `q` is the caller's,
    // and a word that only starts like one is another word.
    'q',
    'query',
    'search',
    'searchable',
    'keyword',
    'research',
    // A nickname on its own is public (an author's, #37-5's profile); only a former one is not.
    'nickname',
    'authorNickname',
    // A like's count is public beside a post and a comment (#49); only who liked is not.
    'likeCount',
    'like_count',
    'likes',
    // A post's state says a placeholder is one (#45-5), and a reason on its own is a refusal's
    // (`details.reason`): only a hiding's mark and reason are the author's (ADR-0080).
    'state',
    'reason',
    'commentCount',
    'excerpt',
  ])('lets %s through', (name) => {
    expect(findPrivateField(name)).toEqual([]);
  });

  // Each run of the market-maker item, by a name only that run catches (ADR-0058 결정 1의 20).
  it.each<[string, string]>([
    ['botStatus', 'bot'],
    ['bots', 'bots'],
    ['isMarketMaker', 'market maker'],
    ['market_makers', 'market makers'],
    ['liquidityB', 'liquidity b'],
    ['liquiditySetting', 'liquidity setting'],
    ['liquiditySettings', 'liquidity settings'],
    ['liquidityConfig', 'liquidity config'],
    ['maxLossCoin', 'max loss'],
    ['safetyTicks', 'safety ticks'],
    ['safetySpreadCoin', 'safety spread'],
    ['inventoryQty', 'inventory'],
    ['utilizationBp', 'utilization'],
    ['allocatedCoin', 'allocated'],
    ['allocation', 'allocation'],
    ['vaultBalance', 'vault'],
    ['treasuryCoin', 'treasury'],
    ['holderConcentration', 'concentration'],
  ])('keeps %s private as a market-maker field (%s)', (name, words) => {
    expect(
      findPrivateField(name)
        .filter((hit) => hit.item === 'market-maker')
        .map((hit) => hit.words),
    ).toEqual([words]);
  });

  // The watchlist item, by a name only that run catches (#37 for #89, ADR-0061 decision 3,
  // ADR-0064). A run of the item without an example here fails the test below.
  const WATCHLIST_RUNS: readonly [string, string][] = [
    ['watchCount', 'watch'],
    ['market_watches', 'watches'],
    ['isWatched', 'watched'],
    ['watchingSince', 'watching'],
    ['topWatcher', 'watcher'],
    ['watchersCount', 'watchers'],
    ['userWatchlist', 'watchlist'],
    ['watchlists', 'watchlists'],
    ['interestedCount', 'interested'],
    ['favoriteCount', 'favorite'],
    ['favorites', 'favorites'],
    ['favouriteCount', 'favourite'],
    ['favourites', 'favourites'],
    ['bookmarkCount', 'bookmark'],
    ['bookmarks', 'bookmarks'],
    ['isBookmarked', 'bookmarked'],
  ];

  it.each(WATCHLIST_RUNS)('keeps %s private as a watchlist field (%s)', (name, words) => {
    expect(
      findPrivateField(name)
        .filter((hit) => hit.item === 'watchlist')
        .map((hit) => hit.words),
    ).toEqual([words]);
  });

  it('has an example above for every run of the watchlist item', () => {
    const watchlist = PRIVATE_DATA.find((item) => item.id === 'watchlist')!;
    expect(watchlist.fields.map((run) => run.join(' ')).sort()).toEqual(
      WATCHLIST_RUNS.map(([, words]) => words).sort(),
    );
  });

  // The search-history item, by a name only that run catches (#15, ADR-0061 decision 3,
  // ADR-0066), and each word it takes beside a whose-word. A run or a word without an example
  // here fails the test below.
  const SEARCH_HISTORY_RUNS: readonly [string, string][] = [
    ['popularSearches', 'searches'],
    ['searchedAt', 'searched'],
    ['recentSearch', 'recent search'],
    ['searchHistory', 'search history'],
    ['searchHistories', 'search histories'],
    ['searchLog', 'search log'],
    ['search_logs', 'search logs'],
    ['searchQuery', 'search query'],
    ['searchQueries', 'search queries'],
    ['searchTerm', 'search term'],
    ['searchTerms', 'search terms'],
    ['viewerSearch', 'viewer search'],
    ['userQuery', 'user query'],
    ['accountQueries', 'account queries'],
    ['memberKeyword', 'member keyword'],
    ['myKeywords', 'my keywords'],
  ];
  const searchHistoryHits = (name: string) =>
    findPrivateField(name)
      .filter((hit) => hit.item === 'search-history')
      .map((hit) => hit.words);

  it.each(SEARCH_HISTORY_RUNS)('keeps %s private as a search-history field (%s)', (name, words) => {
    expect(searchHistoryHits(name)).toEqual([words]);
  });

  it('has an example above for every run and every word of the search-history item', () => {
    const searchHistory = PRIVATE_DATA.find((item) => item.id === 'search-history')!;
    const examples = SEARCH_HISTORY_RUNS.map(([, words]) => words);
    for (const run of searchHistory.fields)
      expect(examples, run.join(' ')).toContain(run.join(' '));
    for (const word of searchHistory.owned!.words) {
      expect(
        examples.some((words) => words.split(' ').includes(word)),
        word,
      ).toBe(true);
    }
  });

  // The time-zone item, by a name only that word catches (owner decision 2026-10-16, ADR-0063):
  // each zone word beside one whose-word, and each whose-word it adds to WHOSE.
  const timeZone = PRIVATE_DATA.find((item) => item.id === 'time-zone')!;
  const timeZoneHits = (name: string) =>
    findPrivateField(name)
      .filter((hit) => hit.item === 'time-zone')
      .map((hit) => hit.words);
  const TIME_ZONE_WORDS: readonly [string, string][] = [
    ['userTimeZone', 'user zone'],
    ['member_zones', 'member zones'],
    ['accountTimezone', 'account timezone'],
    ['profileTimezones', 'profile timezones'],
    ['ownerTz', 'owner tz'],
    ['myZone', 'my zone'],
    ['mineTz', 'mine tz'],
    ['viewerTimeZone', 'viewer zone'],
    ['viewersZones', 'viewers zones'],
  ];

  it.each(TIME_ZONE_WORDS)('keeps %s private as a time-zone field (%s)', (name, words) => {
    expect(timeZoneHits(name)).toEqual([words]);
  });

  const fillsWhose = PRIVATE_DATA.find((item) => item.id === 'fills')!.owned!.whose;

  it('has an example above for every zone word and every whose-word it adds', () => {
    const example = (word: string) =>
      TIME_ZONE_WORDS.some(([, words]) => words.split(' ').includes(word));
    expect(timeZone.owned!.words.filter((word) => !example(word))).toEqual([]);
    expect(
      timeZone.owned!.whose.filter((word) => !fillsWhose.includes(word) && !example(word)),
    ).toEqual([]);
  });

  it('takes every whose-word of the fills item as whose a time zone is', () => {
    for (const word of fillsWhose) {
      expect(timeZoneHits(`${word}TimeZone`), word).toEqual([`${word} zone`]);
    }
  });

  it('reports the item and the words that matched', () => {
    expect(findPrivateField('userRealName')).toEqual([{ item: 'real-name', words: 'real name' }]);
    expect(findPrivateField('fillsByUser')).toEqual([{ item: 'fills', words: 'user fills' }]);
    expect(findPrivateField('myBalance')).toEqual([
      { item: 'balance', words: 'balance' },
      { item: 'fills', words: 'my' },
    ]);
  });
});
