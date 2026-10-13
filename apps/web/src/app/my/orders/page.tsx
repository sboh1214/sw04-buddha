import type { Metadata } from 'next';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
import { MyOrders } from '../portfolio';

export const metadata: Metadata = { title: `${copy.myOrders} | ${copy.appName}` };

/**
 * `/my/orders`: MY's 대기 주문 tab (#16). Gated on every navigation to it (`requireMySession`); the
 * layout draws the tabs.
 */
export default async function MyOrdersPage() {
  await requireMySession();
  return <MyOrders />;
}
