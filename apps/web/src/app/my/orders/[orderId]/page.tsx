import type { Metadata } from 'next';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
import { MyOrderDetail } from '../../portfolio';

/**
 * A fixed title: the server reads neither the order nor its market for it — it holds no cookie to,
 * and an order is its owner's alone (N04 §7).
 */
export const metadata: Metadata = { title: `${copy.orderDetail} | ${copy.appName}` };

/**
 * `/my/orders/<id>`: 주문 상세 (#123, ADR-0141; ADR-0135 결과 4 #123 '주소'), under 대기 주문's tab.
 * Gated on every navigation to it (`requireMySession`); the order is read in the browser only,
 * and another account's, an unknown and a malformed id draw the same screen.
 */
export default async function MyOrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  await requireMySession();
  const { orderId } = await params;
  return <MyOrderDetail orderId={orderId} />;
}
