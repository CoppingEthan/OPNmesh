import { notFound } from "next/navigation";
import { requireAdmin } from "@/server/session";
import { buildState } from "@/server/state";
import { getClient } from "@/server/clients";
import { ClientDetail } from "@/ui/client-detail";

export const dynamic = "force-dynamic";

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const c = getClient(id);
  if (!c) notFound();
  const row = {
    id: c.id,
    name: c.name,
    slug: c.slug,
    owner: c.owner,
    notes: c.notes,
    tunnelIp: c.tunnelIp,
    publicKey: c.publicKey,
    enabled: c.enabled,
    expiresAt: c.expiresAt,
    preferredSiteId: c.preferredSiteId,
    allowedSiteIds: c.allowedSiteIds,
    allowInbound: c.allowInbound,
    createdAt: c.createdAt,
    lastHandshakeAt: c.lastHandshakeAt,
  };
  return <ClientDetail initial={buildState()} row={row} />;
}
