import { notFound } from "next/navigation";
import { requireAdmin } from "@/server/session";
import { buildState } from "@/server/state";
import { getGenerated } from "@/server/snapshot";
import { SiteDetail } from "@/ui/site/site-detail";

export const dynamic = "force-dynamic";

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const state = buildState();
  const site = state.sites.find((s) => s.id === id);
  if (!site) notFound();
  const plan = getGenerated().bundle.routers[id] ?? null;
  return <SiteDetail siteId={id} initial={state} initialPlan={plan} />;
}
