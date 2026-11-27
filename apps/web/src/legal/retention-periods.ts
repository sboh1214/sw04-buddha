import { POLICY_RETENTION_DAYS, type RetentionPeriod } from '@buddha/shared';
import { UNDECIDED } from './business-info';

/**
 * How the 개인정보처리방침 and the 개인정보 수집·이용 consent text write a retention period (owner
 * answers 133-8 and 137-5, ADR-0176): the approved figure in days after the moment it counts from —
 * '탈퇴한 때부터 30일' — read from POLICY_RETENTION_DAYS (@buddha/shared), the one place the figures
 * live. While the owner has approved none it is '미정', and every sentence is written so that either
 * reads whole: '보관 기간은 {this}입니다.'
 *
 * `from` is the moment the period counts from, as the setting's description says it (the purge
 * counts from the same moment, docs/SETTINGS.md '보존기간 항목').
 */
export function retentionPeriodText(period: RetentionPeriod, from: string): string {
  const days = POLICY_RETENTION_DAYS[period];
  return days === null ? UNDECIDED : `${from} ${days.toLocaleString('ko-KR')}일`;
}
