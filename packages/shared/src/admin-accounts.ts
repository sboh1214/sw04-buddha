import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';

/**
 * Admin accounts (운영자 계정, #171). One admin role (`profiles.role = 'admin'`) plus the
 * two-person rule (approvals.ts) — no role split (owner decision 2026-10-13). An existing admin
 * grants or revokes the role on the admin screen with a reason and no other admin's approval;
 * every change appends an `admin_grant` / `admin_revoke` row to `admin_actions` in the
 * transaction that changes the role.
 *
 * - A grant goes only to an account with a verified email that has completed 본인확인, the SMS
 *   verification of its mobile number (ADR-0069 decision 4 #58, ADR-0070; it was a real name and
 *   number on file, ADR-0043, until the verified number replaced them). The seed's bootstrap
 *   admins are the one exception: it creates them before anyone could grant (packages/db
 *   seed.ts), and they verify at their first sign-in like every account.
 * - A revoke that would leave fewer than MIN_ADMINS admins is refused, the revoker's own
 *   included. It applies from the next request: every session of the account is deleted, so it
 *   is signed out everywhere, and AdminGuard takes an admin answer from Postgres only — never
 *   from the role cache, whatever it still holds.
 */

/** The fewest admins a revoke may leave (owner decision 2026-10-13, #171). */
export const MIN_ADMINS = 2;

/** `AdminGrantBody.reason` / `AdminRevokeBody.reason`: stored in admin_actions. */
export const ADMIN_ROLE_REASON_MAX_LENGTH = 500;

/** The reason of the seed's `admin_grant` records (packages/db seed.ts). */
export const SEED_ADMIN_GRANT_REASON = '시드';

/**
 * Why a grant is refused (ROLE_CHANGE_NOT_ALLOWED, `details[0].message`; the web picks its copy
 * by it): the account is an admin already, its email is not verified, or it has not completed the
 * SMS verification of its number (ADR-0070).
 */
export const ADMIN_GRANT_REFUSALS = [
  'already_admin',
  'email_not_verified',
  'phone_not_verified',
] as const;
/**
 * Why a revoke is refused (ROLE_CHANGE_NOT_ALLOWED, `details[0].message`): the account is not an
 * admin, or fewer than MIN_ADMINS would remain.
 */
export const ADMIN_REVOKE_REFUSALS = ['not_admin', 'min_admins'] as const;
export type AdminRoleChangeRefusal =
  (typeof ADMIN_GRANT_REFUSALS)[number] | (typeof ADMIN_REVOKE_REFUSALS)[number];

const adminRoleReasonSchema = z.string().trim().min(1).max(ADMIN_ROLE_REASON_MAX_LENGTH);

/** An account id (better-auth `user.id`, text) in a body, a path or a query. */
export const adminAccountIdSchema = z.string().min(1).max(255);

/** An account in an admin record: id and nickname. */
export const adminAccountActorSchema = z
  .object({ id: z.string(), nickname: z.string() })
  .meta({ id: 'AdminAccountActor' });
export type AdminAccountActor = z.infer<typeof adminAccountActorSchema>;

/** `GET /admin/admins` item: an account that holds the admin role now. */
export const adminAccountSchema = z
  .object({
    id: z.string(),
    email: z.email(),
    nickname: z.string(),
    /**
     * The latest `admin_grant` naming it and who wrote it; null for an admin promoted without
     * one (before #171, or by a test fixture).
     */
    grantedAt: z.iso.datetime().nullable(),
    grantedBy: adminAccountActorSchema.nullable(),
  })
  .meta({ id: 'AdminAccount' });
export type AdminAccount = z.infer<typeof adminAccountSchema>;

/**
 * The signed-in admin the screen is showing (better-auth `user.id`), on both bodies as on the
 * charge, coupon, verification and password bodies. The cookie decides who acts, and a tab whose
 * session was switched elsewhere (another tab signed in as somebody else; sign-ins are not
 * broadcast) keeps showing the old account until it refetches. The server refuses a mismatch
 * (403 FORBIDDEN naming the field) before anything is read or written: a change is recorded
 * under the admin the user is looking at, and a revoke is one's own exactly when its answer says
 * so (`actor.id` = `target.id` = this id) — the screen signs out on that answer, never on what
 * it believed when sending.
 */
const expectedAccountIdSchema = z.string().min(1).max(255);

/** `POST /admin/admins`: the account to make an admin and why (required). */
export const adminGrantBodySchema = z
  .object({
    /** As `GET /admin/users` lists it. */
    userId: adminAccountIdSchema,
    reason: adminRoleReasonSchema,
    /** The signed-in admin the screen is showing. */
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'AdminGrantBody' });
export type AdminGrantBody = z.infer<typeof adminGrantBodySchema>;

/** `POST /admin/admins/:userId/revoke`: why (required). */
export const adminRevokeBodySchema = z
  .object({
    reason: adminRoleReasonSchema,
    /** The signed-in admin the screen is showing. */
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'AdminRevokeBody' });
export type AdminRevokeBody = z.infer<typeof adminRevokeBodySchema>;

/** `admin_actions.payload` of an `admin_grant` or `admin_revoke` row. */
export const adminRoleChangePayloadSchema = z.object({ reason: z.string() });
export type AdminRoleChangePayload = z.infer<typeof adminRoleChangePayloadSchema>;

export const ADMIN_ROLE_CHANGE_TYPES = ['admin_grant', 'admin_revoke'] as const;
export type AdminRoleChangeType = (typeof ADMIN_ROLE_CHANGE_TYPES)[number];

/**
 * One entry of `GET /admin/admins/changes` (newest first), and the answer of a grant or revoke:
 * the record as written.
 */
export const adminRoleChangeSchema = z
  .object({
    /** The admin_actions row. */
    id: z.uuid(),
    type: z.enum(ADMIN_ROLE_CHANGE_TYPES).meta({ id: 'AdminRoleChangeType' }),
    /** The account whose role changed; email and nickname are null once it is gone. */
    target: z.object({
      id: z.string(),
      email: z.string().nullable(),
      nickname: z.string().nullable(),
    }),
    /** The admin who changed it (the bootstrap admin itself for the seed's grants). */
    actor: adminAccountActorSchema,
    reason: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminRoleChange' });
export type AdminRoleChange = z.infer<typeof adminRoleChangeSchema>;

/** `GET /admin/admins/changes`: a cursor page, of one account's changes when `userId` is given. */
export const adminRoleChangeListQuerySchema = cursorQuerySchema.extend({
  userId: adminAccountIdSchema.optional(),
});
export type AdminRoleChangeListQuery = z.infer<typeof adminRoleChangeListQuerySchema>;
