import { AppError } from '../common/errors/app-error.js';
import { ByteBudget } from './byte-budget.js';

/**
 * The bytes of the image reads the API may hold at once, process-wide (`GET /media/:mediaId`,
 * ADR-0073 decision 9-36). Implementation-chosen; the owner kept it as built (owner decision
 * 2026-10-20 answer 4), and the retry second with it.
 *
 * A read holds its whole image (the store answers with the bytes, at most a few MB each) from the
 * storage read until its answer has been handed to the socket — for a client that reads slowly or
 * not at all, as long as that client likes. The per-address limit counts requests in a fixed
 * window (`mediaRead`, 600 a minute — owner decision 2026-10-19), not what they hold: one address
 * could have hundreds of reads in flight and their images in the API's memory together, past the
 * container's 448MiB (deploy/compose.yaml). The bound is in bytes, not reads, so a page of small
 * thumbnails is not refused for the size a few large GIFs would take: 32MiB is some forty ordinary
 * photos (2,048px JPEG, under 1MB) or six animated GIFs near 5MB. It was chosen beside decision
 * 9-8's 128MiB for a conversion, as it was then, and the heap; a conversion is now bounded at
 * IMAGE_CONVERSION_PEAK_BYTES (144MiB, image.ts). A read within the budget is still asked of the
 * API's memory before the store is read (`memoryAdmission`, owner decision 2026-10-22 answer 3,
 * ADR-0073 9-46): every budget full at once and the API's own use (~150MiB resident at idle in
 * its container) come within a few MiB of the container's 448MiB, and the heap grows with the
 * requests, so it is the process's RSS that decides whether one more fits. A read does not wait
 * for a running conversion's share there: the upload bodies and the conversions keep room for
 * what of this budget is not taken instead, so a conversion does not hold every image read back.
 */
export const IMAGE_READ_BUDGET_BYTES = 32 * 1024 * 1024;

/** How long a client refused for a full budget waits before reading again. */
export const IMAGE_READ_BUSY_RETRY_SECONDS = 1;

/**
 * The API's image reads (MediaController.read): one budget for the process. Holding nothing, it
 * takes any one image, so no image is refused for its own size alone.
 */
export const imageReads = new ByteBudget(IMAGE_READ_BUDGET_BYTES);

/** The refusal of a read past the budget: the client reads again in a moment. */
export function imageReadsBusy(): AppError {
  return new AppError('RATE_LIMITED', {
    message: 'Too many images are being sent; read it again',
    details: { retryAfterSeconds: IMAGE_READ_BUSY_RETRY_SECONDS },
  });
}
