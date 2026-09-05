"use client";

import { ArrowRight, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StatePayload } from "@/server/state";
import { ClientForm } from "./client-form";
import { Badge, Button, Card, EmptyState, PageHeader, StatusDot } from "./components";
import { Ago } from "./components-client";
import { formatBits } from "./format";
import { useLiveState } from "./use-live";

interface Row {
  id: string;
  owner: string;
  expiresAt: number | null;
  allowedSiteIds: string[] | null;
  createdAt: number;
}

export function ClientsList({ initial, rows, openNew }: { initial: StatePayload; rows: Row[]; openNew: boolean }) {
  const { state } = useLiveState(initial);
  const router = useRouter();
  const [creating, setCreating] = useState(openNew);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const siteName = (id: string | null) => (id ? state.sites.find((s) => s.id === id)?.name ?? "?" : null);
  const noEntry = !state.sites.some((s) => s.reachable);

  return (
    <div>
      <PageHeader
        title="Roaming clients"
        description="Laptops and phones that join the network from anywhere with the WireGuard app. Each gets its own key and address."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Add client
          </Button>
        }
      />
      {noEntry && state.sites.length > 0 && (
        <p className="mb-4 rounded-lg bg-warn-soft px-4 py-3 text-sm text-warn-ink">No site accepts incoming connections yet, so clients have nowhere to connect. On a site's gateway, tick “accepts incoming connections” and set its public address.</p>
      )}
      {state.clients.length === 0 ? (
        <EmptyState title="No clients yet" description="Add a device, then hand it a QR code, a config file or a one-time link." action={<Button variant="primary" onClick={() => setCreating(true)}>Add client</Button>} />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line">
            {state.clients.map((c) => {
              const r = byId.get(c.id);
              const expired = !!r?.expiresAt && r.expiresAt < Date.now();
              return (
                <li key={c.id}>
                  <Link href={`/clients/${c.id}`} className="flex items-center gap-4 px-5 py-3.5 hover:bg-surface-2">
                    <StatusDot tone={!c.enabled ? "idle" : c.online ? "good" : "idle"} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{c.name}</span>
                        {!c.enabled && <Badge tone="idle">{expired ? "Expired" : "Disabled"}</Badge>}
                        {r?.allowedSiteIds && <Badge tone="info">restricted to {r.allowedSiteIds.length} site{r.allowedSiteIds.length === 1 ? "" : "s"}</Badge>}
                      </div>
                      <div className="mt-0.5 text-xs text-ink-3">
                        <span className="mono">{c.tunnelIp}</span>
                        {r?.owner ? ` · ${r.owner}` : ""}
                      </div>
                    </div>
                    <div className="hidden text-right text-xs text-ink-2 sm:block">
                      {c.online ? (
                        <>
                          <div>
                            Online via {siteName(c.viaSiteId)} · ↓ {formatBits(c.txBps)} ↑ {formatBits(c.rxBps)}
                          </div>
                          <div className="text-ink-3">{c.endpoint ? `from ${c.endpoint.split(":")[0]}` : ""}</div>
                        </>
                      ) : (
                        <div className="text-ink-3">
                          Last seen <Ago ts={c.lastHandshakeAt} />
                        </div>
                      )}
                    </div>
                    <ArrowRight className="h-4 w-4 text-ink-3" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <ClientForm
        open={creating}
        onClose={() => setCreating(false)}
        sites={state.sites}
        onSaved={(c) => {
          router.push(`/clients/${c.id}`);
          router.refresh();
        }}
      />
    </div>
  );
}
