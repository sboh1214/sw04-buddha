import { AppError } from '../common/errors/app-error.js';

/**
 * The bytes of the image reads the API may hold at once, process-wide (`GET /media/:mediaId`,
 * ADR-0073 decision 9-36). Implementation-chosen; the owner kept it as built (owner decision
 * 2026-10-20), and the retry second with it.
 *
 * A read holds its whole image (the store answers with the bytes, at most a few MB each) from the
 * storage read until its answer has been handed to the socket — for a client that reads slowly or
 * not at all, as long as that client likes. The per-address limit counts requests in a fixed
 * window (`mediaRead`, 600 a minute — owner decision 2026-10-19), not what they hold: one address
 * could have hundreds of reads in flight and their images in the API's memory together, past the
 * container's 448MiB (deploy/compose.yaml). The bound is in bytes, not reads, so a page of small
 * thumbnails is not refused for the size a few large GIFs would take: 32MiB is some forty ordinary
 * photos (2,048px JPEG, under 1MB) or six animated GIFs near 5MB, beside decision 9-8's 128MiB for
 * a conversion and the heap.
 */
export const IMAGE_READ_BUDGET_BYTES = 32 * 1024 * 1024;

/** How long a client refused for a full budget waits before reading again. */
export const IMAGE_READ_BUSY_RETRY_SECONDS = 1;

/**
 * A budget of bytes held at once: `take` gives a share back as a `release` (idempotent), or null
 * when the share would pass the budget. A budget holding nothing takes any one share, however
 * large, so no image is refused for its own size alone.
 */
export class ByteBudget {
  private held = 0;

  constructor(private readonly max: number) {}

  /** The bytes held now. */
  get size(): number {
    return this.held;
  }

  take(bytes: number): (() => void) | null {
    if (this.held > 0 && this.held + bytes > this.max) return null;
    this.held += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held -= bytes;
    };
  }
}

/** The API's image reads (MediaController.read): one budget for the process. */
export const imageReads = new ByteBudget(IMAGE_READ_BUDGET_BYTES);

/** The refusal of a read past the budget: the client reads again in a moment. */
export function imageReadsBusy(): AppError {
  return new AppError('RATE_LIMITED', {
    message: 'Too many images are being sent; read it again',
    details: { retryAfterSeconds: IMAGE_READ_BUSY_RETRY_SECONDS },
  });
}
