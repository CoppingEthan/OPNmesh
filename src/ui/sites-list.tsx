"use client";

import { ArrowRight, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StatePayload } from "@/server/state";
import { Badge, Button, Card, EmptyState, PageHeader, StatusDot, healthLabel, healthTone } from "./components";
import { Ago } from "./components-client";
import { LAYOUT_LABEL } from "./format";
import { SiteForm } from "./site-form";
import { useLiveState } from "./use-live";

export function SitesList({ initial, openNew }: { initial: StatePayload; openNew: boolean }) {
  const { state } = useLiveState(initial);
  const router = useRouter();
  const [creating, setCreating] = useState(openNew);
  return (
    <div>
      <PageHeader
        title="Sites"
        description="A site is a location with its own router and networks. Each site runs one gateway VM that joins it to the mesh."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Add site
          </Button>
        }
      />
      {state.sites.length === 0 ? (
        <EmptyState title="No sites yet" description="Create your first site, then install its gateway with the command OPNmesh gives you." action={<Button variant="primary" onClick={() => setCreating(true)}>Add site</Button>} />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line">
            {state.sites.map((s) => {
              const g = s.gateway;
              const tone = g ? (g.attention && g.health === "online" ? "warn" : healthTone(g.health)) : "idle";
              return (
                <li key={s.id}>
                  <Link href={`/sites/${s.id}`} className="flex items-center gap-4 px-5 py-4 hover:bg-surface-2">
                    <StatusDot tone={tone} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{s.name}</span>
                        <Badge tone="info">{LAYOUT_LABEL[s.routerLayout]}</Badge>
                        {s.inMesh && <Badge tone={s.reachable ? "brand" : "idle"}>{s.reachable ? "accepts connections" : "dials out only"}</Badge>}
                      </div>
                      <div className="mono mt-0.5 truncate text-xs text-ink-3">
                        {s.lans.length === 0 ? "no networks yet" : s.lans.map((l) => `${l.cidr}${l.shared ? "" : " (local)"}`).join("  ")}
                      </div>
                    </div>
                    <div className="hidden text-right text-xs text-ink-2 sm:block">
                      {g ? (
                        <>
                          <div>{g.attention && g.health === "online" ? "Needs attention" : healthLabel(g.health)}</div>
                          <div className="text-ink-3">
                            <Ago ts={g.lastSeenAt} />
                          </div>
                        </>
                      ) : (
                        <span className="text-ink-3">No gateway installed</span>
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
      <SiteForm
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(site) => {
          router.push(`/sites/${site.id}`);
          router.refresh();
        }}
      />
    </div>
  );
}
