import { AdminAuditFailures } from './admin-audit-failures';
import { Heading, Stack } from '@chakra-ui/react';
import { copy } from '@/copy';
import { AdminReconciliation } from './admin-reconciliation';
import { AdminReconciliationCorrections } from './admin-reconciliation-corrections';

/** PLAN 12 감사 실패 목록. Access is checked in the admin layout. */
export default function AdminAuditFailuresPage() {
  return (
    <Stack gap="10">
      <AdminReconciliation />
      <AdminReconciliationCorrections />
      <Stack gap="4">
        <Heading as="h2" size="lg">
          {copy.reconciliationOldFailures}
        </Heading>
        <AdminAuditFailures />
      </Stack>
    </Stack>
  );
}
