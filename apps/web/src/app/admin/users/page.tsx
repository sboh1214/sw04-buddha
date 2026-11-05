import { AdminUsers } from './admin-users';

/**
 * PLAN 12 "사용자": search and balance; no balance adjustment since #116 (ADR-0109). Access is
 * checked in the layout.
 */
export default function AdminUsersPage() {
  return <AdminUsers />;
}
