import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { type ImageContentType, type UploadedImage } from '@buddha/shared';
import { type ObjectStorage } from '@buddha/storage';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DB } from '../infra/db/db.provider.js';
import { IMAGE_EXTENSION, processImage } from './image.js';
import { OBJECT_STORAGE } from './object-storage.provider.js';
import { removeUnrecordedUpload } from './unrecorded-upload.js';

/** An image `GET /media/:mediaId` may serve: where its bytes are, their type and how many. */
export interface ShownImage {
  readonly storageKey: string;
  readonly contentType: ImageContentType;
  /** The stored object's size, which the read holds while it answers (`imageReads`). */
  readonly byteSize: number;
}

/**
 * 올린 이미지 (#46, ADR-0073): the upload of a post's image and its public read. The API is the
 * only way in and out of the store (ADR-0069 decision 2 #45-3: the browser never writes to it, and
 * the bucket is private), so whether an image may be shown is decided here on every read.
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
   * attached to anything: a post takes it by its id when it is written (PostsService), and an upload
   * nothing takes is removed by the worker after ORPHAN_MEDIA_HOURS.
   *
   * The object is written before its row, so a row never names an object that is not there; if
   * the row then fails, the object is removed again (`removeUnrecordedUpload` — a removal the
   * store refuses queues its key for the worker), and the row's error is what the request fails
   * with.
   */
  async uploadPostImage(ownerId: string, bytes: Uint8Array): Promise<UploadedImage> {
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
   * One image, while a post shows it: attached to a post that is neither deleted nor hidden, and
   * in that post's current body (`posts.image_ids` — an image an edit took out stays for the
   * operators' history and is no longer served). Null otherwise, whoever asks: an upload nothing
   * took yet, a hidden or deleted post's image (#45-5) and an unknown id answer alike. The row
   * only — the bytes are `bytesOf`'s, so a revalidation that ends in a 304 reads no object.
   */
  async findShown(mediaId: string): Promise<ShownImage | null> {
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
          isNull(posts.deletedAt),
          isNull(posts.hiddenAt),
          sql`${mediaObjects.id} = ANY(${posts.imageIds})`,
        ),
      );
    return row
      ? {
          storageKey: row.storageKey,
          contentType: row.contentType as ImageContentType,
          byteSize: row.byteSize,
        }
      : null;
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
