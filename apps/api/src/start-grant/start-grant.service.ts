import { Inject, Injectable } from '@nestjs/common';
import {
  payStartGrant,
  recordStartGrant,
  schema,
  startGrantStatus,
  type Db,
  type StartGrantRow,
} from '@buddha/db';
import { serializeCoinAmount, START_COIN_SETTING, type StartGrant } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { ReleaseSettingsService } from '../release-settings/release-settings.service.js';
import { balanceEvent } from '../wallet/wallet.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * What `StartGrantService.grant` did for an account:
 * - `granted`: this call paid the start Coin;
 * - `already_granted`: the account got it before (an earlier call, or the worker's payment of a
 *   grant that waited), nothing paid now;
 * - `pending`: the account's grant and number are recorded and the grant waits for the amount (the
 *   release setting is undecided, ADR-0069 decision 4 #70); the worker pays it once an admin
 *   enters one;
 * - `number_already_used`: the verified number counts for another account's grant — paid or
 *   waiting, typically an account that withdrew before this one verified the same number. Nothing
 *   for this account (#57-1·#57-17): it has no grant record, so `GET /me` says null. (A number
 *   whose grant was cancelled — its account withdrew while it waited — is free again and does not
 *   answer this, owner decision 2026-10-18.)
 * - `cancelled`: the account's own grant was cancelled when it withdrew while the grant waited
 *   (`cancelStartGrant`, #140); one grant per account, so nothing now. A withdrawal also deletes
 *   the 본인확인 record, so a withdrawn account meets VERIFICATION_REQUIRED first: this answers only
 *   an account whose record came back by hand.
 */
export type StartGrantResult =
  | { outcome: 'granted' | 'already_granted' | 'pending'; startGrant: StartGrant }
  | { outcome: 'number_already_used' | 'cancelled' };

/**
 * A grant row as `Me.startGrant` and the result above show it: waiting or paid. A cancelled grant
 * shows nothing (null) — its account withdrew, and nothing waits for it any more.
 */
export function toStartGrant(
  row: Pick<StartGrantRow, 'amountCoin' | 'grantedAt' | 'cancelledAt'>,
): StartGrant | null {
  const status = startGrantStatus(row);
  if (status === 'cancelled') return null;
  return status === 'pending' || row.grantedAt === null || row.amountCoin === null
    ? { status: 'pending', amountCoin: null, grantedAt: null }
    : {
        status: 'granted',
        amountCoin: serializeCoinAmount(row.amountCoin),
        grantedAt: row.grantedAt.toISOString(),
      };
}

/**
 * 시작 지급 (#70, ADR-0071): the same start Coin once per verified mobile number (N01 §2, ADR-0069
 * decision 1 #57-1). An internal service with NO route of its own: the onboarding (#58) calls
 * `grant` once it has confirmed, on the server, the account's consent, 본인확인 and nickname (D18,
 * N02 §9); the worker pays the grants that waited for an amount (`start_grant.pay`). Creating an
 * account or signing in grants nothing (migration 0031).
 *
 * One transaction per call, its locks in the order of ADR-0071 (본인확인 기록 → grant → balance):
 * 1. The account's 본인확인 record (`phone_verifications`, #183) FOR SHARE — none, no grant:
 *    VERIFICATION_REQUIRED. The share lock keeps the number from changing or going (an operator's
 *    edit, a withdrawal and its cancellation of the grant) until this commits.
 * 2. `recordStartGrant` (@buddha/db) with the keyed hash of the number (PhoneHasher): the account's
 *    grant if it has one, whatever its number is now; otherwise a new grant, pending, holding its
 *    number in `start_grant_numbers` — unless the number counts for another account's grant
 *    (`number_already_used`, nothing recorded). The constraints decide (one grant per account, one
 *    live record per number), so repeated and racing calls find the one grant.
 * 3. `payStartGrant` (@buddha/db): the 본인확인 record again (held by step 1 here; the worker's
 *    payment has only that check), the grant FOR UPDATE, the release setting read once
 *    (`grant.start_coin`, whatever its status — decision 7; undecided leaves it pending), then the
 *    balance, one START_GRANT ledger entry and the grant. Repeated or concurrent calls pay once.
 *
 * Step 1 reads the row itself rather than `isPhoneVerified` (@buddha/db) because it needs the number
 * and a lock that keeps it: the same test of the same row (ADR-0070 decision 2).
 *
 * Operator accounts get it under the same conditions (decision 4 #70). Bot and system accounts
 * (#115) do not exist yet; when they do, they get no grant record — the place for that check is
 * marked in `grant`.
 *
 * Not trading profit (N02 §8): PnL lives on `positions` (realized_pnl_coin) and nothing that
 * computes it reads ledger entries.
 */
@Injectable()
export class StartGrantService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: ReleaseSettingsService,
    private readonly hasher: PhoneHasher,
    private readonly publisher: MarketPublisher,
  ) {}

  /**
   * Grants the start Coin to `userId` if its verified number never got one, or pays its waiting
   * grant once the amount is set. Idempotent: any number of calls, at once or apart, give one
   * ledger entry. Throws VERIFICATION_REQUIRED for an account with no 본인확인 record.
   */
  async grant(userId: string): Promise<StartGrantResult> {
    const result = await this.db.transaction(async (tx) => {
      const [verified] = await tx
        .select({ phone: schema.phoneVerifications.phone })
        .from(schema.phoneVerifications)
        .where(eq(schema.phoneVerifications.userId, userId))
        .limit(1)
        .for('share');
      if (!verified) {
        throw new AppError('VERIFICATION_REQUIRED', {
          message: 'The start Coin needs a verified mobile number',
        });
      }
      // #115: a bot or system account gets no start grant (#70 본문). No such account exists yet;
      // the check that tells one apart goes here, before anything is recorded.
      const recorded = await recordStartGrant(tx, userId, this.hasher.hash(verified.phone));
      if (recorded.outcome === 'number_already_used') return recorded;
      const paid = await payStartGrant(tx, recorded.grantId, (inner) => this.amount(inner)).catch(
        (error: unknown) => {
          if (error instanceof AppError) throw error;
          throw new AppError('INTERNAL', {
            message: 'The start grant could not be paid',
            cause: error,
          });
        },
      );
      // payStartGrant asks for the 본인확인 record itself (the worker pays with nothing else
      // holding it); here the FOR SHARE read above holds it, so this is never reached. Should it
      // be, it is the same refusal, and throwing rolls back a grant recorded above.
      if (paid.outcome === 'unverified') {
        throw new AppError('VERIFICATION_REQUIRED', {
          message: 'The start Coin needs a verified mobile number',
        });
      }
      return paid;
    });

    if (result.outcome === 'number_already_used') return result;
    if (result.outcome === 'cancelled') return { outcome: 'cancelled' };
    if (result.outcome === 'granted') {
      // After COMMIT, like every balance change (PLAN 8); best effort.
      await this.publisher.publishUser(userId, balanceEvent(result.balance, result.ledgerEntry));
    }
    const startGrant = toStartGrant(result.grant);
    if (startGrant === null)
      throw new Error(`start grant of ${userId} is neither pending nor paid`);
    return { outcome: result.outcome, startGrant };
  }

  /**
   * The start grant amount, read once inside the paying transaction (ADR-0055): the value whatever
   * the status, or null while it is undecided — the grant then waits.
   */
  private async amount(tx: Tx): Promise<bigint | null> {
    const reading = await this.settings.get(START_COIN_SETTING, tx);
    return reading.status === 'undecided' ? null : BigInt(reading.value);
  }
}
