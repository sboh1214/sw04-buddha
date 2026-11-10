import {
  MARKET_MAKER_REDUCE_AT_BP_SETTING,
  MARKET_MAKER_HALT_AT_BP_SETTING,
  MARKET_MAKER_REDUCE_RATIO_BP_SETTING,
  RELEASE_SETTINGS,
  marketMakerStageSettings,
  type ReleaseSettingsRegistry,
} from '@buddha/shared';
import type { Db } from './client.js';
import { getReleaseSetting } from './release-settings.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Each operation reads the registered values once; undecided is never a launch default. */
export async function readMarketMakerStageSettings(
  tx: Db | Tx,
  registry: ReleaseSettingsRegistry = RELEASE_SETTINGS,
) {
  const reduceAtBp = await getReleaseSetting(tx, registry, MARKET_MAKER_REDUCE_AT_BP_SETTING);
  const haltAtBp = await getReleaseSetting(tx, registry, MARKET_MAKER_HALT_AT_BP_SETTING);
  const reduceRatioBp = await getReleaseSetting(tx, registry, MARKET_MAKER_REDUCE_RATIO_BP_SETTING);
  return marketMakerStageSettings({ reduceAtBp, haltAtBp, reduceRatioBp });
}
