import { AdminRetentionPurges } from './admin-retention-purges';

/** 보존기간 처리 기록 (#184, ADR-0087). Access is checked in the admin layout. */
export default function AdminRetentionPage() {
  return <AdminRetentionPurges />;
}
