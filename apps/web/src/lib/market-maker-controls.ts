import { requestMarketMakerControlBodySchema, type MarketMakerControlChange } from '@buddha/shared';
import { copy } from '@/copy';
import {
  type AdminMarketMaker,
  type MarketMakerControlRequest,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationMessage,
} from './api';
import { kstLocalToIso } from './datetime';
export const CONTROL_LABEL: Record<MarketMakerControlChange['action'], string> = {
  stop: copy.makerControlsStop,
  resume: copy.makerControlsResume,
  settings: copy.makerControlsSettings,
  increase: copy.makerControlsIncrease,
};
export const CONTROL_EFFECT: Record<MarketMakerControlChange['action'], string> = {
  stop: copy.makerControlsEffectStop,
  resume: copy.makerControlsEffectResume,
  settings: copy.makerControlsEffectSettings,
  increase: copy.makerControlsEffectIncrease,
};
export const CONTROL_STATUS: Record<MarketMakerControlRequest['status'], string> = {
  pending: copy.makerControlsPending,
  approved: copy.makerControlsApproved,
  rejected: copy.makerControlsRejected,
  retracted: copy.makerControlsRetracted,
};
export type ControlForm = {
  maxLossCoin: string;
  levels: string;
  quantity: string;
  safetyTicks: string;
  additionalCoin: string;
  from: string;
  to: string;
  independentParticipants: string;
  bidirectionalTrading: string;
  actualDemand: string;
  reason: string;
};
export function controlForm(maker: AdminMarketMaker): ControlForm {
  const c = maker.config;
  return {
    maxLossCoin: c?.maxLossCoin ?? '',
    levels: c ? String(c.levels) : '',
    quantity: c ? String(c.quantity) : '',
    safetyTicks: c ? String(c.safetyTicks) : '',
    additionalCoin: '',
    from: '',
    to: '',
    independentParticipants: '',
    bidirectionalTrading: '',
    actualDemand: '',
    reason: '',
  };
}
export function controlDraft(
  maker: AdminMarketMaker,
  action: MarketMakerControlChange['action'],
  form: ControlForm,
  by: string | undefined,
) {
  if (!maker.config || !maker.runtime || !by) return null;
  let change: unknown = { action };
  if (
    action === 'settings' &&
    ![form.levels, form.quantity, form.safetyTicks].every((value) => /^(0|[1-9]\d*)$/.test(value))
  )
    return null;
  if (action === 'settings')
    change = {
      action,
      settings: {
        maxLossCoin: form.maxLossCoin,
        levels: Number(form.levels),
        quantity: Number(form.quantity),
        safetyTicks: Number(form.safetyTicks),
      },
    };
  if (action === 'increase')
    change = {
      action,
      additionalCoin: form.additionalCoin,
      demand: {
        from: kstLocalToIso(form.from),
        to: kstLocalToIso(form.to),
        independentParticipants: form.independentParticipants,
        bidirectionalTrading: form.bidirectionalTrading,
        actualDemand: form.actualDemand,
      },
    };
  const parsed = requestMarketMakerControlBodySchema.safeParse({
    expectedAccountId: by,
    baseVersion: maker.config.version,
    baseControlGeneration: maker.runtime.controlGeneration,
    reason: form.reason,
    change,
  });
  if (!parsed.success) return null;
  if (
    parsed.data.change.action === 'settings' &&
    BigInt(parsed.data.change.settings.maxLossCoin) > BigInt(maker.config.budgetCoin)
  )
    return null;
  return parsed.data;
}
export function controlBaseChanged(
  maker: AdminMarketMaker,
  base: { baseVersion: number; baseControlGeneration: string },
) {
  return (
    maker.config?.version !== base.baseVersion ||
    maker.runtime?.controlGeneration !== base.baseControlGeneration
  );
}
export function controlStanding(request: MarketMakerControlRequest, operator: string | undefined) {
  const pending = request.status === 'pending';
  const own = !!operator && request.requestedBy.id === operator;
  return {
    approve: pending && !!operator && !own,
    reject: pending && !!operator && !own,
    retract: pending && own,
  };
}
export function controlFailure(error: unknown) {
  if (isForAnotherAccount(error)) return { close: true, message: copy.sessionChanged };
  if (isApiUnreachable(error)) return { close: false, message: copy.errNetwork };
  if (isApiError(error, 'FORBIDDEN')) return { close: false, message: copy.adminOnly };
  if (isApiError(error, 'UNAUTHENTICATED'))
    return { close: false, message: copy.errUnauthenticated };
  if (isApiError(error, 'MARKET_MAKER_CONTROL_NOT_ALLOWED')) {
    const reason = (error.details as { reason?: unknown } | undefined)?.reason;
    const message =
      reason === 'stale'
        ? copy.makerControlsChanged
        : reason === 'insufficient_treasury'
          ? copy.makerControlsTreasuryWait
          : reason === 'held'
            ? copy.makerControlsHeld
            : reason === 'requester'
              ? copy.makerControlsRequesterGone
              : copy.makerControlsInvalid;
    return { close: false, message };
  }
  if (isApiError(error, 'APPROVAL_NOT_ALLOWED')) {
    const reason = validationMessage(error);
    const messages: Record<string, string> = {
      requester: copy.treasuryIssueOwnRequest,
      no_decider: copy.errApprovalNoDecider,
      decided: copy.errApprovalDecided,
      retracted: copy.errApprovalRetracted,
      not_requester: copy.errApprovalNotRequester,
    };
    return { close: false, message: (reason && messages[reason]) || copy.makerControlsInvalid };
  }
  return { close: false, message: copy.makerControlsInvalid };
}
