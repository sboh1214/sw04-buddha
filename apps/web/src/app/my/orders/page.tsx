import type { Metadata } from 'next';
import { copy } from '@/copy';
import { MyOrders } from '../portfolio';

export const metadata: Metadata = { title: `${copy.myOrders} | ${copy.appName}` };

/** `/my/orders`: MY's 대기 주문 tab (#16). The layout gates the session and draws the tabs. */
export default function MyOrdersPage() {
  return <MyOrders />;
}
