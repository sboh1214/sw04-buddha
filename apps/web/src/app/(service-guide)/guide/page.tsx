import type { Metadata } from 'next';
import { copy } from '@/copy';
import { SERVICE_GUIDE } from './guide-content';
import { ServiceGuideView } from './guide-view';

export const metadata: Metadata = { title: `${copy.serviceGuideTitle} | ${copy.appName}` };

/**
 * `/guide` 서비스 안내 (#136, ADR-0177): public and static, prerendered at build time like `/terms`
 * — it reads no session, so a visitor and a member, onboarded or not (owner answer 136-6), get
 * the same page. Under the route group `(service-guide)`, the one place a sentence may say what
 * the product does not offer (#113, ADR-0057 결정 1-2).
 */
export default function ServiceGuidePage() {
  return <ServiceGuideView guide={SERVICE_GUIDE} />;
}
