import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { type ImageContentType, type UploadedImage } from '@buddha/shared';
import { type ObjectStorage } from '@buddha/storage';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DB } from '../infra/db/db.provider.js';
import { IMAGE_EXTENSION, processImage } from './image.js';
import { OBJECT_STORAGE } from './object-storage.provider.js';

/** An image `GET /media/:mediaId` may serve: where its bytes are, their type and how many. */
export interface ShownImage {
  readonly storageKey: string;
  readonly contentType: ImageContentType;
  /** The stored object's size, which the read holds while it answers (`imageReads`). */
  readonly byteSize: number;
}

/** `media_deletions.last_error` keeps this much of a refusal, as the worker's retries do. */
const LAST_ERROR_MAX_LENGTH = 1_000;

/**
 * What a failure says, for the log and `last_error`: its message, led by its cause's when it has
 * one (drizzle's "Failed query: …" wraps the driver's error, which says what went wrong).
 */
function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
  return cause === undefined ? message : `${cause} — ${message}`;
}

/**
 * One log line, its words then its fields as JSON — Nest's `Logger` takes a string (an object
 * would lose an Error's message), as the memory admission's lines do (`nestAdmissionLogger`).
 */
function logLine(message: string, fields: Record<string, unknown>): string {
  return `${message} ${JSON.stringify(fields)}`;
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
   * the row then fails, the object is removed again (`removeUnrecorded` — a removal the store
   * refuses queues its key for the worker), and the row's error is what the request fails with.
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
      await this.removeUnrecorded(storageKey);
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
   * Removes the object of an upload whose row could not be written (`uploadPostImage`). No row
   * names it, so when the store refuses the removal (a transient S3 error, say) its key is queued
   * for the worker's retries instead (`media_deletions`, ADR-0073 9-45 — due from the next hourly
   * run on, this refusal counted as the first): dropped, the key would be lost and the private
   * upload would stay in the store for good. The queueing is its own transaction, never the one
   * the row failed in, and only does its best: when it fails too (most likely the database that
   * failed the row), the key is in the error log with both failures, for an operator to remove.
   * Never throws: the caller fails with the row's error.
   */
  private async removeUnrecorded(storageKey: string): Promise<void> {
    let refusal: string;
    try {
      await this.storage.delete(storageKey);
      return;
    } catch (refused) {
      refusal = reasonOf(refused);
    }
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(schema.mediaDeletions).values({
          storageKey,
          attempts: 1,
          lastError: refusal.slice(0, LAST_ERROR_MAX_LENGTH),
        });
      });
    } catch (failed) {
      this.logger.error(
        logLine('could not remove an unrecorded upload, nor queue its key', {
          storageKey,
          refusal,
          queueing: reasonOf(failed),
        }),
      );
      return;
    }
    this.logger.warn(
      logLine('could not remove an unrecorded upload; queued its key', { storageKey, refusal }),
    );
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
