import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { ORPHAN_MEDIA_RETRY_SLACK_MINUTES, orphanMediaRetryHours } from '@buddha/shared';
import { type ObjectStorage } from '@buddha/storage';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { assertPublicItemEdit, assertPublicItemOnboarding } from '../me/public-items.js';
import { IMAGE_EXTENSION, processProfileImage } from '../media/image.js';
import { OBJECT_STORAGE } from '../media/object-storage.provider.js';
import {
  LAST_ERROR_MAX_LENGTH,
  logLine,
  reasonOf,
  removeUnrecordedUpload,
} from '../media/unrecorded-upload.js';
import { WriteLimitsService } from '../write-limits/write-limits.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The store's prefix of profile images: `profile-images/<id>.<ext>`, a new id per upload. */
export const PROFILE_IMAGE_KEY_PREFIX = 'profile-images';

/**
 * 프로필 이미지 (#141, ADR-0079; ADR-0069 decision 3 #37-6, decision 4 #141): the member's own
 * upload and deletion of its profile image, in the media store and table of #46 (`media_objects`,
 * kind `profile_image`) — the public read is `GET /media/:mediaId` (MediaService.findShown), and
 * the public face carries the image's address (`postAuthorOf`).
 *
 * - Direct upload only, checked and converted by the server (`processProfileImage`: JPEG, PNG or
 *   WebP, 5MB, not very thin or long, the middle cropped to a square of at most 512px — never
 *   enlarged — without EXIF); never a social login's photo (#37-6).
 * - No pre-moderation (decision 4 #141): an image is public from its upload; reports and operator
 *   actions (#50) deal with abuse.
 * - Replacing or deleting removes the earlier image at once (decision 4 #141: «곧바로 지운다»): its
 *   row in the write's transaction, which queues its object's key for removal
 *   (`media_deletions`, #46), its object right after the commit (`removeObject`) — and when the
 *   store will not let it go then, the worker tries again until it does (owner decision
 *   2026-10-22, ADR-0079). Only an image an operator removes is kept, for operators (#37-10) —
 *   #50's, which clears `profiles.image_id` and leaves the row, attached and shown by nothing.
 * - A public profile item (#37-9, decision 7): a new image needs the onboarding done and no
 *   writing or account restriction; a deletion needs sign-in only, whatever the sanction — the one
 *   check point of public-item writes (me/public-items.ts). A re-consent account may delete its
 *   image too (owner decision 2026-10-22: «재동의만 남은 계정의 프로필 이미지 지우기 → 로그인만으로»,
 *   as for the 소개 and the categories on #41).
 *
 * Every change runs under the profile row's lock, so two uploads of one member, or an upload and a
 * deletion, take turns: the later one finds the earlier one's image as the one to remove.
 */
@Injectable()
export class ProfileImageService {
  private readonly logger = new Logger(ProfileImageService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly limits: WriteLimitsService,
  ) {}

  /**
   * `PUT /me/profile-image`: checks and converts the upload, stores it as the member's profile
   * image and removes the one it replaces. A new image is a new value of a public item, so the
   * restriction is asked before anything is decoded — a conversion is the dearest step — and again
   * under the lock, with the onboarding (the body parser's gate asked it before the body was read
   * and OnboardedGuard before the handler ran, so the conversion is never paid for; this holds it to
   * the commit), where the answers hold until the write commits. The controller runs this as part of
   * the upload the gate let in (`runUploadWork`): the account's place among its three uploads in
   * flight is held until it has settled.
   *
   * The object is written before its row, as a post's upload is (MediaService): a row never names
   * an object that is not there, and when the transaction fails the object is removed again —
   * after it has ended, by `removeUnrecordedUpload` (ADR-0073 9-45): a removal the store refuses
   * queues the object's key for the worker in a transaction of its own, which the failed one
   * cannot take back, and only a queueing that fails too leaves the key to the error log, with both
   * reasons. The request fails with the transaction's error either way.
   *
   * #187's daily upload limit (50 a day per verified number's keyed hash, ADR-0069 decision 7) is
   * asked before the conversion, as MediaService.uploadPostImage asks it, and counted with the row
   * under the writer's number lock (WriteLimitsService): a profile image counts with a post's — one
   * count for both (owner decision 2026-10-22: «#187 하루 업로드 50장 → 프로필 이미지도 함께 셈»,
   * ADR-0079). WRITE_LIMITED keeps the image the profile has. The number's lock is taken after the
   * profile's, the order every counted write takes them in (a post, a comment or an edit holds the
   * profile FOR KEY SHARE first, #185's `assertWriter`), so no two wait on each other in turn.
   */
  async replace(userId: string, bytes: Uint8Array): Promise<void> {
    await assertPublicItemEdit(this.db, userId, 'replace');
    await this.limits.precheck(userId, 'upload');
    const image = await processProfileImage(bytes);
    const id = randomUUID();
    const storageKey = `${PROFILE_IMAGE_KEY_PREFIX}/${id}.${IMAGE_EXTENSION[image.contentType]}`;
    await this.storage.put(storageKey, image.body, image.contentType);
    let replaced: string | null;
    try {
      replaced = await this.db.transaction(async (tx) => {
        const earlier = await this.lockProfile(tx, userId);
        await assertPublicItemOnboarding(tx, userId, 'replace');
        await assertPublicItemEdit(tx, userId, 'replace');
        const writer = await this.limits.lockWriter(tx, userId);
        await this.limits.take(tx, writer, 'upload');
        await tx.insert(schema.mediaObjects).values({
          id,
          ownerId: userId,
          kind: 'profile_image',
          storageKey,
          contentType: image.contentType,
          byteSize: image.body.length,
          width: image.width,
          height: image.height,
          // The profile's from this moment: never an upload the orphan clean-up waits on.
          attachedAt: sql`now()`,
        });
        await tx
          .update(schema.profiles)
          .set({ imageId: id })
          .where(eq(schema.profiles.userId, userId));
        return earlier === null ? null : this.removeRow(tx, earlier);
      });
    } catch (error) {
      // Only a write that did not commit: the new object is nobody's, and nothing but this key names
      // it — removed, or its key queued when the store refuses (Codex review on #219).
      const { db, storage, logger } = this;
      await removeUnrecordedUpload({ db, storage, logger }, storageKey);
      throw error;
    }
    if (replaced !== null) await this.removeObject(replaced);
  }

  /**
   * `POST /me/profile-image/delete`: the member deletes its profile image, row and object, and the
   * profile and the bylines draw the nickname's first letter again. Clearing a public item: open
   * with sign-in only and under a restriction (`clear`, asked at the one check point all the same).
   * Nothing to delete changes nothing, whoever sends it.
   */
  async remove(userId: string): Promise<void> {
    const removed = await this.db.transaction(async (tx) => {
      const current = await this.lockProfile(tx, userId);
      if (current === null) return null;
      await assertPublicItemOnboarding(tx, userId, 'clear');
      await assertPublicItemEdit(tx, userId, 'clear');
      await tx
        .update(schema.profiles)
        .set({ imageId: null })
        .where(eq(schema.profiles.userId, userId));
      return this.removeRow(tx, current);
    });
    if (removed !== null) await this.removeObject(removed);
  }

  /** The member's profile row, locked for the write: the image it names now, or null. */
  private async lockProfile(tx: Tx, userId: string): Promise<string | null> {
    const [profile] = await tx
      .select({ imageId: schema.profiles.imageId })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId))
      .limit(1)
      .for('update');
    if (!profile) throw new AppError('NOT_FOUND', { message: 'Profile not found' });
    return profile.imageId;
  }

  /**
   * Removes the row of an image the profile has just let go of (decision 4 #141: at once, not
   * kept), in the write's transaction: from its commit `GET /media/:mediaId` answers 404. The same
   * transaction queues the object's key for removal (`media_deletions`, the worker's queue of
   * #46): once the row is gone nothing else names the object, so the key is kept until the store
   * has removed it — the write commits with it or not at all (owner decision 2026-10-22:
   * «이전 파일은 #46의 삭제 대기열(media_deletions)에 넣어 지울 때까지 다시 시도», ADR-0079). It is
   * due for the worker only after the first wait of the queue's schedule (`orphanMediaRetryHours`,
   * less ORPHAN_MEDIA_RETRY_SLACK_MINUTES): `removeObject` tries it first, right after the commit,
   * and a run of the worker meanwhile does not race that try. Returns the object's key, for
   * `removeObject` — or null when the row was gone already.
   */
  private async removeRow(tx: Tx, imageId: string): Promise<string | null> {
    const [removed] = await tx
      .delete(schema.mediaObjects)
      .where(eq(schema.mediaObjects.id, imageId))
      .returning({ storageKey: schema.mediaObjects.storageKey });
    if (removed === undefined) return null;
    await tx
      .insert(schema.mediaDeletions)
      .values({ storageKey: removed.storageKey, nextAttemptAt: firstRetryAt() })
      // A key is one object's, and a new upload a new key: never queued already.
      .onConflictDoNothing({ target: schema.mediaDeletions.storageKey });
    return removed.storageKey;
  }

  /**
   * Removes the object of an image whose row went with a committed write — after the commit, as the
   * worker's orphan clean-up does (ADR-0073 decision 6), never inside the transaction: a slow store
   * then holds no profile lock and no pooled connection (Postgres ends a session idle in a
   * transaction after 30 seconds), and a commit lost after the object went can never leave a
   * profile naming an image without bytes. The key leaves the queue once the object is gone. A
   * store that will not remove it now leaves the key queued, this refusal counted as its first
   * (`attempts` 1, its error kept, due again after the queue's first wait counted from now), and
   * logged; the worker's `media.orphan_cleanup` tries it again then, and on every later refusal
   * twice as late, at most daily, until the store lets it go (owner decision 2026-10-22, ADR-0079
   * 7-5). The member's change stands either way: its bytes are named by no row and reachable by no
   * reader meanwhile. Each line logs its words and fields as one string, the reasons as plain text
   * (`logLine`·`reasonOf`, as `removeUnrecordedUpload` does): Nest's `Logger` loses an Error's
   * message given as an object.
   */
  private async removeObject(storageKey: string): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch (error) {
      const refusal = reasonOf(error);
      this.logger.error(
        logLine(
          'could not remove a replaced or deleted profile image; its key stays queued for the worker',
          { storageKey, refusal },
        ),
      );
      await this.db
        .update(schema.mediaDeletions)
        .set({
          attempts: 1,
          lastError: refusal.slice(0, LAST_ERROR_MAX_LENGTH),
          nextAttemptAt: firstRetryAt(),
        })
        .where(eq(schema.mediaDeletions.storageKey, storageKey))
        .catch((queue: unknown) => {
          // The key is queued either way (the write's transaction); only the count is lost.
          this.logger.error(
            logLine('could not count a refused removal', {
              storageKey,
              refusal,
              counting: reasonOf(queue),
            }),
          );
        });
      return;
    }
    await this.db
      .delete(schema.mediaDeletions)
      .where(eq(schema.mediaDeletions.storageKey, storageKey))
      .catch((queue: unknown) => {
        // Left queued, the worker removes it again: the store answers a removal of nothing as done.
        this.logger.error(
          logLine('could not unqueue a removed profile image', {
            storageKey,
            unqueueing: reasonOf(queue),
          }),
        );
      });
  }
}

/**
 * When a queued key is due for the worker after the API's own try (`removeRow`, `removeObject`):
 * the queue's first wait from now, less its slack — as a refusal on a run of the worker is due
 * again (apps/worker media-orphan-cleanup.ts).
 */
function firstRetryAt() {
  return sql`now() + make_interval(hours => ${orphanMediaRetryHours(1)}, mins => ${-ORPHAN_MEDIA_RETRY_SLACK_MINUTES})`;
}
