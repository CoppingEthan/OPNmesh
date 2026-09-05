"use client";

import { Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { RouterPlan } from "@/core/generate/router";
import type { StatePayload } from "@/server/state";
import { apiFetch } from "../api";
import { Badge, Button, Card, PageHeader, Td, Th, Table, healthLabel, healthTone } from "../components";
import { ConfirmButton } from "../components-client";
import { formatBits, formatMs, LAYOUT_LABEL } from "../format";
import { SiteForm } from "../site-form";
import { useLiveState } from "../use-live";
import { ChecksPanel } from "./checks-panel";
import { GatewayPanel } from "./gateway-panel";
import { LansPanel } from "./lans-panel";
import { RouterPanel } from "./router-panel";
import { UnifiPanel } from "./unifi-panel";

export function SiteDetail({ siteId, initial, initialPlan }: { siteId: string; initial: StatePayload; initialPlan: RouterPlan | null }) {
  const { state } = useLiveState(initial);
  const router = useRouter();
  const site = state.sites.find((s) => s.id === siteId);
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState<RouterPlan | null>(initialPlan);

  // The router plan changes whenever the topology does; the live state's
  // config version tells us when to refetch it.
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ plan: RouterPlan }>("GET", `/api/admin/sites/${siteId}/router`)
      .then((r) => {
        if (!cancelled) setPlan(r.plan);
      })
      .catch(() => {
        if (!cancelled) setPlan(null);
      });
    return () => {
      cancelled = true;
    };
  }, [siteId, state.settings.configVersion]);

  if (!site) {
    return (
      <div>
        <p className="text-sm text-ink-2">This site no longer exists.</p>
        <Link href="/sites" className="text-sm text-brand-ink hover:underline">Back to sites</Link>
      </div>
    );
  }
  const g = site.gateway;
  const tunnels = state.tunnels.filter((t) => t.a === site.id || t.b === site.id);
  const name = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<Link href="/sites" className="hover:text-ink">Sites</Link>}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {site.name}
            {g ? <Badge tone={g.attention && g.health === "online" ? "warn" : healthTone(g.health)} dot pulse>{g.attention && g.health === "online" ? "Needs attention" : healthLabel(g.health)}</Badge> : <Badge tone="idle">No gateway</Badge>}
          </span>
        }
        description={
          <>
            {LAYOUT_LABEL[site.routerLayout]} · hub priority {site.hubPriority}
            {site.notes ? ` · ${site.notes}` : ""}
          </>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
            <ConfirmButton
              label="Delete site"
              description="This removes the site, its networks and its gateway from the mesh. Other sites will stop routing to it within seconds. The VM itself is not touched."
              onConfirm={async () => {
                await apiFetch("DELETE", `/api/admin/sites/${siteId}`);
                router.push("/sites");
                router.refresh();
              }}
            />
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <GatewayPanel site={site} />
          <ChecksPanel site={site} />
          <LansPanel site={site} />
          <RouterPanel site={site} plan={plan} />
        </div>
        <div className="space-y-6">
          <Card title="Connections from here" description="Live, from the gateways' own counters." padded={false}>
            {tunnels.length === 0 ? (
              <p className="px-5 py-6 text-sm text-ink-3">Add a second site with a gateway to see connections.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>To</Th>
                    <Th>Status</Th>
                    <Th align="right">Out</Th>
                    <Th align="right">In</Th>
                    <Th align="right">RTT</Th>
                  </tr>
                </thead>
                <tbody>
                  {tunnels.map((t) => {
                    const other = t.a === site.id ? t.b : t.a;
                    const out = t.a === site.id ? t.aToB : t.bToA;
                    const inn = t.a === site.id ? t.bToA : t.aToB;
                    return (
                      <tr key={other}>
                        <Td>
                          <Link href={`/sites/${other}`} className="text-ink hover:underline">{name(other)}</Link>
                          {t.kind === "transit" && <div className="text-xs text-ink-3">via {name(t.via!)}</div>}
                        </Td>
                        <Td>
                          {t.kind === "direct" ? <Badge tone={healthTone(t.health)} dot>{healthLabel(t.health)}</Badge> : t.kind === "transit" ? <Badge tone="info">indirect</Badge> : <Badge tone="bad">no path</Badge>}
                        </Td>
                        <Td align="right">{formatBits(out)}</Td>
                        <Td align="right">{formatBits(inn)}</Td>
                        <Td align="right">{formatMs(t.rttMs)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
          <UnifiPanel site={site} />
        </div>
      </div>

      <SiteForm
        open={editing}
        onClose={() => setEditing(false)}
        siteId={site.id}
        initial={{ name: site.name, routerLayout: site.routerLayout, hubPriority: site.hubPriority, dnsServer: site.dnsServer ?? "", dnsDomain: site.dnsDomain ?? "", notes: site.notes, alertEmail: site.alertEmail }}
        onSaved={() => router.refresh()}
      />
    </div>
  );
}
