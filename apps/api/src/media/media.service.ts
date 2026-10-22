import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { type ImageContentType, type UploadedImage } from '@buddha/shared';
import { type ObjectStorage } from '@buddha/storage';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { DB } from '../infra/db/db.provider.js';
import { assertNotWritingRestricted } from '../moderation/restrictions.js';
import { IMAGE_EXTENSION, processImage } from './image.js';
import { OBJECT_STORAGE } from './object-storage.provider.js';
import { removeUnrecordedUpload } from './unrecorded-upload.js';

/**
 * An image a read may serve (`GET /media/:mediaId`, and an admin's notice image, #138): where its
 * bytes are, their type and how many.
 */
export interface ShownImage {
  readonly storageKey: string;
  readonly contentType: ImageContentType;
  /** The stored object's size, which the read holds while it answers (`imageReads`). */
  readonly byteSize: number;
}

/**
 * 올린 이미지 (#46, ADR-0073): the upload of a post's image and the public read of every image — a
 * post's, a pinned notice's (#138), and a member's profile image (#141, ADR-0079, whose writes are
 * ProfileImageService's). The API is the only way in and out of the store (ADR-0069 decision 2
 * #45-3: the browser never writes to it, and the bucket is private), so whether an image may be
 * shown is decided here on every read.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /**
   * Checks, converts and stores one upload of `ownerId` (`processImage`), then records it — not yet
   * attached to anything: a post takes it by its id when it is written (PostsService), or a notice
   * an admin writes in the same editor (NoticesService, #138), and an upload nothing takes is
   * removed by the worker after ORPHAN_MEDIA_HOURS.
   *
   * The object is written before its row, so a row never names an object that is not there; if
   * the row then fails, the object is removed again (`removeUnrecordedUpload` — a removal the
   * store refuses queues its key for the worker), and the row's error is what the request fails
   * with.
   */
  async uploadPostImage(ownerId: string, bytes: Uint8Array): Promise<UploadedImage> {
    // A post's image is for a post the account writes or edits, which a writing restriction
    // refuses (#185): refused here too, before anything is decoded or stored (RESTRICTED, with its
    // end). The post's own write asks again under its lock (`assertWriter`).
    await assertNotWritingRestricted(this.db, ownerId);
    // #187 plugs in here: the daily upload limit (50 a day, counted per verified number's keyed
    // hash, ADR-0069 decision 7) is checked before anything is decoded or stored.
    const image = await processImage(bytes);
    const id = randomUUID();
    const storageKey = `post-images/${id}.${IMAGE_EXTENSION[image.contentType]}`;
    await this.storage.put(storageKey, image.body, image.contentType);
    try {
      await this.db.insert(schema.mediaObjects).values({
        id,
        ownerId,
        kind: 'post_image',
        storageKey,
        contentType: image.contentType,
        byteSize: image.body.length,
        width: image.width,
        height: image.height,
      });
    } catch (error) {
      const { db, storage, logger } = this;
      await removeUnrecordedUpload({ db, storage, logger }, storageKey);
      throw error;
    }
    return {
      id,
      contentType: image.contentType,
      width: image.width,
      height: image.height,
      byteSize: image.body.length,
    };
  }

  /**
   * One image, while something shows it:
   *
   * - a post's image while a post shows it: attached to a post that is neither deleted nor hidden,
   *   and in that post's current body (`posts.image_ids` — an image an edit took out stays for the
   *   operators' history and is no longer served);
   * - a notice's image while it is in the current body of a PINNED notice (#138: only a pinned
   *   notice is public, owner decision 2026-10-21 — an unpinned one's images answer like a missing
   *   one, as its page does; admins see them through `findNoticeImage`);
   * - a profile image while it is its member's profile image (`profiles.image_id`, #141) — the
   *   profile is public (#37-1) and so are the bylines that show it. A replaced or deleted one is
   *   gone already (ProfileImageService), and one an operator removed (#50) is kept for operators
   *   only and served to nobody (#37-10).
   *
   * Each by its own kind: a post's or a notice's image is a `post_image` (the editor's upload), a
   * profile's a `profile_image`, so no image is served as the other. Null otherwise, whoever asks:
   * an upload nothing took yet, a hidden or deleted post's image (#45-5), an unpinned notice's and
   * an unknown id answer alike. The row only — the bytes are `bytesOf`'s, so a revalidation that
   * ends in a 304 reads no object.
   */
  async findShown(mediaId: string): Promise<ShownImage | null> {
    return (
      (await this.findShownByPost(mediaId)) ??
      (await this.findShownOnProfile(mediaId)) ??
      (await this.findShownByNotice(mediaId))
    );
  }

  /** `findShown` for a post's image: the read #46 wrote, the one most images take. */
  private async findShownByPost(mediaId: string): Promise<ShownImage | null> {
    const { mediaObjects, postImages, posts } = schema;
    const [row] = await this.db
      .select({
        storageKey: mediaObjects.storageKey,
        contentType: mediaObjects.contentType,
        byteSize: mediaObjects.byteSize,
      })
      .from(mediaObjects)
      .innerJoin(postImages, eq(postImages.mediaId, mediaObjects.id))
      .innerJoin(posts, eq(posts.id, postImages.postId))
      .where(
        and(
          eq(mediaObjects.id, mediaId),
          eq(mediaObjects.kind, 'post_image'),
          isNull(posts.deletedAt),
          isNull(posts.hiddenAt),
          sql`${mediaObjects.id} = ANY(${posts.imageIds})`,
        ),
      );
    return row ? shownImage(row) : null;
  }

  /**
   * `findShown` for a profile image (#141): by the owner's profile (its primary key) and the image
   * it names — `profiles_image_fk` holds that a profile names only its own account's profile image.
   */
  private async findShownOnProfile(mediaId: string): Promise<ShownImage | null> {
    const { mediaObjects, profiles } = schema;
    const [row] = await this.db
      .select({
        storageKey: mediaObjects.storageKey,
        contentType: mediaObjects.contentType,
        byteSize: mediaObjects.byteSize,
      })
      .from(mediaObjects)
      .innerJoin(
        profiles,
        and(eq(profiles.userId, mediaObjects.ownerId), eq(profiles.imageId, mediaObjects.id)),
      )
      .where(and(eq(mediaObjects.id, mediaId), eq(mediaObjects.kind, 'profile_image')));
    return row ? shownImage(row) : null;
  }

  /**
   * `findShown` for a notice's image (#138): in the current body of the notice that holds it, while
   * that notice is pinned.
   */
  private async findShownByNotice(mediaId: string): Promise<ShownImage | null> {
    const { mediaObjects, noticeImages, notices } = schema;
    const [row] = await this.db
      .select({
        storageKey: mediaObjects.storageKey,
        contentType: mediaObjects.contentType,
        byteSize: mediaObjects.byteSize,
      })
      .from(mediaObjects)
      .innerJoin(noticeImages, eq(noticeImages.mediaId, mediaObjects.id))
      .innerJoin(notices, eq(notices.id, noticeImages.noticeId))
      .where(
        and(
          eq(mediaObjects.id, mediaId),
          eq(mediaObjects.kind, 'post_image'),
          isNotNull(notices.pinnedAt),
          sql`${mediaObjects.id} = ANY(${notices.imageIds})`,
        ),
      );
    return row ? shownImage(row) : null;
  }

  /**
   * An image of one notice for the admin screens (`GET /admin/notices/:noticeId/images/:mediaId`,
   * #138): any image the notice holds (`notice_images`) — in its current body or only in an earlier
   * version — pinned or not, since the admin's edit screen and its earlier versions show them all
   * (owner decision 2026-10-21: an unpinned notice is shown on the admin screens). Null for an
   * image the notice does not hold.
   */
  async findNoticeImage(noticeId: string, mediaId: string): Promise<ShownImage | null> {
    const { mediaObjects, noticeImages } = schema;
    const [row] = await this.db
      .select({
        storageKey: mediaObjects.storageKey,
        contentType: mediaObjects.contentType,
        byteSize: mediaObjects.byteSize,
      })
      .from(mediaObjects)
      .innerJoin(noticeImages, eq(noticeImages.mediaId, mediaObjects.id))
      .where(and(eq(mediaObjects.id, mediaId), eq(noticeImages.noticeId, noticeId)));
    return row ? shownImage(row) : null;
  }

  /**
   * Any stored image, whatever shows it — for operators only (`GET /admin/media/:mediaId`, #50): a
   * hidden or deleted post's, an earlier version's, a profile image an operator removed and keeps
   * (#37-10). Null for an unknown id.
   */
  async findStored(mediaId: string): Promise<ShownImage | null> {
    const { mediaObjects } = schema;
    const [row] = await this.db
      .select({
        storageKey: mediaObjects.storageKey,
        contentType: mediaObjects.contentType,
        byteSize: mediaObjects.byteSize,
      })
      .from(mediaObjects)
      .where(eq(mediaObjects.id, mediaId));
    return row ? shownImage(row) : null;
  }

  /**
   * The bytes of a shown image, or null when its object is gone (logged: no request causes it).
   * `signal` gives the read up (the client went): it then rejects.
   */
  async bytesOf(image: ShownImage, signal?: AbortSignal): Promise<Uint8Array | null> {
    const body = await this.storage.get(image.storageKey, { signal });
    if (body === null) {
      this.logger.error({ storageKey: image.storageKey }, 'a shown image has no object');
    }
    return body;
  }
}

function shownImage(row: {
  storageKey: string;
  contentType: string;
  byteSize: number;
}): ShownImage {
  return {
    storageKey: row.storageKey,
    contentType: row.contentType as ImageContentType,
    byteSize: row.byteSize,
  };
}
