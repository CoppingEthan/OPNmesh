import { requireAdmin } from "@/server/session";
import { buildState } from "@/server/state";
import { listClients } from "@/server/clients";
import { ClientsList } from "@/ui/clients-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients" };

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  await requireAdmin();
  const { new: openNew } = await searchParams;
  const rows = listClients().map((c) => ({ id: c.id, owner: c.owner, expiresAt: c.expiresAt, allowedSiteIds: c.allowedSiteIds, createdAt: c.createdAt }));
  return <ClientsList initial={buildState()} rows={rows} openNew={openNew === "1"} />;
}
