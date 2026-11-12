import { describe, expect, it } from 'vitest';
import { marketMaker } from '@/test/market-maker';
import { makerControlRequest } from '@/test/market-maker-control';
import {
  controlBaseChanged,
  controlDraft,
  controlForm,
  controlStanding,
} from './market-maker-controls';
describe('fixed maker control drafts', () => {
  it('uses current settings and control generation, preserving the original account', () => {
    const form = { ...controlForm(marketMaker), reason: ' 근거 ' };
    expect(controlDraft(marketMaker, 'stop', form, 'admin-a')).toMatchObject({
      expectedAccountId: 'admin-a',
      baseVersion: 1,
      baseControlGeneration: '1',
      reason: '근거',
      change: { action: 'stop' },
    });
    expect(controlDraft(marketMaker, 'stop', form, undefined)).toBeNull();
    expect(controlDraft({ ...marketMaker, runtime: null }, 'stop', form, 'admin-a')).toBeNull();
  });
  it('rejects missing, fractional, overflow and over-budget settings without numeric fallback', () => {
    const form = { ...controlForm(marketMaker), reason: '근거' };
    for (const bad of [
      { safetyTicks: '' },
      { levels: '1.5' },
      { quantity: '999999999999999999' },
      { maxLossCoin: '1001' },
    ])
      expect(controlDraft(marketMaker, 'settings', { ...form, ...bad }, 'admin-a')).toBeNull();
    expect(
      controlDraft(marketMaker, 'settings', { ...form, safetyTicks: '0' }, 'admin-a')?.change,
    ).toMatchObject({ action: 'settings', settings: { safetyTicks: 0 } });
  });
  it('requires every independent demand explanation and a valid explicit KST period', () => {
    const form = {
      ...controlForm(marketMaker),
      reason: '근거',
      additionalCoin: '100',
      from: '2026-11-01T10:00',
      to: '2026-11-02T10:00',
      independentParticipants: '독립',
      bidirectionalTrading: '양방향',
      actualDemand: '수요',
    };
    expect(controlDraft(marketMaker, 'increase', form, 'admin-a')?.change).toMatchObject({
      action: 'increase',
      additionalCoin: '100',
      demand: { from: '2026-11-01T01:00:00.000Z', to: '2026-11-02T01:00:00.000Z' },
    });
    for (const bad of [
      { actualDemand: '' },
      { from: form.to },
      { additionalCoin: '-1' },
      { additionalCoin: '1.2' },
    ])
      expect(controlDraft(marketMaker, 'increase', { ...form, ...bad }, 'admin-a')).toBeNull();
  });
  it('distinguishes worker generations from stale administrative generations and limits cleanup ownership', () => {
    expect(
      controlBaseChanged(
        { ...marketMaker, runtime: { ...marketMaker.runtime!, generation: '100' } },
        makerControlRequest.payload,
      ),
    ).toBe(false);
    expect(
      controlBaseChanged(
        { ...marketMaker, runtime: { ...marketMaker.runtime!, controlGeneration: '2' } },
        makerControlRequest.payload,
      ),
    ).toBe(true);
    expect(controlStanding(makerControlRequest, 'admin-a')).toEqual({
      approve: false,
      reject: false,
      retract: true,
    });
    expect(controlStanding(makerControlRequest, 'admin-b')).toEqual({
      approve: true,
      reject: true,
      retract: false,
    });
    expect(controlStanding({ ...makerControlRequest, status: 'approved' }, 'admin-b')).toEqual({
      approve: false,
      reject: false,
      retract: false,
    });
  });
});
