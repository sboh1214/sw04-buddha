import { AdminSmsStatus } from './admin-sms-status';

/** SMS 발송 현황 (#183, ADR-0070). Access is checked in the admin layout. */
export default function AdminSmsPage() {
  return <AdminSmsStatus />;
}
