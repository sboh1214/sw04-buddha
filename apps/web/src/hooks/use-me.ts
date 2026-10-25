'use client';

import { type UserBalanceEvent } from '@buddha/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type Query,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { copy } from '@/copy';
import {
  api,
  isApiError,
  isForAnotherAccount,
  unwrap,
  type DeleteProfileImageBody,
  type Me,
  type UpdateBioBody,
  type UpdateMeBody,
  type UpdateTimeZoneBody,
} from '@/lib/api';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { AUTHORED_KEY, MY_AUTHORED_KEY, authoredPagesWithAuthorImage } from '@/lib/authored';
import { logWriteForEveryPost } from '@/lib/comment-writes';
import { COMMENT_PAGES_KEY, commentPagesWithAuthorImage } from '@/lib/comments';
import { applyBalanceEvent } from '@/lib/market-live';
import { nicknameRefusalNeedsRefresh } from '@/lib/nickname';
import { type UploadRetrySteps, pause, sendRetrying } from '@/lib/post-editor';
import {
  POST_LIST_KEY,
  POST_PAGE_KEY,
  postPagesWithAuthorImage,
  postWithAuthorImage,
} from '@/lib/posts';
import { profileImageContentType } from '@/lib/profile';
import { useSession } from '@/lib/use-session';

/** Query key rule from PLAN 11.5. */
export const ME_QUERY_KEY = ['me'] as const;

export async function fetchMe(): Promise<Me> {
  return unwrap(await api.GET('/api/v1/me')).data;
}

/**
 * Profile + balance + linked login methods (`GET /api/v1/me`). Only runs while the
 * better-auth session says we are logged in, so a logged-out visitor never triggers a 401.
 */
export function useMe() {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    enabled: session !== null && session !== undefined,
  });
  return {
    ...query,
    /** True until we know whether there is a session (avoids a logged-out flash). */
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/**
 * `POST /api/v1/me/password`: the first password of an account that has none, set from the
 * settings screen (a social-only user) and by the sign-up's /set-password step. Refreshes the
 * linked-account list, which decides whether the settings screen offers "set" or "change" and
 * /set-password its "already set" branch.
 *
 * The body names the account the screen shows (`expectedAccountId`, A-PG-24), read from the
 * session as `useCharge` reads it: the cookie decides whose password is set, and a settings tab
 * left open beside a window that signed in as somebody else would otherwise give THAT account a
 * first password typed here — one whoever typed it knows. The server refuses the mismatch
 * before better-auth is asked; the refusal refetches the session so SessionCacheGuard shows
 * the account that is really signed in. `ready` is false until the session is known, and the
 * form keeps its submit disabled until then.
 */
export function useSetPassword() {
  const queryClient = useQueryClient();
  const { data: session, refetch: refetchSession } = useSession();
  const accountId = session?.user.id;
  const mutation = useMutation({
    mutationFn: async (newPassword: string) => {
      // Unreachable while the form honours `ready`.
      if (!accountId) throw new Error('password set before the session was known');
      return unwrap(
        await api.POST('/api/v1/me/password', {
          body: { newPassword, expectedAccountId: accountId },
        }),
      ).data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    onError: (error: Error) => {
      if (isForAnotherAccount(error)) void refetchSession();
    },
  });
  return { ...mutation, ready: accountId !== undefined };
}

/**
 * Whether `['me']` may take a write made for `account`: it holds that account's profile, or no
 * profile at all.
 *
 * `account` is not a guess. For a verification or a password it is the `expectedAccountId` the
 * request sent, which the server compared with the cookie before writing; for a `Me` a write
 * answered with it is that answer's own `id`, the account whose row was written. Either way a 2xx
 * PROVES whose write it was. The entry, unlike `['positions']`, carries its owner (`Me.id`), so
 * the comparison is the entry's own and needs no reading of the session. A profile of somebody
 * else means the tab switched accounts while the request ran (SessionCacheGuard reset the caches
 * and the other account's `GET /me` landed) — or, for the cookie-only `PATCH /me`, that the tab
 * never learned of a switch (`storeMe`): writing the answer there would show one account's name,
 * real name, number or choices on the other's screen, and even a mere refresh is not this
 * answer's to ask for — the guard owns that entry. No profile at all is nothing of anybody's to
 * overwrite, and the request that fills it asks the cookie.
 */
export function meBelongsTo(queryClient: QueryClient, account: string): boolean {
  const held = queryClient.getQueryData<Me>(ME_QUERY_KEY);
  return held === undefined || held.id === account;
}

/**
 * The profile field a profile write owns: the one `storeMe` takes from its answer. A nickname
 * change brings when the nickname may change next with it (#58: once in 30 days); the 소개 is the
 * public profile's (#41, `PUT /me/bio`), and so is the image's address (#141, `PUT /me/profile-image`
 * and its deletion).
 */
export type ProfileField = 'nickname' | 'timeZone' | 'bio' | 'image';

/** `held`'s profile with what the `field` write changed taken from `answer`. */
function withProfileField(held: Me, answer: Me, field: ProfileField): Me['profile'] {
  switch (field) {
    case 'nickname':
      return {
        ...held.profile,
        nickname: answer.profile.nickname,
        nicknameChangeAvailableAt: answer.profile.nicknameChangeAvailableAt,
      };
    case 'timeZone':
      return { ...held.profile, timeZone: answer.profile.timeZone };
    case 'bio':
      return { ...held.profile, bio: answer.profile.bio };
    case 'image':
      return { ...held.profile, imageUrl: answer.profile.imageUrl };
  }
}

/**
 * A refusal that says `['me']` is out of date for `account` — verified already (another tab
 * finished first), not verified any more (the real-name card's VERIFICATION_REQUIRED), an
 * onboarding step done or not done elsewhere (#58) — asks for it again, so the gate, the stepper
 * and the screen follow the server. Only while the entry is that account's: another account's
 * profile there belongs to SessionCacheGuard.
 */
export async function refreshOwnMe(queryClient: QueryClient, account: string): Promise<void> {
  if (!meBelongsTo(queryClient, account)) return;
  await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
}

/**
 * Writes the profile a profile write answered with (`PATCH /me`, `PUT /me/time-zone`,
 * `PUT /me/bio`, `PUT /me/profile-image` and its deletion) into `['me']`, so every observer —
 * TimeZoneProvider, the header — takes it without a refetch.
 *
 * Only the field the write changed (`field`): the answer is a whole `Me`, but the write changed
 * nothing else. Two profile writes can overlap — a nickname save and a time-zone save from the
 * same settings screen — and each answer is a snapshot of the whole profile read right after
 * its own UPDATE: a time-zone answer that read the nickname before the nickname's UPDATE
 * committed, landing last, would put the old nickname back while the database holds the new
 * one. So each write takes only its own field from its answer. The rest of the answer is no
 * better: its `balance` is what the server read right after the UPDATE. A fill or a payout that
 * committed after that read may already have reached the tab as `user:balance` and patched
 * `['me']` (realtime-provider.tsx), which drops a repeat of that event; writing the whole answer
 * would put the older balance back on the header chip, the wallet and the order panel until the
 * next refetch. `storeVerification` (use-phone-verification.ts) takes only `verification` for the
 * same reason.
 *
 * A `GET /me` already in flight (a window-focus refetch, a realtime resnapshot) is cancelled
 * first, as `storeVerification` and realtime-provider.tsx do before they patch `['me']`: it may
 * have left before the write committed, and answering after this one it would put the old nickname
 * or zone back until the next refetch — the toast saying 저장했습니다 over times read in the zone
 * just left. The cancel reverts the entry to what it held before that request; if that is
 * nothing (a first fetch), the entry is re-asked rather than filled: it held nobody's profile,
 * and the request that fills it asks the cookie (`meBelongsTo`).
 *
 * Only while `['me']` still belongs to the account the answer is (`me.id`): checked before the
 * cancel, so another account's profile held there is never touched — its refresh is not
 * cancelled either — and again after it, since the cancel is awaited. Another account's profile
 * there means the tab and the cookie disagree on who is signed in, and the write went to the
 * cookie's account. Either the tab already switched after the request left (SessionCacheGuard
 * reset the cache and the next account's `GET /me` landed), or the tab never learned of a switch
 * at all: a window still showing A beside one that signed in as B, which no `visibilitychange`
 * tells (session-cache-guard.tsx), so `PATCH /me` — cookie only (A-PG-24) — renamed B. So
 * `onSessionChanged` asks for the session again: in the first case it changes nothing, in the
 * second SessionCacheGuard resets the cache and the screen shows the account that was written,
 * which is what lets the member see that the account changed (A-PG-24).
 */
export async function storeMe(
  queryClient: QueryClient,
  me: Me,
  field: ProfileField,
  onSessionChanged: () => void,
): Promise<void> {
  if (!meBelongsTo(queryClient, me.id)) {
    onSessionChanged();
    return;
  }
  await queryClient.cancelQueries({ queryKey: ME_QUERY_KEY, exact: true });
  const held = queryClient.getQueryData<Me>(ME_QUERY_KEY);
  if (held) {
    if (held.id === me.id)
      queryClient.setQueryData<Me>(ME_QUERY_KEY, {
        ...held,
        profile: withProfileField(held, me, field),
      });
    else onSessionChanged();
    return;
  }
  await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
}

/**
 * The reads that carry members' faces (ADR-0069 decision 5: public id, nickname, image, 운영자), by
 * prefix, each with what puts a member's new profile image on what it holds (ADR-0079 7-21): the
 * community list's and every market's 토론's cards (`POST_LIST_KEY`), the post pages and their
 * comment pages (the 대댓글 '답글 더 보기' read among them), all under the posts' root; and a
 * member's lists (#51, ADR-0080 7-24), under roots of their own: a profile's 글 and 댓글 tabs
 * (`AUTHORED_KEY`) and MY '내 글''s with the summary's preview (`MY_AUTHORED_KEY`). A read that
 * comes to carry faces elsewhere joins here. `['me']` is not one: `storeMe` writes it.
 */
const AUTHOR_FACE_READS: readonly {
  queryKey: QueryKey;
  withImage: (held: never, publicId: string, imageUrl: string | null) => unknown;
}[] = [
  { queryKey: POST_LIST_KEY, withImage: postPagesWithAuthorImage },
  { queryKey: POST_PAGE_KEY, withImage: postWithAuthorImage },
  { queryKey: COMMENT_PAGES_KEY, withImage: commentPagesWithAuthorImage },
  { queryKey: AUTHORED_KEY, withImage: authoredPagesWithAuthorImage },
  { queryKey: MY_AUTHORED_KEY, withImage: authoredPagesWithAuthorImage },
];

/**
 * The profile image the member `publicId` has now (#141) — its address, or null once deleted —
 * on every face of theirs the tab holds (`AUTHOR_FACE_READS`; Codex review on PR #225, ADR-0079
 * 7-21). Without it a card, a post or a comment read before the change kept the old address until
 * its next read (30 seconds, a focus): Back to it showed the image just replaced — or, its file
 * removed at once (decision 4 #141), a broken one — and the deleted image instead of the
 * nickname's first letter. A member's list (#51), read again whenever it is shown, drew the old one
 * until that read answered (ADR-0080 7-24).
 *
 * Each entry is patched where it is, not read again: it changes nothing but the faces, so its
 * time, its stale mark and a failed read's error stay as they were — what was due to be read is
 * still due, and nothing fresh is read early — and no request is sent, the pages a comment section held among them (each
 * a request in the reader's address limit). A read of the entry on its way may have left before
 * the write and land after it, putting the old face back: it is cancelled first, and a read of
 * every page held so cancelled is made again (not waited for) — the rule `writePages`
 * (use-comments.ts) keeps for a comment's write, a 더 보기 cancelled left to be pressed again.
 *
 * The comment section's three reads toward a place — a new 댓글's read to the end, a new 대댓글's
 * read on, '답글 더 보기' — are not the query's and nothing cancels them: what they read before the
 * change, put in after it, would bring the old address back (a new 댓글's read goes on after its
 * write's answer, whatever screen the tab moved to — the profile's MY 설정 among them). So the
 * change first goes into the log of every one of them on its way (lib/comment-writes.ts, ADR-0074
 * 7-34), done again over what it puts in (ADR-0079 7-22): the same function of the pages held as
 * the patch here — the member's faces only, the same again when done again — so its place in the
 * order of the writes does not matter. First, before any of the waits below: a read landing during
 * them must find it logged.
 */
export async function storeAuthorImage(
  queryClient: QueryClient,
  publicId: string,
  imageUrl: string | null,
): Promise<void> {
  logWriteForEveryPost(
    queryClient,
    (held) => held && commentPagesWithAuthorImage(held, publicId, imageUrl),
  );
  const cache = queryClient.getQueryCache();
  await Promise.all(
    AUTHOR_FACE_READS.flatMap(({ queryKey, withImage }) =>
      cache
        .findAll({ queryKey })
        .map((query) =>
          putAuthorImage(queryClient, query, (held) =>
            withImage(held as never, publicId, imageUrl),
          ),
        ),
    ),
  );
}

/** `storeAuthorImage` for one entry: `withImage` on what it holds, once no read can undo it. */
async function putAuthorImage(
  queryClient: QueryClient,
  query: Query,
  withImage: (held: unknown) => unknown,
): Promise<void> {
  const { queryKey } = query;
  const reading = query.state.fetchStatus !== 'idle';
  const readAgain = reading && query.state.fetchMeta?.fetchMore === undefined;
  if (reading) await queryClient.cancelQueries({ queryKey, exact: true });
  // As the cancellation left it: what it held before that read.
  const { data } = query.state;
  if (data !== undefined) {
    const next = withImage(data);
    // The data alone, as hydration writes an entry: `setQueryData` would also stamp it read now,
    // drop its stale mark and turn a failed read into a success — the error a screen shows, a
    // post page's NOT_FOUND that draws its 404 (post-screen.tsx), gone with it.
    if (next !== data) query.setState({ data: next });
  }
  if (readAgain) void queryClient.invalidateQueries({ queryKey, exact: true });
}

/**
 * A profile image write's answer — an upload's (`PUT /me/profile-image`) or a deletion's — in the
 * caches, for both mutations: the image's address into `['me']` (`storeMe`, only while it holds
 * the account written) and onto every face of the member the tab holds (`storeAuthorImage` —
 * whoever `['me']` holds: the faces are public, and the answer is the server's word on the account
 * it names).
 */
export async function storeProfileImage(
  queryClient: QueryClient,
  me: Me,
  onSessionChanged: () => void,
): Promise<void> {
  await Promise.all([
    storeMe(queryClient, me, 'image', onSessionChanged),
    storeAuthorImage(queryClient, me.profile.publicId, me.profile.imageUrl),
  ]);
}

/**
 * A `user:balance` event's write into `['me']` (realtime-provider.tsx, once the event passed its
 * order gate): the new balance at once, and `GET /me` asked again where the event cannot say the
 * rest. The reducer (`applyBalanceEvent`, lib/market-live.ts) decides which; this carries it out.
 * Apart from the provider, which apps/web's node test runner cannot render, so the suite drives
 * the very steps the provider takes (realtime-cache.test.ts) rather than a copy of them.
 */
export function storeBalanceEvent(queryClient: QueryClient, event: UserBalanceEvent): void {
  const patch = applyBalanceEvent(queryClient.getQueryData<Me>(ME_QUERY_KEY), event);
  // Kills an in-flight `GET /me` that would otherwise resolve after this write carrying an older
  // balance. A charge or a coupon also reaches the chip through its own answer's refetch (an
  // Idempotency-Key replay publishes NO event); a payout reaches it only here.
  //
  // The cancel is synchronous down to the state change (query-core's retryer rejects and calls
  // `onCancel` in the same tick), so both branches below act on a query that is already idle.
  void queryClient.cancelQueries({ queryKey: ME_QUERY_KEY, exact: true });
  if (patch.kind === 'refetch') {
    // Nothing to patch, and the cancel has just REVERTED the first `GET /me` to the state it had
    // before it started — `pending` with no data, and no observer left fetching. So the request
    // has to be re-issued, or the balance chip and the 잔고 요약 spin until the next window focus.
    // Issued after the event was received, so its answer cannot be the snapshot this event
    // already superseded.
    void queryClient.invalidateQueries({
      queryKey: ME_QUERY_KEY,
      exact: true,
      refetchType: 'active',
    });
    return;
  }
  queryClient.setQueryData<Me>(ME_QUERY_KEY, patch.me);
  if (patch.kind === 'replaceAndRefetch') {
    // The first kind of realtime-provider.tsx's RULE (its `market:status` handler): the event
    // cannot build what it may be about. This account's start Coin is waiting (#70), and a
    // payment of it arrives as nothing but this event, which does not say what the entry was — so
    // `['me']` is asked again for `startGrant`, after the balance is already on screen. Not 남발:
    // only while a grant waits, and the answer that says it is paid ends it.
    void queryClient.invalidateQueries({
      queryKey: ME_QUERY_KEY,
      exact: true,
      refetchType: 'active',
    });
  }
}

async function patchNickname(body: UpdateMeBody): Promise<Me> {
  return unwrap(await api.PATCH('/api/v1/me', { body })).data;
}

async function putTimeZone(body: UpdateTimeZoneBody): Promise<Me> {
  return unwrap(await api.PUT('/api/v1/me/time-zone', { body })).data;
}

/**
 * `PATCH /api/v1/me` (nickname) as mutation options: the answer's profile goes into `['me']`
 * through `storeMe`. Exported apart from its hook, as use-phone-verification.ts does its own,
 * because apps/web runs vitest under `environment: 'node'` (use-me.test.ts). `onSessionChanged`
 * is the hook's session refetch and `patch` stands in the request; both parameters so a test can
 * watch them. Since #58 the body names the account the screen shows (`expectedAccountId`), so the
 * 403 for another account asks for the session again, as the time zone's does: nothing was
 * written, and SessionCacheGuard puts the account really signed in on screen. A refusal that says
 * `['me']` is out of date for the account (`nicknameRefusalNeedsRefresh` — ONBOARDING_REQUIRED: a
 * revision asked for the consent again while the screen was open, and the server changes no
 * nickname of an account that has not done its onboarding, owner decision 2026-10-22 answer 1)
 * asks `['me']` again before the promise rejects, as the 소개's does, so the gate or MY 설정's step
 * (`useSettingsStep`) takes the member on from what the server says now.
 */
export function updateNicknameOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  patch: (body: UpdateMeBody) => Promise<Me> = patchNickname,
) {
  return {
    mutationFn: patch,
    // Returned, so `mutateAsync` settles only once `['me']` holds the answer.
    onSuccess: (me: Me) => storeMe(queryClient, me, 'nickname', onSessionChanged),
    onError: async (error: Error, body: UpdateMeBody) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      if (nicknameRefusalNeedsRefresh(error)) {
        await refreshOwnMe(queryClient, body.expectedAccountId);
      }
    },
  };
}

/** `updateNicknameOptions` as the settings card's mutation. */
export function useUpdateNickname() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(updateNicknameOptions(queryClient, () => void refetchSession()));
}

async function putBio(body: UpdateBioBody): Promise<Me> {
  return unwrap(await api.PUT('/api/v1/me/bio', { body })).data;
}

/**
 * `PUT /api/v1/me/bio` (#41, ADR-0078) as mutation options: the 소개 of the public profile, edited
 * in MY 설정 (ADR-0069 decision 4 #41) — the text, or `null` to clear it — and the account the card
 * shows (`expectedAccountId`). The answer's 소개 goes into `['me']` through `storeMe`, as the
 * nickname's does, so the card shows what the server kept (normalised: trimmed, line breaks as
 * `\n`). The 403 for another account asks for the session again, so SessionCacheGuard puts the
 * account really signed in on screen; an ONBOARDING_REQUIRED — a revision asked for the consent
 * again while the screen was open — asks `['me']` again, and the gate, or on MY 설정 the step
 * (`useSettingsStep`), takes the member on.
 */
export function updateBioOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  put: (body: UpdateBioBody) => Promise<Me> = putBio,
) {
  return {
    mutationFn: put,
    // Returned, so `mutateAsync` settles only once `['me']` holds the answer.
    onSuccess: (me: Me) => storeMe(queryClient, me, 'bio', onSessionChanged),
    onError: async (error: Error, body: UpdateBioBody) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      if (isApiError(error, 'ONBOARDING_REQUIRED')) {
        await refreshOwnMe(queryClient, body.expectedAccountId);
      }
    },
  };
}

/** `updateBioOptions` as MY 설정's 소개 card's mutation. */
export function useUpdateBio() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(updateBioOptions(queryClient, () => void refetchSession()));
}

/** A profile image to upload: the picked file, and the account the card shows. */
export interface ProfileImageUpload {
  file: Blob & { type: string };
  expectedAccountId: string;
}

/**
 * `PUT /api/v1/me/profile-image` (#141, ADR-0079): the file itself as the body (no multipart), under
 * its own type or `application/octet-stream` (`profileImageContentType`), with the account the card
 * shows in the query — the body is the file, so it cannot ride there — as a post's image goes
 * (`uploadPostImage`). The answer is the whole profile, its new image's address in it.
 */
export async function putProfileImage({
  file,
  expectedAccountId,
}: ProfileImageUpload): Promise<Me> {
  return unwrap(
    await api.PUT('/api/v1/me/profile-image', {
      params: { query: { expectedAccountId } },
      // openapi-fetch would JSON-encode the body: the file goes as it is.
      body: file as unknown as string,
      bodySerializer: (body: unknown) => body as BodyInit,
      headers: { 'Content-Type': profileImageContentType(file) },
    }),
  ).data;
}

/**
 * The waits of a profile upload sent again (`sendRetrying`): the page's clock, and never given up —
 * the member picked the file, and the image is the profile's whether or not the card is still on
 * screen when it lands (its answer goes into `['me']`).
 */
const PROFILE_UPLOAD_RETRY: UploadRetrySteps = { sleep: pause, alive: () => true };

/**
 * `PUT /me/profile-image` as mutation options: the answer's image address goes into `['me']`
 * through `storeMe`, as the 소개's does, so the card and every observer show the new image at once,
 * and onto every face of the member a card, a post or a comment the tab holds carries
 * (`storeProfileImage`, ADR-0079 7-21) — a new upload is a new address, so the browser shows no
 * old image under it, and no face held keeps the old address. A 429 that asks to
 * wait at most 10 seconds — the API busy for the moment: the uploads it receives, the account's
 * three in flight, its memory, the conversion queue — is waited out and the file sent again, twice
 * at most, the mutation pending meanwhile ('올리는 중'), as the post editor sends its images again
 * (`sendRetrying`, #46's owner decision 2026-10-22 (2차) answer 3 — the same upload path,
 * ADR-0079 7-18). The 403 for another account asks for the session again; an ONBOARDING_REQUIRED — a
 * revision asked for the consent again while the screen was open — asks `['me']` again, and the
 * gate, or on MY 설정 the step (`useSettingsStep`), takes the member on. A refused file
 * (IMAGE_NOT_ALLOWED) is neither: the card says why.
 */
export function uploadProfileImageOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  put: (upload: ProfileImageUpload) => Promise<Me> = putProfileImage,
  retry: UploadRetrySteps = PROFILE_UPLOAD_RETRY,
) {
  return {
    mutationFn: (upload: ProfileImageUpload) => sendRetrying(() => put(upload), retry),
    // Returned, so `mutateAsync` settles only once `['me']` and the faces hold the answer.
    onSuccess: (me: Me) => storeProfileImage(queryClient, me, onSessionChanged),
    onError: async (error: Error, upload: ProfileImageUpload) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      if (isApiError(error, 'ONBOARDING_REQUIRED')) {
        await refreshOwnMe(queryClient, upload.expectedAccountId);
      }
    },
  };
}

/** `uploadProfileImageOptions` as MY 설정's 프로필 이미지 card's upload. */
export function useUploadProfileImage() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(uploadProfileImageOptions(queryClient, () => void refetchSession()));
}

async function postDeleteProfileImage(body: DeleteProfileImageBody): Promise<Me> {
  return unwrap(await api.POST('/api/v1/me/profile-image/delete', { body })).data;
}

/**
 * `POST /me/profile-image/delete` (#141) as mutation options: the image goes at once, and the
 * answer's `imageUrl: null` goes into `['me']` and onto every face of the member the tab holds
 * (`storeProfileImage`, as an upload's answer), so the card, every observer and every byline draw
 * the nickname's first letter again. Sign-in is all it needs (a deletion — re-consent accounts too,
 * owner decision 2026-10-22, as the 소개 and the categories on #41), so the only refusal it acts on
 * is the 403 for another account: the session is asked again.
 */
export function deleteProfileImageOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (body: DeleteProfileImageBody) => Promise<Me> = postDeleteProfileImage,
) {
  return {
    mutationFn: post,
    onSuccess: (me: Me) => storeProfileImage(queryClient, me, onSessionChanged),
    onError: (error: Error) => {
      if (isForAnotherAccount(error)) onSessionChanged();
    },
  };
}

/** `deleteProfileImageOptions` as MY 설정's 프로필 이미지 card's deletion. */
export function useDeleteProfileImage() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(deleteProfileImageOptions(queryClient, () => void refetchSession()));
}

/**
 * `PUT /api/v1/me/time-zone` (ADR-0063) as mutation options: the zone to read times in, or
 * `null` to follow the browser again, and the account the screen shows (`expectedAccountId`,
 * A-PG-24 — the server refuses a cookie of another account before it writes). The answer's
 * profile goes into `['me']` through `storeMe`, as the nickname's does, so TimeZoneProvider
 * switches every time on screen without a refetch — and a `GET /me` that left before the PUT
 * cannot switch them back. The 403 for another account asks for the session again, as the
 * verification's do, so SessionCacheGuard puts the account really signed in on screen.
 */
export function updateTimeZoneOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  put: (body: UpdateTimeZoneBody) => Promise<Me> = putTimeZone,
) {
  return {
    mutationFn: put,
    // Returned, so `mutateAsync` settles only once `['me']` holds the answer.
    onSuccess: (me: Me) => storeMe(queryClient, me, 'timeZone', onSessionChanged),
    onError: (error: Error) => {
      if (isForAnotherAccount(error)) onSessionChanged();
    },
  };
}

/**
 * `updateTimeZoneOptions` as the settings 시간대 card's mutation. Its body names the account the
 * card shows — the `Me` it was drawn from (`TimeZoneFields`' `accountId`), as the 소개 and
 * nickname cards do — never the session's: in the render between the session naming another
 * account and SessionCacheGuard's reset the session already says B while the card still shows A's
 * zone, and a save naming B would switch B's times (ADR-0090). So it offers no account of its own,
 * and nothing waits for the session: the card is drawn only once `GET /me` answered.
 */
export function useUpdateTimeZone() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(updateTimeZoneOptions(queryClient, () => void refetchSession()));
}

/** Query key rule from PLAN 11.5. */
export const ACCOUNTS_QUERY_KEY = ['me', 'accounts'] as const;

/**
 * better-auth `listAccounts`: the source of truth for `account` rows (incl. the row id
 * `unlinkAccount` takes) and therefore for "does this user have a password yet".
 *
 * Lives here rather than in either settings section because both of them observe this one
 * key: whichever renders last owns the fetch, so a queryFn written twice would make the
 * error message depend on render order. The catch is belt-and-braces: `fetchOrNetworkError`
 * already turns a transport failure into an ordinary `{ error }`, so nothing should reach
 * it, but a throw from anywhere else must still not surface an English message.
 */
export function useLinkedAccounts() {
  return useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: async () => {
      let result;
      try {
        result = await authClient.listAccounts();
      } catch {
        throw new Error(copy.errNetwork);
      }
      if (result.error) throw new Error(authErrorMessage(result.error));
      return result.data;
    },
  });
}
