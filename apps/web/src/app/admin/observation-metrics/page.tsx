import { AdminObservationMetrics } from './admin-observation-metrics';

/**
 * 관측 지표 (#96, ADR-0169; decisions in ADR-0167): four weekly service-wide tables, read in one
 * request. No parameter — no week picker, no split, no drill-down (95-6, 95-10, 결정 8의 6).
 * Access is checked in the admin layout; the API checks it on every call.
 */
export default function AdminObservationMetricsPage() {
  return <AdminObservationMetrics />;
}
