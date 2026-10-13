import { AdminAccounts } from './admin-accounts';

/** 운영자 계정 (#171, ADR-0056). Access is checked in the admin layout. */
export default function AdminAccountsPage() {
  return <AdminAccounts />;
}
