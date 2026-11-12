import { FillClassificationScreen } from '../../fill-classifications/fill-classifications';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FillClassificationScreen fillId={id} />;
}
