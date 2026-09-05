"use client";

import { Download, Link2, Pencil, QrCode, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StatePayload } from "@/server/state";
import { apiFetch } from "./api";
import { ClientForm } from "./client-form";
import { Badge, Button, Callout, Card, PageHeader, Pre } from "./components";
import { Ago, ConfirmButton, CopyButton, Notice } from "./components-client";
import { dateTime, formatBits } from "./format";
import { useLiveState } from "./use-live";

export interface ClientRowView {
  id: string;
  name: string;
  slug: string;
  owner: string;
  notes: string;
  tunnelIp: string;
  publicKey: string;
  enabled: boolean;
  expiresAt: number | null;
  preferredSiteId: string | null;
  allowedSiteIds: string[] | null;
  allowInbound: boolean;
  createdAt: number;
  lastHandshakeAt: number | null;
}

export function ClientDetail({ initial, row }: { initial: StatePayload; row: ClientRowView }) {
  const { state } = useLiveState(initial);
  const router = useRouter();
  const live = state.clients.find((c) => c.id === row.id);
  const [editing, setEditing] = useState(false);
  const [showConf, setShowConf] = useState(false);
  const [conf, setConf] = useState<string | null>(null);
  const [confErr, setConfErr] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ url: string; expiresAt: number } | null>(null);
  const [qrKey, setQrKey] = useState(0);
  const siteName = (id: string | null) => (id ? state.sites.find((s) => s.id === id)?.name ?? "?" : null);
  const canConnect = state.sites.some((s) => s.reachable) && row.enabled;

  const loadConf = async () => {
    setConfErr(null);
    try {
      const res = await fetch(`/api/admin/clients/${row.id}/config`, { credentials: "same-origin" });
      const text = await res.text();
      if (!res.ok) throw new Error(JSON.parse(text).error ?? "failed");
      setConf(text);
      setShowConf(true);
    } catch (e) {
      setConfErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<Link href="/clients" className="hover:text-ink">Clients</Link>}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {row.name}
            {!row.enabled ? <Badge tone="idle">Disabled</Badge> : live?.online ? <Badge tone="good" dot pulse>Online via {siteName(live.viaSiteId)}</Badge> : <Badge tone="idle" dot>Offline</Badge>}
          </span>
        }
        description={
          <>
            <span className="mono">{row.tunnelIp}</span>
            {row.owner ? ` · ${row.owner}` : ""} · added {dateTime(row.createdAt)}
            {row.expiresAt ? ` · expires ${dateTime(row.expiresAt)}` : ""}
          </>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                await apiFetch("PATCH", `/api/admin/clients/${row.id}`, { enabled: !row.enabled });
                router.refresh();
              }}
            >
              {row.enabled ? "Disable" : "Enable"}
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Hand it over" description="Three ways to get the configuration onto the device. Each contains the private key, so treat it like a password.">
            {!canConnect && (
              <Callout tone="warn" title={row.enabled ? "No site accepts incoming connections yet" : "This client is disabled"}>
                {row.enabled ? "Set a public address on at least one gateway before handing out configs; until then they would have nowhere to connect." : "Enable it to hand out a working configuration."}
              </Callout>
            )}
            <div className="mt-4 grid gap-6 md:grid-cols-[220px_1fr]">
              <div>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
                  <QrCode className="h-4 w-4" /> Scan on a phone
                </h3>
                {canConnect ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={qrKey} src={`/api/admin/clients/${row.id}/qr?v=${qrKey}`} alt="QR code with the WireGuard configuration" className="w-full rounded-lg border border-line bg-white p-2" />
                ) : (
                  <div className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-line-strong text-xs text-ink-3">unavailable</div>
                )}
                <p className="mt-1 text-xs text-ink-3">WireGuard app → Add tunnel → Scan QR code.</p>
              </div>
              <div className="space-y-5">
                <div>
                  <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <Download className="h-4 w-4" /> Download for a laptop
                  </h3>
                  <p className="mb-2 text-xs text-ink-2">Import the file in the WireGuard app on Windows, macOS or Linux.</p>
                  <div className="flex flex-wrap gap-2">
                    <a href={canConnect ? `/api/admin/clients/${row.id}/config?download=1` : undefined} aria-disabled={!canConnect} className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-xs font-medium ${canConnect ? "text-ink hover:bg-surface-2" : "pointer-events-none opacity-50"}`}>
                      <Download className="h-3.5 w-3.5" /> {row.slug.slice(0, 15)}.conf
                    </a>
                    <Button variant="secondary" size="sm" disabled={!canConnect} onClick={showConf ? () => setShowConf(false) : loadConf}>
                      {showConf ? "Hide text" : "Show as text"}
                    </Button>
                  </div>
                  {confErr && <div className="mt-2"><Notice tone="error">{confErr}</Notice></div>}
                  {showConf && conf && (
                    <div className="mt-2">
                      <Pre className="max-h-72 overflow-y-auto">{conf}</Pre>
                      <div className="mt-2"><CopyButton text={conf} label="Copy config" /></div>
                    </div>
                  )}
                </div>
                <div>
                  <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <Link2 className="h-4 w-4" /> Send a one-time link
                  </h3>
                  <p className="mb-2 text-xs text-ink-2">The person opens the link and collects the QR code and file themselves. It works once and expires after 24 hours.</p>
                  {invite ? (
                    <div className="space-y-2">
                      <Pre className="whitespace-pre-wrap break-all">{invite.url}</Pre>
                      <div className="flex flex-wrap items-center gap-2">
                        <CopyButton text={invite.url} label="Copy link" />
                        <span className="text-xs text-ink-3">expires {dateTime(invite.expiresAt)}</span>
                      </div>
                    </div>
                  ) : (
                    <Button variant="secondary" size="sm" disabled={!canConnect} onClick={async () => setInvite(await apiFetch("POST", `/api/admin/clients/${row.id}/invite`, {}))}>
                      Create link
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </Card>

          <Card title="Access">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-ink-3">Can reach</dt>
                <dd className="text-ink">{row.allowedSiteIds ? row.allowedSiteIds.map((id) => siteName(id)).join(", ") : "every shared network at every site"}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Relay for outbound-only sites</dt>
                <dd className="text-ink">{siteName(row.preferredSiteId) ?? "automatic (first hub)"}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Inbound connections from sites</dt>
                <dd className="text-ink">{row.allowInbound ? "allowed" : "blocked (default)"}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Public key</dt>
                <dd className="mono break-all text-xs text-ink">{row.publicKey}</dd>
              </div>
              {row.notes && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-ink-3">Notes</dt>
                  <dd className="whitespace-pre-wrap text-ink">{row.notes}</dd>
                </div>
              )}
            </dl>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Right now">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-ink-3">Last handshake</dt>
                <dd className="text-ink">
                  <Ago ts={live?.lastHandshakeAt ?? row.lastHandshakeAt} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Connected through</dt>
                <dd className="text-ink">{live?.online ? siteName(live.viaSiteId) : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Coming from</dt>
                <dd className="mono text-ink">{live?.endpoint ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Traffic</dt>
                <dd className="text-ink">
                  ↓ {formatBits(live?.txBps ?? 0)} · ↑ {formatBits(live?.rxBps ?? 0)}
                </dd>
              </div>
            </dl>
          </Card>
          <Card title="Keys and removal">
            <div className="flex flex-col items-start gap-2">
              <ConfirmButton
                label={
                  <>
                    <RefreshCw className="h-3.5 w-3.5" /> Rotate keys
                  </>
                }
                variant="secondary"
                description="Generates a new key pair. Every copy of the current configuration stops working immediately; hand over a new one afterwards."
                onConfirm={async () => {
                  await apiFetch("POST", `/api/admin/clients/${row.id}/rotate`);
                  setConf(null);
                  setShowConf(false);
                  setInvite(null);
                  setQrKey((k) => k + 1);
                  router.refresh();
                }}
              />
              <ConfirmButton
                label="Delete client"
                description="Removes the device from every gateway within seconds. This cannot be undone."
                onConfirm={async () => {
                  await apiFetch("DELETE", `/api/admin/clients/${row.id}`);
                  router.push("/clients");
                  router.refresh();
                }}
              />
            </div>
          </Card>
        </div>
      </div>

      <ClientForm open={editing} onClose={() => setEditing(false)} sites={state.sites} clientId={row.id} initial={row} onSaved={() => router.refresh()} />
    </div>
  );
}
