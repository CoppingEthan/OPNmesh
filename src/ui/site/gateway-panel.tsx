"use client";

import { KeyRound, Terminal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SiteState } from "@/server/state";
import { apiFetch } from "../api";
import { Badge, Button, Callout, Card, Field, Input, Mono, Pre, healthLabel, healthTone } from "../components";
import { Ago, ConfirmButton, CopyButton, Dialog, Notice } from "../components-client";
import { duration } from "../format";

interface TokenResponse {
  token: string;
  expiresAt: number;
  command: string;
  installScriptSha256: string;
  replaces: string | null;
}

export function GatewayPanel({ site }: { site: SiteState }) {
  const g = site.gateway;
  const router = useRouter();
  const [tok, setTok] = useState<TokenResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const issue = async () => {
    setErr(null);
    try {
      setTok(await apiFetch<TokenResponse>("POST", `/api/admin/sites/${site.id}/enrol-token`, {}));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const installBox = tok && (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">
        On an Ubuntu 22.04 or 24.04 VM at <strong>{site.name}</strong>, run this as root. The token works once and expires in 30 minutes.
      </p>
      <Pre className="whitespace-pre-wrap break-all">{tok.command}</Pre>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={tok.command} label="Copy command" />
        <span className="text-xs text-ink-3">
          Installer SHA-256 <Mono>{tok.installScriptSha256.slice(0, 16)}…</Mono>
        </span>
      </div>
      {tok.replaces && <Callout tone="warn" title="This replaces the existing gateway">The current gateway ({tok.replaces}) will be dropped from the mesh as soon as the new one enrols. Its tunnel address, endpoint and port carry over.</Callout>}
      <p className="text-xs text-ink-3">The VM needs one network interface on the {site.routerLayout === "transit" ? "transit VLAN" : "site LAN"}, outbound HTTPS to this controller, and kernel WireGuard (built into Ubuntu). This page updates automatically when it connects.</p>
    </div>
  );

  if (!g) {
    return (
      <Card title="Gateway" description="Install the OPNmesh agent on a small Ubuntu VM at this site.">
        {err && <Notice tone="error">{err}</Notice>}
        {tok ? (
          installBox
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-ink-2">Nothing is installed here yet. Generate an install command and paste it into the VM; the gateway appears here within a minute of running it.</p>
            <Button variant="primary" onClick={issue}>
              <Terminal className="h-4 w-4" /> Generate install command
            </Button>
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card
      title="Gateway"
      description={
        <>
          <span className="mono">{g.hostname || g.name}</span> · agent {g.agentVersion || "?"} · {g.os || "unknown OS"} {g.arch}
        </>
      }
      actions={<Badge tone={g.attention && g.health === "online" ? "warn" : healthTone(g.health)} dot pulse>{g.attention && g.health === "online" ? "Needs attention" : healthLabel(g.health)}</Badge>}
    >
      {g.attention && <Callout tone="warn" title="Needs attention">{g.attention}</Callout>}
      {g.status === "pending" && (
        <Callout tone="brand" title="Waiting for your approval">
          A gateway enrolled with key fingerprint <Mono>{g.keyFingerprint}</Mono>. Compare it with the value the installer printed, then approve.
          <div className="mt-2">
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                await apiFetch("PATCH", `/api/admin/sites/${site.id}/gateway`, { status: "active" });
                router.refresh();
              }}
            >
              Approve gateway
            </Button>
          </div>
        </Callout>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
        <Item label="Last report">
          <Ago ts={g.lastSeenAt} />
        </Item>
        <Item label="Uptime">{duration(g.uptimeSeconds)}</Item>
        <Item label="Load / memory">
          {g.load1 === null ? "—" : g.load1.toFixed(2)} / {g.memUsedPct === null ? "—" : `${Math.round(g.memUsedPct)}%`}
        </Item>
        <Item label="Configuration">{g.configCurrent ? <span className="text-good-ink">up to date</span> : <span className="text-warn-ink">applying…</span>}</Item>
        <Item label="Tunnel address">
          <span className="mono">{g.tunnelIp}</span>
        </Item>
        <Item label="Address on the site network">
          <span className="mono">{g.lanIp}</span>
        </Item>
        <Item label="Key fingerprint">
          <span className="mono text-xs" title={g.publicKey}>{g.keyFingerprint}</span>
        </Item>
        <Item label="Addresses seen">
          <span className="mono text-xs">{g.addresses.join(", ") || "—"}</span>
        </Item>
      </dl>

      <ReachabilityForm site={site} />

      <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
        <Button variant="secondary" size="sm" onClick={issue}>
          <KeyRound className="h-3.5 w-3.5" /> Replace gateway (new install command)
        </Button>
        {g.status === "active" ? (
          <ConfirmButton
            label="Disable"
            variant="secondary"
            description="The gateway keeps running but receives no configuration and other sites stop routing to it."
            onConfirm={async () => {
              await apiFetch("PATCH", `/api/admin/sites/${site.id}/gateway`, { status: "disabled" });
              router.refresh();
            }}
          />
        ) : g.status === "disabled" ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              await apiFetch("PATCH", `/api/admin/sites/${site.id}/gateway`, { status: "active" });
              router.refresh();
            }}
          >
            Enable
          </Button>
        ) : null}
        <ConfirmButton
          label="Remove gateway"
          description="Forgets this gateway's key and token. The VM keeps its last configuration until you reinstall or switch it off."
          onConfirm={async () => {
            await apiFetch("DELETE", `/api/admin/sites/${site.id}/gateway`);
            router.refresh();
          }}
        />
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      {tok && (
        <Dialog open onClose={() => setTok(null)} title="Replace the gateway" wide>
          {installBox}
        </Dialog>
      )}
    </Card>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="truncate text-ink">{children}</dd>
    </div>
  );
}

function ReachabilityForm({ site }: { site: SiteState }) {
  const g = site.gateway!;
  const router = useRouter();
  const [accepts, setAccepts] = useState(g.endpointHost !== null);
  const [endpoint, setEndpoint] = useState(g.endpointHost ?? "");
  const [port, setPort] = useState(g.listenPort ?? "");
  const [lanIp, setLanIp] = useState(g.lanIp);
  const [mtu, setMtu] = useState(g.mtu ?? "");
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-5 space-y-4 border-t border-line pt-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        try {
          await apiFetch("PATCH", `/api/admin/sites/${site.id}/gateway`, {
            endpointHost: accepts ? endpoint.trim() || null : null,
            listenPort: port === "" ? null : Number(port),
            lanIp: lanIp.trim(),
            mtu: mtu === "" ? null : Number(mtu),
          });
          setMsg({ tone: "success", text: "Saved. Gateways apply the change on their next report." });
          router.refresh();
        } catch (e2) {
          setMsg({ tone: "error", text: e2 instanceof Error ? e2.message : String(e2) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <h3 className="text-sm font-semibold text-ink">Reachability</h3>
        <p className="text-xs text-ink-2">Can other sites and roaming clients connect <em>to</em> this site? They can if the router forwards a UDP port to the gateway VM. A site that cannot dials out to the ones that can.</p>
      </div>
      <label className="flex items-start gap-2.5">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand" checked={accepts} onChange={(e) => setAccepts(e.target.checked)} />
        <span className="text-sm text-ink">This site accepts incoming connections (a UDP port is forwarded to the gateway)</span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Public address" hint="Static IP or DDNS hostname of this site's internet connection.">
          <Input className="mono" disabled={!accepts} required={accepts} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="vpn.example.com or 203.0.113.20" />
        </Field>
        <Field label="Listen port" hint="Leave empty for the network default. The router must forward this UDP port.">
          <Input className="mono" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value === "" ? "" : Number(e.target.value))} placeholder="51820" />
        </Field>
        <Field label="Gateway address on the site network" hint="What the router's static routes point at. Detected at install; change it if the VM moved.">
          <Input className="mono" required value={lanIp} onChange={(e) => setLanIp(e.target.value)} />
        </Field>
        <Field label="MTU override" hint="Leave empty unless this site is on PPPoE (try 1380).">
          <Input className="mono" type="number" min={1280} max={1500} value={mtu} onChange={(e) => setMtu(e.target.value === "" ? "" : Number(e.target.value))} placeholder="1420" />
        </Field>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Button type="submit" variant="primary" size="sm" disabled={busy}>
        {busy ? "Saving…" : "Save reachability"}
      </Button>
    </form>
  );
}
