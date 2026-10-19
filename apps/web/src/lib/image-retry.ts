/**
 * Our images drawn again after a refusal that only asked to wait (#46, ADR-0073 decision 9-39). The
 * API answers an image read with 429 and `Retry-After` while the images it is sending hold the
 * process's budget (decision 9-36) or the reader's address has spent its minute (`mediaRead`); a
 * plain `<img>` takes that as a broken image and never asks again, so a post's images and the
 * cards' thumbnails stayed broken until the page was drawn afresh. The element cannot read the
 * answer's status or headers, so on its error the image is asked for once more with `fetch`
 * (`recoverImage`), which can: a 429 waits the second its `Retry-After` names and asks again, an
 * image that comes back is in the browser's cache — the API sends `no-cache` with an ETag, so the
 * element drawing it again gets a 304, which the API answers without the budget — and anything else
 * (a 404: the post was hidden or deleted meanwhile) leaves it broken. Bounded: IMAGE_RETRY_ATTEMPTS
 * requests for an image in all, each wait at most IMAGE_RETRY_MAX_WAIT_MS.
 *
 * Pure apart from what it is handed (`fetch`, `sleep`), so the node test runner drives it
 * (image-retry.test.ts); components/post/retried-image.tsx puts it on the element.
 */

/** How many times in all an image that failed is asked for again before it stays broken. */
export const IMAGE_RETRY_ATTEMPTS = 3;

/** The longest wait a `Retry-After` can ask of an image: the address limit's minute. */
export const IMAGE_RETRY_MAX_WAIT_MS = 60_000;

/** The wait when a 429 names none it can be read by: the image read's own second. */
export const IMAGE_RETRY_DEFAULT_WAIT_MS = 1_000;

/**
 * The wait a `Retry-After` asks for, in milliseconds: delay-seconds or an HTTP date (RFC 9110
 * §10.2.3), at least 0 and at most IMAGE_RETRY_MAX_WAIT_MS; IMAGE_RETRY_DEFAULT_WAIT_MS when there
 * is none or it reads as neither.
 */
export function retryAfterMs(header: string | null, now: number = Date.now()): number {
  const value = header?.trim() ?? '';
  if (value === '') return IMAGE_RETRY_DEFAULT_WAIT_MS;
  // An HTTP date names its day and month in letters; anything else is not one (V8's `Date.parse`
  // reads '-3' as a year).
  const wait = /^\d+$/.test(value)
    ? Number(value) * 1_000
    : /[a-z]/i.test(value)
      ? Date.parse(value) - now
      : Number.NaN;
  if (Number.isNaN(wait)) return IMAGE_RETRY_DEFAULT_WAIT_MS;
  return Math.min(Math.max(wait, 0), IMAGE_RETRY_MAX_WAIT_MS);
}

/** The requests an image has left (`IMAGE_RETRY_ATTEMPTS` at first), spent across its recoveries. */
export interface ImageRetryBudget {
  left: number;
}

/** What `recoverImage` is handed: the browser's `fetch` and a wait, both given up by `signal`. */
export interface ImageRecoveryDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
}

/**
 * Whether the image at `src`, which failed to load, can be drawn again now: asks for it while the
 * budget lasts, waiting out each 429's `Retry-After`. True once an answer brought the image (read
 * whole, so it is in the cache for the element); false for any other answer, or when the budget is
 * spent. Rejects when `fetch` does (the network, or `signal`).
 */
export async function recoverImage(
  src: string,
  budget: ImageRetryBudget,
  deps: ImageRecoveryDeps,
): Promise<boolean> {
  while (budget.left > 0) {
    budget.left -= 1;
    const answer = await deps.fetch(src, { signal: deps.signal });
    if (answer.ok) {
      await answer.arrayBuffer();
      return true;
    }
    await answer.body?.cancel();
    if (answer.status !== 429 || budget.left === 0) return false;
    await deps.sleep(retryAfterMs(answer.headers.get('retry-after')), deps.signal);
  }
  return false;
}

/** A wait of `ms` that `signal` gives up (rejecting with its reason). */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}
