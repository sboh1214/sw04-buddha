import * as z from 'zod';
import { coinAmountSchema, serializeCoinAmount } from './api/coin-amount.js';
import { pageEnvelope } from './api/envelope.js';
import { cursorQuerySchema } from './api/pagination.js';
import { expectedAccountBodySchema } from './expected-account.js';
import { publicIdSchema } from './public-id.js';

/**
 * 제한적 재지급 (#74, ADR-0155; N01 §2 «Coin이 소진된 참여자에게 제한적 재지급», N02 §8, N04 §5;
 * ADR-0107 결정 2 #73 1·3항): a member whose available Coin ran down to the threshold applies in
 * the wallet (MY 지갑) and, when every condition holds, gets the amount at once in the same
 * request — a new issue under its own ledger type (REGRANT, mint → the member's own account), never
 * a transfer from anyone and never trading profit. Nothing waits: a refused request leaves no
 * record and the member applies again once the reason is gone (owner answer 2026-11-21 2).
 *
 * The six numbers are release settings (REGRANT_SETTINGS, release-settings.ts), read together at
 * each request; while any one is undecided nothing is granted ('준비 중', owner answer 12). Only
 * an account whose start grant was paid may apply (owner answer 4), never the 운영 마켓메이커
 * (#115), and one request id grants at most once (N01 §9). Owner-only like the balance it lands in
 * (PRIVATE_DATA `balance`): the account reads its own status, and admins read the records.
 */

/**
 * The highest 대기기간 the release setting takes: a year of hours. A bound against a typo in the
 * admin screen, not a decided value (#133 decides the values).
 */
export const REGRANT_WAIT_MAX_HOURS = 8_760;
/** The longest 주기 the release setting takes: a year of days. */
export const REGRANT_PERIOD_MAX_DAYS = 365;
/** The most re-grants one 주기 may allow. */
export const REGRANT_PERIOD_LIMIT_MAX = 100;
/** The highest 누적 상한 the release setting takes (Coin): a bound, not a decided amount. */
export const REGRANT_TOTAL_CAP_MAX_COIN = 1_000_000_000;

/**
 * Why a re-grant is refused (REGRANT_NOT_ALLOWED; `GET /me/regrant`'s `refusals`), in the order
 * the server asks them — every one that applies is named, not only the first (owner answer 9):
 * - `not_ready`: a release setting of the six is undecided — '준비 중' (owner answer 12); the
 *   numbers are then unknown, so no reason that needs one is asked;
 * - `restricted`: an account restriction stands (owner answer 8; the rule `assertCanTrade` asks);
 *   the request itself is answered RESTRICTED with its end, as an order is;
 * - `held`: the account's books are held for a reconciliation difference (#93) — new orders are
 *   refused the same way (`ledger_hold`);
 * - `no_start_grant`: the account's start grant was never paid — not asked, waiting for its amount,
 *   cancelled, or its number's start Coin is another account's (`number_used`) (owner answer 4);
 * - `not_exhausted`: available Coin is above the threshold (소진 기준액, owner answer 1);
 * - `live_orders`: an order of the account still waits in a book (대기·부분 체결, owner answer 2);
 * - `unsettled_positions`: it holds at least one contract of a market not settled yet (owner
 *   answer 7: `positions.qty > 0 AND settled = false`, the closure's rule) — a market sold out
 *   entirely does not count;
 * - `waiting`: the 대기기간 since the last re-grant (or, before the first, since the start grant
 *   was paid) has not passed (`waitUntil`);
 * - `period_limit`: the 주기's re-grants are used up (`nextPeriodAt` frees the next one);
 * - `total_cap`: this re-grant would take the account's lifetime re-grants past the 누적 상한 —
 *   never granted in part (owner answer 6).
 */
export const REGRANT_REFUSALS = [
  'not_ready',
  'restricted',
  'held',
  'no_start_grant',
  'not_exhausted',
  'live_orders',
  'unsettled_positions',
  'waiting',
  'period_limit',
  'total_cap',
] as const;
export type RegrantRefusal = (typeof REGRANT_REFUSALS)[number];
export const regrantRefusalSchema = z.enum(REGRANT_REFUSALS).meta({ id: 'RegrantRefusal' });

/**
 * `GET /me/regrant`, and REGRANT_NOT_ALLOWED's details: whether the settings are decided (`open`),
 * whether a request now would be granted (`eligible`: open with no refusal), every refusal that
 * applies, and the numbers the wallet's card shows (owner answers 9·10). Every number is null
 * while it is not `open`; `waitUntil` is null unless `waiting`, `nextPeriodAt` unless
 * `period_limit`. Read as of now: the request asks everything again under its locks.
 */
export const regrantStatusSchema = z
  .object({
    /** All six release settings have a value (owner answer 12: otherwise '준비 중'). */
    open: z.boolean(),
    /** Open and refused for nothing: a request now is granted. */
    eligible: z.boolean(),
    refusals: z.array(regrantRefusalSchema),
    /** 1회 지급액: what one re-grant gives. */
    amountCoin: coinAmountSchema.nullable(),
    /** 소진 기준액: available Coin at or below it counts as exhausted. */
    thresholdCoin: coinAmountSchema.nullable(),
    /** 대기기간 in hours, from the last re-grant (or the start grant's payment). */
    waitHours: z.number().int().min(0).nullable(),
    /** When the wait ends; null unless `waiting`. */
    waitUntil: z.iso.datetime().nullable(),
    /** 주기 in days. */
    periodDays: z.number().int().min(1).nullable(),
    /** How many re-grants one 주기 allows. */
    periodLimit: z.number().int().min(1).nullable(),
    /** How many re-grants the account got within the last 주기. */
    periodUsed: z.number().int().min(0).nullable(),
    /** When the oldest of them leaves the 주기 and frees one; null unless `period_limit`. */
    nextPeriodAt: z.iso.datetime().nullable(),
    /** 누적 상한: the most Coin the account may ever get by re-grants. */
    totalCapCoin: coinAmountSchema.nullable(),
    /** What the account got by re-grants so far. */
    totalGrantedCoin: coinAmountSchema.nullable(),
    /** What the cap leaves (never below 0). */
    remainingCapCoin: coinAmountSchema.nullable(),
  })
  .meta({ id: 'RegrantStatus' });
export type RegrantStatus = z.infer<typeof regrantStatusSchema>;

/** REGRANT_NOT_ALLOWED's details: the status the refusing request read under its locks. */
export const regrantNotAllowedDetailsSchema = regrantStatusSchema;
export type RegrantNotAllowedDetails = RegrantStatus;

/**
 * A status as the server computes it (@buddha/db `regrantStatus`, `applyRegrant`): Coin as bigint
 * and times as Date, the rest as on the wire. `serializeRegrantStatus` writes it out.
 */
export interface RegrantStatusRead {
  open: boolean;
  eligible: boolean;
  refusals: RegrantRefusal[];
  amountCoin: bigint | null;
  thresholdCoin: bigint | null;
  waitHours: number | null;
  waitUntil: Date | null;
  periodDays: number | null;
  periodLimit: number | null;
  periodUsed: number | null;
  nextPeriodAt: Date | null;
  totalCapCoin: bigint | null;
  totalGrantedCoin: bigint | null;
  remainingCapCoin: bigint | null;
}

const coinOrNull = (value: bigint | null) => (value === null ? null : serializeCoinAmount(value));
const timeOrNull = (value: Date | null) => (value === null ? null : value.toISOString());

/** The wire form of a computed status (RegrantStatus). */
export function serializeRegrantStatus(read: RegrantStatusRead): RegrantStatus {
  return {
    open: read.open,
    eligible: read.eligible,
    refusals: [...read.refusals],
    amountCoin: coinOrNull(read.amountCoin),
    thresholdCoin: coinOrNull(read.thresholdCoin),
    waitHours: read.waitHours,
    waitUntil: timeOrNull(read.waitUntil),
    periodDays: read.periodDays,
    periodLimit: read.periodLimit,
    periodUsed: read.periodUsed,
    nextPeriodAt: timeOrNull(read.nextPeriodAt),
    totalCapCoin: coinOrNull(read.totalCapCoin),
    totalGrantedCoin: coinOrNull(read.totalGrantedCoin),
    remainingCapCoin: coinOrNull(read.remainingCapCoin),
  };
}

/**
 * One re-grant as its member reads it: the record's id (the REGRANT ledger entry's `ref_id`), the
 * Coin given and when (the entry's time).
 */
export const regrantSchema = z
  .object({
    id: z.uuid(),
    amountCoin: coinAmountSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Regrant' });
export type Regrant = z.infer<typeof regrantSchema>;

/** The wire form of a re-grant as stored (a `regrants` row: Coin as bigint, the time as Date). */
export function serializeRegrant(row: {
  id: string;
  amountCoin: bigint;
  createdAt: Date;
}): Regrant {
  return {
    id: row.id,
    amountCoin: serializeCoinAmount(row.amountCoin),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `POST /me/regrant`: the account the screen shows and nothing else (the amount is the release
 * setting's) — the cookie decides whose account it is, and a window still drawing account A after
 * B signed in would otherwise apply as B (ADR-0092). The request id rides in `Idempotency-Key`.
 */
export const applyRegrantBodySchema = expectedAccountBodySchema;
export type ApplyRegrantBody = z.infer<typeof applyRegrantBodySchema>;

/**
 * `POST /me/regrant`'s answer: the re-grant, and whether this request id had been granted before
 * (`replayed`: the same answer again, nothing granted twice — N01 §9).
 */
export const applyRegrantResultSchema = z
  .object({
    regrant: regrantSchema,
    replayed: z.boolean(),
  })
  .meta({ id: 'ApplyRegrantResult' });
export type ApplyRegrantResult = z.infer<typeof applyRegrantResultSchema>;

/**
 * One record of `GET /admin/regrants` (newest first; owner answer 3: the admin screen only reads
 * the records): the account as the admin screens name it — its id, public id and nickname (null
 * once its member closed it, #140) — the Coin given, the available Coin read under the lock when
 * it was granted (소진 확인), and when.
 */
export const adminRegrantSchema = z
  .object({
    id: z.uuid(),
    account: z.object({
      userId: z.string(),
      publicId: publicIdSchema,
      nickname: z.string().nullable(),
    }),
    amountCoin: coinAmountSchema,
    availableBeforeCoin: coinAmountSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminRegrant' });
export type AdminRegrant = z.infer<typeof adminRegrantSchema>;

/** `GET /admin/regrants`: a cursor page (PLAN 7), newest first. */
export const adminRegrantListQuerySchema = cursorQuerySchema;
export type AdminRegrantListQuery = z.infer<typeof adminRegrantListQuerySchema>;

/** `GET /admin/regrants`'s answer: `{ data, meta: { nextCursor } }`. */
export const adminRegrantPageSchema = pageEnvelope(adminRegrantSchema);
export type AdminRegrantPage = z.infer<typeof adminRegrantPageSchema>;
