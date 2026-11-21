import { Inject, Injectable } from '@nestjs/common';
import { applyRegrant, readAdminRegrantPage, regrantStatus, type Db } from '@buddha/db';
import {
  serializeRegrant,
  serializeRegrantStatus,
  type AdminRegrantListQuery,
  type AdminRegrantPage,
  type ApplyRegrantResult,
  type RegrantNotAllowedDetails,
  type RegrantStatus,
  type ReleaseSettingsRegistry,
} from '@buddha/shared';
import { AppError } from '../common/errors/app-error.js';
import { closedAccountRefusal } from '../common/errors/closed-account.js';
import { DB } from '../infra/db/db.provider.js';
import { assertCanTrade } from '../moderation/restrictions.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { RELEASE_SETTINGS_REGISTRY } from '../release-settings/release-settings.registry.js';
import { balanceEvent } from '../wallet/wallet.service.js';

/**
 * 제한적 재지급 (#74, ADR-0155; N01 §2, N02 §8, N04 §5; owner answers 2026-11-21): the member's
 * status (`GET /me/regrant`), the re-grant itself (`POST /me/regrant`) and the admins' records
 * (`GET /admin/regrants`). The conditions, the locks and the write are @buddha/db's
 * (`regrantStatus`, `applyRegrant`, `readAdminRegrantPage`); this adds the answers the API gives.
 *
 * The six release settings are read through the injected registry (RELEASE_SETTINGS_REGISTRY, as
 * #119's order intake reads `order.accepting`), once per request inside its transaction: a
 * re-grant is given in the request that asks, so nothing keeps an older value (owner answer 12).
 */
@Injectable()
export class RegrantService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELEASE_SETTINGS_REGISTRY) private readonly registry: ReleaseSettingsRegistry,
    private readonly publisher: MarketPublisher,
  ) {}

  /**
   * The account's status now, read without locks (owner answers 9·10): what the wallet's card
   * draws. A request a moment later asks everything again under its locks.
   */
  async status(userId: string): Promise<RegrantStatus> {
    return serializeRegrantStatus(await regrantStatus(this.db, userId, this.registry));
  }

  /**
   * Grants the re-grant when every condition holds, in one transaction (owner answer 3: at once,
   * in the request that asks):
   * 1. `assertCanTrade` — the profile FOR KEY SHARE, then an account restriction answers
   *    RESTRICTED with its end (owner answer 8), as an order is refused (#139). A writing
   *    restriction does not stop it (#57-12).
   * 2. `applyRegrant` (@buddha/db): the account's re-grant lock, the request id's earlier grant
   *    (answered again, `replayed: true`, N01 §9), then every condition under its locks and,
   *    when none fails, the REGRANT mint and its `regrants` row.
   * A refusal writes nothing and answers REGRANT_NOT_ALLOWED with the status read under the
   * locks — every reason and the numbers (owner answer 9). After the commit a grant publishes
   * `user:balance` (PLAN 8, best effort), as the start grant's payment does (`announce`).
   *
   * A request that passed SessionGuard before a closure of the account committed meets the
   * closed account at the row (`regrants_open_account`) and is answered UNAUTHENTICATED, as the
   * next request would be.
   */
  async apply(userId: string, requestId: string): Promise<ApplyRegrantResult> {
    const outcome = await this.db
      .transaction(async (tx) => {
        await assertCanTrade(tx, userId);
        return applyRegrant(tx, { userId, requestId, registry: this.registry });
      })
      .catch((error: unknown) => {
        throw closedAccountRefusal(error) ?? error;
      });
    if (outcome.outcome === 'refused') {
      const details: RegrantNotAllowedDetails = serializeRegrantStatus(outcome.status);
      throw new AppError('REGRANT_NOT_ALLOWED', {
        message: `The re-grant is refused: ${outcome.status.refusals.join(', ')}`,
        details,
      });
    }
    if (outcome.outcome === 'granted') {
      await this.publisher.publishUser(userId, balanceEvent(outcome.balance, outcome.entry));
    }
    return { regrant: serializeRegrant(outcome.regrant), replayed: outcome.replayed };
  }

  /** The admins' records, newest first, one cursor page (owner answer 3: records only). */
  list(query: AdminRegrantListQuery): Promise<AdminRegrantPage> {
    return readAdminRegrantPage(this.db, query);
  }
}
