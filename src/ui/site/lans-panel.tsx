"use client";

import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SiteState } from "@/server/state";
import { apiFetch } from "../api";
import { Badge, Button, Card, Input, Table, Td, Th } from "../components";
import { Notice } from "../components-client";

export function LansPanel({ site }: { site: SiteState }) {
  const router = useRouter();
  const [cidr, setCidr] = useState("");
  const [name, setName] = useState("");
  const [vlan, setVlan] = useState("");
  const [shared, setShared] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggleShared = async (lanId: string, next: boolean) => {
    setErr(null);
    try {
      await apiFetch("PATCH", `/api/admin/sites/${site.id}/lans/${lanId}`, { shared: next });
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card title="Networks at this site" description="Every network (VLAN) behind this site's router. Shared networks are reachable from the other sites and from roaming clients; local-only ones stay put.">
      {site.lans.length > 0 && (
        <Table className="mb-4">
          <thead>
            <tr>
              <Th>Network</Th>
              <Th>Name</Th>
              <Th>VLAN</Th>
              <Th>Across the mesh</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {site.lans.map((l) => (
              <tr key={l.id}>
                <Td>
                  <span className="mono">{l.cidr}</span>
                </Td>
                <Td>{l.name}</Td>
                <Td>{l.vlan ?? <span className="text-ink-3">—</span>}</Td>
                <Td>
                  <button type="button" onClick={() => toggleShared(l.id, !l.shared)} title="Click to change">
                    <Badge tone={l.shared ? "brand" : "idle"}>{l.shared ? "Shared" : "Local only"}</Badge>
                  </button>
                </Td>
                <Td align="right">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Remove network"
                    onClick={async () => {
                      if (!confirm(`Remove ${l.cidr} from ${site.name}? Other sites stop routing to it within seconds.`)) return;
                      await apiFetch("DELETE", `/api/admin/sites/${site.id}/lans/${l.id}`);
                      router.refresh();
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {err && <Notice tone="error">{err}</Notice>}
      <form
        className="grid items-end gap-3 sm:grid-cols-[1.4fr_1.4fr_0.7fr_auto_auto]"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await apiFetch("POST", `/api/admin/sites/${site.id}/lans`, { cidr: cidr.trim(), name: name.trim(), vlan: vlan === "" ? null : Number(vlan), shared });
            setCidr("");
            setName("");
            setVlan("");
            router.refresh();
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-2">Network (CIDR)</span>
          <Input className="mono" required value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="192.168.20.0/24" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-2">Name</span>
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Staff" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-2">VLAN</span>
          <Input type="number" min={1} max={4094} value={vlan} onChange={(e) => setVlan(e.target.value)} placeholder="20" />
        </label>
        <label className="flex h-9 items-center gap-2 text-sm text-ink">
          <input type="checkbox" className="h-4 w-4 accent-brand" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Shared
        </label>
        <Button type="submit" variant="secondary" disabled={busy}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </form>
    </Card>
  );
}
