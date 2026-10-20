import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { type ObjectStorage } from '@buddha/storage';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { assertPublicItemEdit, assertPublicItemOnboarding } from '../me/public-items.js';
import { IMAGE_EXTENSION, processProfileImage } from '../media/image.js';
import { OBJECT_STORAGE } from '../media/object-storage.provider.js';

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
 *   row in the write's transaction, its object right after the commit (`removeObject`). Only an
 *   image an operator removes is kept, for operators (#37-10) — #50's, which clears
 *   `profiles.image_id` and leaves the row, attached and shown by nothing.
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
  ) {}

  /**
   * `PUT /me/profile-image`: checks and converts the upload, stores it as the member's profile
   * image and removes the one it replaces. A new image is a new value of a public item, so the
   * restriction is asked before anything is decoded — a conversion is the dearest step — and again
   * under the lock, with the onboarding (OnboardedGuard asked it before the handler ran, so the
   * conversion is never paid for; this holds it to the commit), where the answers hold until the
   * write commits. The guard runs after Fastify has read the body: refusing an unonboarded account
   * before the body is read is the restack's (ADR-0079 결과 5).
   *
   * The object is written before its row, as a post's upload is (MediaService): a row never names
   * an object that is not there, and when the transaction fails the object is removed again (a
   * removal that fails too leaves bytes nothing names, which no reader can reach — logged).
   *
   * #187's daily upload limit (50 a day per verified number's keyed hash, ADR-0069 decision 7)
   * plugs in before the conversion, beside MediaService.uploadPostImage's, and counts a profile
   * image with a post's — one count for both (owner decision 2026-10-22: «#187 하루 업로드 50장 →
   * 프로필 이미지도 함께 셈», ADR-0079).
   */
  async replace(userId: string, bytes: Uint8Array): Promise<void> {
    await assertPublicItemEdit(this.db, userId, 'replace');
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
      // Only a write that did not commit: the new object is nobody's.
      await this.storage.delete(storageKey).catch((cleanup: unknown) => {
        this.logger.error({ err: cleanup, storageKey }, 'could not remove an unrecorded upload');
      });
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
   * kept), in the write's transaction: from its commit `GET /media/:mediaId` answers 404. Returns
   * the object's key, for `removeObject` after the commit — or null when the row was gone already.
   */
  private async removeRow(tx: Tx, imageId: string): Promise<string | null> {
    const [removed] = await tx
      .delete(schema.mediaObjects)
      .where(eq(schema.mediaObjects.id, imageId))
      .returning({ storageKey: schema.mediaObjects.storageKey });
    return removed?.storageKey ?? null;
  }

  /**
   * Removes the object of an image whose row went with a committed write — after the commit, as the
   * worker's orphan clean-up does (ADR-0073 decision 6), never inside the transaction: a slow store
   * then holds no profile lock and no pooled connection (Postgres ends a session idle in a
   * transaction after 30 seconds), and a commit lost after the object went can never leave a
   * profile naming an image without bytes. Best effort: a store that will not remove it leaves
   * bytes nothing names, which no reader can reach — logged with the key for an operator, and the
   * member's change stands (ADR-0079 7-5; whether it should is the owner's question in 결과 4).
   */
  private async removeObject(storageKey: string): Promise<void> {
    await this.storage.delete(storageKey).catch((error: unknown) => {
      this.logger.error(
        { err: error, storageKey },
        'could not remove a replaced or deleted profile image',
      );
    });
  }
}
