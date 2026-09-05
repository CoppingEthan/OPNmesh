import { requireAdmin } from "@/server/session";
import { buildState } from "@/server/state";
import { SitesList } from "@/ui/sites-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sites" };

export default async function SitesPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  await requireAdmin();
  const { new: openNew } = await searchParams;
  return <SitesList initial={buildState()} openNew={openNew === "1"} />;
}
