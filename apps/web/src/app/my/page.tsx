import { requireMySession } from '@/lib/my.server';
import { MySummary } from './summary';

/**
 * `/my`, MY's summary (#16). Gated on every navigation to it (`requireMySession`); the layout
 * draws the tabs.
 */
export default async function MyPage() {
  await requireMySession();
  return <MySummary />;
}
