import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { correctionRequest } from '@/test/reconciliation-corrections';
import { byTestId, renderWithQueries } from '@/test/render';
import { CorrectionRequestCard } from './admin-reconciliation-corrections';

const draw = (operator: string | undefined, row = correctionRequest) =>
  renderWithQueries(
    <CorrectionRequestCard request={row} onAction={() => undefined} />,
    operator ? [[['me'], { id: operator }]] : [],
  );
const disabled = (html: string, action: string) =>
  Object.hasOwn(
    byTestId(html, `correction-${action}-${correctionRequest.id}`)?.attributes ?? {},
    'disabled',
  );
describe('correction request card', () => {
  it('distinguishes member-visible and private reasons and never enables requester approval', () => {
    const own = draw('admin-a');
    expect(own).toContain(copy.reconciliationCorrectionUserReason);
    expect(own).toContain(copy.reconciliationCorrectionInternalReason);
    expect(own).toContain(correctionRequest.reason);
    expect(own).toContain(correctionRequest.userReason);
    expect(disabled(own, 'approve')).toBe(true);
    expect(disabled(own, 'reject')).toBe(true);
    expect(disabled(own, 'retract')).toBe(false);
    expect(disabled(draw('admin-b'), 'approve')).toBe(false);
    expect(disabled(draw(undefined), 'approve')).toBe(true);
    expect(byTestId(draw('admin-b'), `correction-retract-${correctionRequest.id}`)).toBeUndefined();
  });
  it('shows an approved correction as complete but keeps separate recovery explicit', () => {
    const html = draw('admin-b', {
      ...correctionRequest,
      status: 'approved',
      decidedAt: correctionRequest.requestedAt,
    });
    expect(html).toContain(copy.reconciliationCorrectionApproved);
    expect(html).toContain(copy.reconciliationCorrectionSeparateRecovery);
    expect(byTestId(html, `correction-approve-${correctionRequest.id}`)).toBeUndefined();
  });
});
