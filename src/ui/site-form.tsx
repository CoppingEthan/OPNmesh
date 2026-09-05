"use client";

import { useState } from "react";
import type { RouterLayout } from "@/core/model";
import { apiFetch } from "./api";
import { Button, Checkbox, Field, Input, Select, Textarea } from "./components";
import { Dialog, Notice } from "./components-client";

export interface SiteFormValues {
  name: string;
  routerLayout: RouterLayout;
  hubPriority: number;
  dnsServer: string;
  dnsDomain: string;
  notes: string;
  alertEmail: boolean;
}

const LAYOUT_HELP: Record<RouterLayout, string> = {
  transit: "Recommended. The gateway VM sits on its own small VLAN; every packet crosses the router in both directions, so the router's firewall sees whole connections.",
  same_lan: "The gateway VM shares a LAN with your computers. Works, but return traffic bypasses the router, so the router needs a firewall policy allowing all connection states.",
  masquerade: "Nothing to configure on the router. Remote sites and roaming clients can reach this site, but hosts here see the gateway's address instead of the real source, and cannot start connections to other sites.",
};

export function SiteForm({
  open,
  onClose,
  initial,
  siteId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Partial<SiteFormValues>;
  siteId?: string;
  onSaved: (site: { id: string }) => void;
}) {
  const [v, setV] = useState<SiteFormValues>({
    name: initial?.name ?? "",
    routerLayout: initial?.routerLayout ?? "transit",
    hubPriority: initial?.hubPriority ?? 10,
    dnsServer: initial?.dnsServer ?? "",
    dnsDomain: initial?.dnsDomain ?? "",
    notes: initial?.notes ?? "",
    alertEmail: initial?.alertEmail ?? true,
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof SiteFormValues>(k: K, val: SiteFormValues[K]) => setV((s) => ({ ...s, [k]: val }));

  return (
    <Dialog open={open} onClose={onClose} title={siteId ? "Edit site" : "Add a site"}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const body = {
              name: v.name,
              routerLayout: v.routerLayout,
              hubPriority: Number(v.hubPriority),
              dnsServer: v.dnsServer || null,
              dnsDomain: v.dnsDomain || null,
              notes: v.notes,
              alertEmail: v.alertEmail,
            };
            const saved = siteId ? await apiFetch<{ id: string }>("PATCH", `/api/admin/sites/${siteId}`, body) : await apiFetch<{ id: string }>("POST", "/api/admin/sites", body);
            onSaved(saved);
            onClose();
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
          } finally {
            setBusy(false);
          }
        }}
      >
        {err && <Notice tone="error">{err}</Notice>}
        <Field label="Name" hint="e.g. Datacentre, Head office, Warehouse">
          <Input required maxLength={80} value={v.name} onChange={(e) => set("name", e.target.value)} autoFocus />
        </Field>
        <Field label="How the gateway VM is attached to the router" hint={LAYOUT_HELP[v.routerLayout]}>
          <Select value={v.routerLayout} onChange={(e) => set("routerLayout", e.target.value as RouterLayout)}>
            <option value="transit">Transit network (recommended)</option>
            <option value="same_lan">Same LAN as the computers</option>
            <option value="masquerade">No router changes (masquerade)</option>
          </Select>
        </Field>
        <Field label="Hub priority" hint="Lower numbers are preferred when a site must relay for others. Usually the datacentre is 1.">
          <Input type="number" min={0} max={10000} value={v.hubPriority} onChange={(e) => set("hubPriority", Number(e.target.value))} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="DNS server for roaming clients" hint="Optional. An IP at this site.">
            <Input className="mono" value={v.dnsServer} onChange={(e) => set("dnsServer", e.target.value)} placeholder="10.0.1.53" />
          </Field>
          <Field label="Search domain" hint="Optional.">
            <Input className="mono" value={v.dnsDomain} onChange={(e) => set("dnsDomain", e.target.value)} placeholder="corp.example" />
          </Field>
        </div>
        <Checkbox label="Email me if this site's gateway stops responding" hint="Needs an SMTP server in Settings. A second email follows when it is back." checked={v.alertEmail} onChange={(e) => set("alertEmail", e.target.checked)} />
        <Field label="Notes" hint="Optional. Where the VM lives, who to call, anything useful.">
          <Textarea value={v.notes} onChange={(e) => set("notes", e.target.value)} maxLength={2000} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : siteId ? "Save changes" : "Create site"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
