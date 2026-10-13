import { AdminAccounts } from './admin-accounts';

/** 관리자 계정 (#171, ADR-0056). Access is checked in the admin layout. */
export default function AdminAccountsPage() {
  return <AdminAccounts />;
}
