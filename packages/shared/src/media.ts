import * as z from 'zod';

/**
 * Uploaded images (#46, ADR-0073; ADR-0069 decision 2 #45-3). The owner's rules for a post's
 * images: JPEG, PNG, WebP or GIF, at most 5MB each and POST_IMAGES_MAX per post; the server takes
 * the upload, checks it by its content — never by the name or the type the browser claims —
 * removes the EXIF and every other piece of metadata, shrinks the long side to at most
 * IMAGE_MAX_DIMENSION pixels, keeps a GIF moving, and stores the result in the private bucket.
 * The browser never writes to storage.
 *
 * A member's profile image (#141, ADR-0079; ADR-0069 decision 3 #37-6) goes the same way into the
 * same store: JPEG, PNG or WebP (PROFILE_IMAGE_CONTENT_TYPES), at most IMAGE_MAX_BYTES, checked by
 * its content, cropped by the server to a square of at most PROFILE_IMAGE_SIZE and stored without
 * metadata. Both are refused when very thin or long (a frame's long side more than 32 times its
 * short side — apps/api's image.ts, IMAGE_MAX_SIDE_RATIO).
 */

/**
 * What an upload is for: an image of a post (#46), or a member's profile image (#141) — which is
 * the profile's from its upload on and never waits to be taken (ADR-0079).
 */
export const MEDIA_KINDS = ['post_image', 'profile_image'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** The image types a post takes (#45-3), as the stored object's `Content-Type`. */
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

/**
 * The image types a profile image takes (#37-6: «JPEG·PNG·WebP»): a post's but the GIF. A GIF is
 * refused as any other type is (IMAGE_NOT_ALLOWED `type`), and an animated WebP is kept as its
 * first frame (ADR-0079).
 */
export const PROFILE_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ProfileImageContentType = (typeof PROFILE_IMAGE_CONTENT_TYPES)[number];

/**
 * An upload's largest size (#45-3: «한 장 5MB»), in bytes: 5 MiB. The binary megabyte, so a file
 * a computer shows as 5MB passes whichever unit it uses. A profile image's too (#37-6: «5MB»).
 */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** The long side of a stored image at most (#45-3: «긴 변 2,048px 이하»). */
export const IMAGE_MAX_DIMENSION = 2_048;

/**
 * The side of a stored profile image at most, in pixels (#37-6: «정사각 512px»): the middle square
 * of the upload, scaled down to this when it is larger. A smaller one keeps its own size — it is
 * never enlarged (owner decision 2026-10-22: «512px보다 작은 프로필 이미지 → 키우지 않음(정사각으로만
 * 자르고 제 크기, 512는 최대)», ADR-0079).
 */
export const PROFILE_IMAGE_SIZE = 512;

/**
 * The most pixels the server decodes, every frame of an animation together — against a
 * decompression bomb (a small file can unpack into an enormous image) and the time a long
 * animation takes. 50 megapixels holds any photo a phone takes, and a GIF animation of 200 frames
 * at 500×500. Tighter bounds, measured on the whole conversion, are apps/api's image.ts's
 * (ADR-0073 9-8): one frame's by its kind, what the decoder and the encoders hold of it at once
 * fitting the API's memory — and a GIF animation's frame its own, its thin frames stacking up in
 * the resize; a WebP animation is decoded whole before it is resized, so its frames together have
 * a far smaller bound (`WEBP_ANIMATION_MAX_PIXELS`, 12 megapixels — 48 frames at 500×500).
 */
export const IMAGE_MAX_INPUT_PIXELS = 50_000_000;

/**
 * An upload nothing took is removed this many hours after it was uploaded (the worker's
 * `media.orphan_cleanup`, hourly): an image picked for a post that was never written. A day leaves
 * a writer an evening to finish; a post sent later than that refuses the image and the editor
 * uploads it again.
 */
export const ORPHAN_MEDIA_HOURS = 24;

/**
 * The path an image is read from, relative to the site (the web proxies `/api`, ADR-0017): a
 * post's image and a profile image alike. A new upload has a new id, so a replaced profile image
 * is a new address and no cache shows the old one under it (ADR-0079).
 */
export function mediaPath(mediaId: string): string {
  return `/api/v1/media/${mediaId}`;
}

/**
 * The answer of `POST /media/images`: the stored image. Its id goes into the post's image node
 * (`{ type: 'image', attrs: { mediaId } }`); it is served once a post shows it, so the editor
 * previews the file it picked.
 */
export const uploadedImageSchema = z
  .object({
    id: z.uuid(),
    contentType: z.enum(IMAGE_CONTENT_TYPES),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    byteSize: z.number().int().min(1),
  })
  .meta({ id: 'UploadedImage' });
export type UploadedImage = z.infer<typeof uploadedImageSchema>;

/**
 * `POST /media/images?expectedAccountId=…` and `PUT /me/profile-image?expectedAccountId=…`: the
 * body is the file itself, so the account rides in the query.
 */
export const uploadImageQuerySchema = z.object({
  expectedAccountId: z.string().min(1).max(255),
});
export type UploadImageQuery = z.infer<typeof uploadImageQuerySchema>;

/**
 * Why an upload was refused (IMAGE_NOT_ALLOWED): `type` — its content is not a JPEG, PNG, WebP or
 * GIF (a profile image: not a JPEG, PNG or WebP), whatever its name or declared type says; `size` —
 * larger than IMAGE_MAX_BYTES; `pixels` — an image (one frame of an animation) too large to
 * convert: more pixels than its kind's bound (what decoding it takes, and for a WebP animation and a
 * GIF animation what encoding it again takes — apps/api's image.ts; a still WebP with alpha is
 * written smaller instead, owner decision 2026-10-22 answer 1), or than IMAGE_MAX_INPUT_PIXELS, or
 * so thin that converting it costs far more than its pixels (its long side more than 32 times its
 * short side, owner decision 2026-10-21 (2차) answer 1 — a profile image's too, ADR-0079);
 * `frames` — an animation whose frames each fit but together decode to more than
 * IMAGE_MAX_INPUT_PIXELS, or a WebP animation's own smaller bound (too many frames, not too large a
 * picture); `unreadable` — it says it is one of the four and does not decode as one (a JPEG of more
 * than four components too); `empty` — no bytes.
 */
export const IMAGE_REFUSALS = ['type', 'size', 'pixels', 'frames', 'unreadable', 'empty'] as const;
export type ImageRefusal = (typeof IMAGE_REFUSALS)[number];
export const imageNotAllowedDetailsSchema = z
  .object({ reason: z.enum(IMAGE_REFUSALS) })
  .meta({ id: 'ImageNotAllowedDetails' });
export type ImageNotAllowedDetails = z.infer<typeof imageNotAllowedDetailsSchema>;
