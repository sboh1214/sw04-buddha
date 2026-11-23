import { marketWorkKindParam } from '@/lib/market-work';
import { MarketWorkHistory } from './market-work-history';

type Param = string | string[] | undefined;

/**
 * 시장별 작업 이력 (#145 part 2, ADR-0164; 145-5, N03 §8): one market's operator work and the
 * worker's processing, oldest first, `?kind=` naming one of 수정·중단·판정·지급·그 밖 (전체 without
 * it; an unknown value reads as 전체). Access is checked in the admin layout; the API checks it on
 * every call.
 */
export default async function MarketWorkHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ kind?: Param }>;
}) {
  const [{ id }, { kind }] = await Promise.all([params, searchParams]);
  return <MarketWorkHistory id={id} kind={marketWorkKindParam(kind)} />;
}
