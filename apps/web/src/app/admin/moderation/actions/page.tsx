import { AdminModerationActions } from './admin-moderation-actions';

/** 조치 기록 (#50, ADR-0081): every moderation action. Access is checked in the admin layout. */
export default function AdminModerationActionsPage() {
  return <AdminModerationActions />;
}
