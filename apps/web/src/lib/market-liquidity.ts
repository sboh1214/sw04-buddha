import {
  type MarketLiquiditySettings,
  type MarketStatus,
  marketLiquiditySettingsInputSchema,
} from '@buddha/shared';
import { copy } from '@/copy';
import { isApiError, validationMessage, validationPath } from './api';
import { type ReviewFailure, reviewFailure, reviewReasonDraft } from './market-review';

export const LIQUIDITY_FIELDS = [
  'budgetCoin',
  'maxLossCoin',
  'b',
  'levels',
  'quantity',
  'safetyTicks',
] as const satisfies readonly (keyof MarketLiquiditySettings)[];
export type LiquidityField = (typeof LIQUIDITY_FIELDS)[number];
export type LiquidityText = Record<LiquidityField, string>;

export const LIQUIDITY_LABEL: Record<LiquidityField, string> = {
  budgetCoin: copy.marketLiquidityBudget,
  maxLossCoin: copy.marketLiquidityMaxLoss,
  b: copy.marketLiquidityB,
  levels: copy.marketLiquidityLevels,
  quantity: copy.marketLiquidityQuantity,
  safetyTicks: copy.marketLiquiditySafety,
};
export const LIQUIDITY_HINT: Record<LiquidityField, string> = {
  budgetCoin: copy.marketLiquidityBudgetHint,
  maxLossCoin: copy.marketLiquidityMaxLossHint,
  b: copy.marketLiquidityBHint,
  levels: copy.marketLiquidityLevelsHint,
  quantity: copy.marketLiquidityQuantityHint,
  safetyTicks: copy.marketLiquiditySafetyHint,
};
export const LIQUIDITY_ERROR: Record<LiquidityField, string> = {
  budgetCoin: copy.errMarketLiquidityCoin,
  maxLossCoin: copy.errMarketLiquidityMaxLoss,
  b: copy.errMarketLiquidityB,
  levels: copy.errMarketLiquidityPositiveInteger,
  quantity: copy.errMarketLiquidityPositiveInteger,
  safetyTicks: copy.errMarketLiquiditySafety,
};

export function canEditLiquidity(status: MarketStatus): boolean {
  return status === 'draft';
}

/** Coin stays decimal text, including values beyond Number's exact integer range. */
export function liquidityTexts(settings: MarketLiquiditySettings | null): LiquidityText {
  return {
    budgetCoin: settings?.budgetCoin ?? '',
    maxLossCoin: settings?.maxLossCoin ?? '',
    b: settings === null ? '' : String(settings.b),
    levels: settings === null ? '' : String(settings.levels),
    quantity: settings === null ? '' : String(settings.quantity),
    safetyTicks: settings === null ? '' : String(settings.safetyTicks),
  };
}

export function liquidityDraft(
  text: LiquidityText,
  reasonText: string,
  current: MarketLiquiditySettings | null,
): {
  settings: MarketLiquiditySettings | null;
  reason: string;
  reasonError: string | null;
  errors: Partial<Record<LiquidityField, string>>;
  unchanged: boolean;
  ready: boolean;
} {
  const errors: Partial<Record<LiquidityField, string>> = {};
  const values: Record<LiquidityField, string | number> = { ...text };
  for (const field of LIQUIDITY_FIELDS) {
    const value = text[field].trim();
    // A blank field is not ready, but is not an error before the operator starts typing.
    // String(b) uses an exponent for valid very small/large values. Those saved values must
    // round-trip when another field changes; Coin and quote counts remain integer text.
    const validText = (field === 'b' ? /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/ : /^\d+$/).test(
      value,
    );
    values[field] =
      field === 'budgetCoin' || field === 'maxLossCoin'
        ? value
        : validText
          ? Number(value)
          : Number.NaN;
    if (value !== '' && !validText) errors[field] = LIQUIDITY_ERROR[field];
  }
  const parsed = marketLiquiditySettingsInputSchema.safeParse(values);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = LIQUIDITY_FIELDS.find((name) => name === issue.path[0]);
      if (field && text[field].trim() !== '') errors[field] = LIQUIDITY_ERROR[field];
    }
  }
  const settings: MarketLiquiditySettings | null =
    parsed.success && Object.keys(errors).length === 0
      ? {
          ...parsed.data,
          budgetCoin: parsed.data.budgetCoin.toString(),
          maxLossCoin: parsed.data.maxLossCoin.toString(),
        }
      : null;
  const { reason, error: reasonError } = reviewReasonDraft(reasonText);
  const unchanged =
    settings !== null &&
    current !== null &&
    LIQUIDITY_FIELDS.every((field) => settings[field] === current[field]);
  return {
    settings,
    reason,
    reasonError,
    errors,
    unchanged,
    ready: settings !== null && reasonError === null && !unchanged,
  };
}

export function liquidityVersionChanged(
  status: MarketStatus,
  currentVersion: number | null,
  baseVersion: number | null,
): boolean {
  return !canEditLiquidity(status) || currentVersion !== baseVersion;
}

export type LiquidityFailure =
  | { kind: 'field'; field: LiquidityField | 'reason'; message: string; refresh: boolean }
  | Exclude<ReviewFailure, { kind: 'field' }>;

export function liquidityFailure(error: unknown): LiquidityFailure {
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const path = validationPath(error);
    if (path?.[0] === 'baseVersion') {
      return { kind: 'alert', message: copy.marketLiquidityStale, refresh: true };
    }
    if (path?.[0] === 'settings') {
      const field = LIQUIDITY_FIELDS.find((name) => name === path[1]);
      if (field) return { kind: 'field', field, message: LIQUIDITY_ERROR[field], refresh: false };
      if (validationMessage(error) === 'unchanged') {
        return { kind: 'alert', message: copy.marketLiquidityUnchanged, refresh: true };
      }
    }
  }
  const failure = reviewFailure(error);
  if (failure.kind !== 'field') return failure;
  if (failure.field === 'reason') return { ...failure, field: 'reason' };
  return { kind: 'alert', message: failure.message, refresh: failure.refresh };
}
