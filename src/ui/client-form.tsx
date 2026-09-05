"use client";

import { useState } from "react";
import type { SiteState } from "@/server/state";
import { apiFetch } from "./api";
import { Button, Checkbox, Field, Input, Select, Textarea } from "./components";
import { Dialog, Notice } from "./components-client";

export interface ClientFormValues {
  name: string;
  owner: string;
  notes: string;
  preferredSiteId: string;
  restricted: boolean;
  allowedSiteIds: string[];
  allowInbound: boolean;
  expiresOn: string;
}

function toDateInput(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromDateInput(s: string): number | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 23, 59, 59).getTime();
}

export function ClientForm({
  open,
  onClose,
  sites,
  clientId,
  initial,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  sites: SiteState[];
  clientId?: string;
  initial?: Partial<{ name: string; owner: string; notes: string; preferredSiteId: string | null; allowedSiteIds: string[] | null; allowInbound: boolean; expiresAt: number | null }>;
  onSaved: (c: { id: string }) => void;
}) {
  const [v, setV] = useState<ClientFormValues>({
    name: initial?.name ?? "",
    owner: initial?.owner ?? "",
    notes: initial?.notes ?? "",
    preferredSiteId: initial?.preferredSiteId ?? "",
    restricted: !!initial?.allowedSiteIds,
    allowedSiteIds: initial?.allowedSiteIds ?? [],
    allowInbound: initial?.allowInbound ?? false,
    expiresOn: toDateInput(initial?.expiresAt),
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ClientFormValues>(k: K, val: ClientFormValues[K]) => setV((s) => ({ ...s, [k]: val }));
  const reachable = sites.filter((s) => s.reachable);

  return (
    <Dialog open={open} onClose={onClose} title={clientId ? "Edit client" : "Add a roaming client"}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (v.restricted && v.allowedSiteIds.length === 0) {
            setErr("choose at least one site, or untick the restriction");
            return;
          }
          setBusy(true);
          setErr(null);
          try {
            const body = {
              name: v.name,
              owner: v.owner,
              notes: v.notes,
              preferredSiteId: v.preferredSiteId || null,
              allowedSiteIds: v.restricted ? v.allowedSiteIds : null,
              allowInbound: v.allowInbound,
              expiresAt: fromDateInput(v.expiresOn),
            };
            const saved = clientId ? await apiFetch<{ id: string }>("PATCH", `/api/admin/clients/${clientId}`, body) : await apiFetch<{ id: string }>("POST", "/api/admin/clients", body);
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
        <Field label="Device name" hint="e.g. Alice's laptop, Bob's phone">
          <Input required maxLength={80} value={v.name} onChange={(e) => set("name", e.target.value)} autoFocus />
        </Field>
        <Field label="Owner" hint="Optional. Who this belongs to — an email is handy.">
          <Input maxLength={120} value={v.owner} onChange={(e) => set("owner", e.target.value)} />
        </Field>
        <Field label="Preferred site" hint="Where traffic to outbound-only sites is relayed through. Usually the closest site that accepts connections.">
          <Select value={v.preferredSiteId} onChange={(e) => set("preferredSiteId", e.target.value)}>
            <option value="">Automatic (first hub)</option>
            {reachable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox label="Restrict to specific sites" hint="By default a client can reach every shared network at every site." checked={v.restricted} onChange={(e) => set("restricted", e.target.checked)} />
        {v.restricted && (
          <div className="ml-6 grid gap-1 rounded-lg border border-line p-3 sm:grid-cols-2">
            {sites.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-brand"
                  checked={v.allowedSiteIds.includes(s.id)}
                  onChange={(e) => set("allowedSiteIds", e.target.checked ? [...v.allowedSiteIds, s.id] : v.allowedSiteIds.filter((x) => x !== s.id))}
                />
                {s.name}
              </label>
            ))}
          </div>
        )}
        <Checkbox label="Allow sites to open connections to this device" hint="Off by default: clients reach in, nothing reaches them. Turn on for remote support to this device." checked={v.allowInbound} onChange={(e) => set("allowInbound", e.target.checked)} />
        <Field label="Expires on" hint="Optional. The client is disabled automatically at the end of this day.">
          <Input type="date" value={v.expiresOn} onChange={(e) => set("expiresOn", e.target.value)} />
        </Field>
        <Field label="Notes">
          <Textarea value={v.notes} onChange={(e) => set("notes", e.target.value)} maxLength={2000} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : clientId ? "Save changes" : "Create client"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
