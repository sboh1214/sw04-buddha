import { AdminSignupAllowlist } from './admin-signup-allowlist';

/** 가입 허용 목록 (#330, ADR-0174). Access is checked in the admin layout. */
export default function AdminSignupAllowlistPage() {
  return <AdminSignupAllowlist />;
}
