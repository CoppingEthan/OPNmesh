"use client";

import { RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import type { LinkView } from "@/server/unifi";
import type { SiteState } from "@/server/state";
import { apiFetch } from "../api";
import { Badge, Button, Callout, Card, Field, Input, Mono, Select } from "../components";
import { Ago, ConfirmButton, Notice } from "../components-client";

interface Probe {
  certificate: { fingerprint: string; pem: string; subject: string; issuer: string; validTo: string; systemTrusted: boolean } | null;
  identity: { name?: string; version?: string } | null;
  error: string | null;
}

/**
 * Link a site to its UniFi console so OPNmesh keeps the static routes (and,
 * for the same-LAN layout, the firewall policy) in sync automatically.
 */
export function UnifiPanel({ site }: { site: SiteState }) {
  const [link, setLink] = useState<LinkView | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);

  const load = async () => setLink(await apiFetch<LinkView | null>("GET", `/api/admin/sites/${site.id}/unifi`));
  useEffect(() => {
    load().catch(() => setLink(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);

  if (link === undefined) return <Card title="UniFi">Loading…</Card>;

  if (!link || editing) {
    return (
      <Card title="UniFi" description="Let OPNmesh create and maintain this site's static routes on its UniFi console.">
        <LinkForm
          site={site}
          existing={link}
          onDone={async () => {
            setEditing(false);
            await load();
          }}
          onCancel={link ? () => setEditing(false) : undefined}
        />
      </Card>
    );
  }

  const tone = link.lastSyncStatus === "ok" ? "good" : link.lastSyncStatus === "warning" ? "warn" : link.lastSyncStatus === "error" ? "bad" : "idle";
  return (
    <Card
      title="UniFi"
      description={
        <>
          <span className="mono">{link.baseUrl}</span> · site <span className="mono">{link.unifiSite}</span> · {link.authKind === "api_key" ? "API key" : `user ${link.username}`}
        </>
      }
      actions={<Badge tone={tone} dot>{link.lastSyncStatus === "never" ? "Not synced yet" : link.lastSyncStatus === "ok" ? "In sync" : link.lastSyncStatus === "warning" ? "Synced with warnings" : "Sync failed"}</Badge>}
    >
      <p className="text-sm text-ink-2">
        {link.lastSyncAt ? (
          <>
            Last sync <Ago ts={link.lastSyncAt} />: {link.lastSyncDetail}
          </>
        ) : (
          "Routes are pushed automatically whenever the mesh changes, and every ten minutes."
        )}
      </p>
      {Object.keys(link.managed.routes).length > 0 && (
        <p className="mt-2 text-xs text-ink-3">
          Managing {Object.keys(link.managed.routes).length} route{Object.keys(link.managed.routes).length === 1 ? "" : "s"} named <Mono>OPNmesh: …</Mono>
          {link.managed.policy ? " and one firewall policy" : ""}. Nothing else on the console is touched.
        </p>
      )}
      {link.certFingerprint && (
        <p className="mt-1 flex items-center gap-1 text-xs text-ink-3">
          <ShieldCheck className="h-3.5 w-3.5" /> Certificate pinned <Mono>{link.certFingerprint.slice(0, 23)}…</Mono>
        </p>
      )}
      {msg && <div className="mt-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              const r = await apiFetch<{ result: { created: number; updated: number; deleted: number; unchanged: number; warnings: string[] }; link: LinkView }>("POST", `/api/admin/sites/${site.id}/unifi/sync`);
              setLink(r.link);
              setMsg({ tone: r.result.warnings.length ? "info" : "success", text: r.link.lastSyncDetail });
            } catch (e) {
              setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) });
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" /> {busy ? "Syncing…" : "Sync now"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Change connection
        </Button>
        <ConfirmButton
          label={
            <>
              <Unplug className="h-3.5 w-3.5" /> Disconnect
            </>
          }
          variant="secondary"
          confirmLabel="Disconnect and remove routes"
          description="Removes the routes and policy OPNmesh created on the console, then forgets the connection. Choose this when decommissioning the site. (To keep the routes in place, change the connection instead.)"
          onConfirm={async () => {
            await apiFetch("DELETE", `/api/admin/sites/${site.id}/unifi?remove=1`);
            setLink(null);
          }}
        />
      </div>
    </Card>
  );
}

function LinkForm({ site, existing, onDone, onCancel }: { site: SiteState; existing: LinkView | null; onDone: () => Promise<void>; onCancel?: () => void }) {
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [unifiSite, setUnifiSite] = useState(existing?.unifiSite ?? "default");
  const [kind, setKind] = useState<"api_key" | "password">(existing?.authKind ?? "api_key");
  const [apiKey, setApiKey] = useState("");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [password, setPassword] = useState("");
  const [standalone, setStandalone] = useState(existing?.standalone ?? false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [trusted, setTrusted] = useState<string | null>(existing?.certFingerprint ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const auth = kind === "api_key" ? { kind: "api_key" as const, apiKey } : { kind: "password" as const, username, password };

  const doProbe = async (trustFingerprint: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      const p = await apiFetch<Probe>("POST", `/api/admin/sites/${site.id}/unifi/probe`, { baseUrl, unifiSite, auth, standalone, trustFingerprint });
      setProbe(p);
      if (p.certificate && (p.certificate.systemTrusted || trustFingerprint === p.certificate.fingerprint)) setTrusted(p.certificate.fingerprint);
      if (p.error) setErr(p.error);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const needsTrust = probe?.certificate && !probe.certificate.systemTrusted && trusted !== probe.certificate.fingerprint;
  const verified = probe && !probe.error && probe.identity;

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!verified) return;
        setBusy(true);
        setErr(null);
        try {
          await apiFetch("PUT", `/api/admin/sites/${site.id}/unifi`, {
            baseUrl,
            unifiSite,
            auth,
            standalone,
            certFingerprint: probe?.certificate && !probe.certificate.systemTrusted ? probe.certificate.fingerprint : null,
            certPem: probe?.certificate && !probe.certificate.systemTrusted ? probe.certificate.pem : null,
          });
          await onDone();
        } catch (e2) {
          setErr(e2 instanceof Error ? e2.message : String(e2));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm text-ink-2">
        On the console create an API key under <strong>Settings → Control Plane → Integrations</strong> (UniFi OS). A self-hosted Network application without UniFi OS uses a local admin login instead.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Console address" hint="e.g. https://192.168.1.1 or https://unifi.example.com">
          <Input className="mono" required value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://192.168.1.1" />
        </Field>
        <Field label="UniFi site" hint="Usually “default”; the short name from the URL of a multi-site controller.">
          <Input className="mono" value={unifiSite} onChange={(e) => setUnifiSite(e.target.value)} />
        </Field>
        <Field label="Authentication">
          <Select value={kind} onChange={(e) => setKind(e.target.value as "api_key" | "password")}>
            <option value="api_key">API key (recommended)</option>
            <option value="password">Local admin username and password</option>
          </Select>
        </Field>
        {kind === "api_key" ? (
          <Field label="API key">
            <Input className="mono" type="password" required value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
          </Field>
        ) : (
          <>
            <Field label="Username">
              <Input required value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Password">
              <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </Field>
          </>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" className="h-4 w-4 accent-brand" checked={standalone} onChange={(e) => setStandalone(e.target.checked)} /> Self-hosted Network application (not a UniFi OS console)
      </label>

      {err && <Notice tone="error">{err}</Notice>}

      {needsTrust && probe?.certificate && (
        <Callout tone="warn" title="Confirm the console's certificate">
          <p>The console uses a certificate that is not publicly trusted (normal for UniFi). Compare this fingerprint with the one the console shows under its certificate settings, or trust it if you are on the local network right now.</p>
          <dl className="mono mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
            <dt>SHA-256</dt>
            <dd className="break-all">{probe.certificate.fingerprint}</dd>
            <dt>Subject</dt>
            <dd>{probe.certificate.subject}</dd>
            <dt>Valid to</dt>
            <dd>{probe.certificate.validTo}</dd>
          </dl>
          <div className="mt-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => doProbe(probe.certificate!.fingerprint)}>
              Trust this certificate and check credentials
            </Button>
          </div>
        </Callout>
      )}
      {verified && (
        <Notice tone="success">
          Connected{probe?.identity?.version ? ` to Network ${probe.identity.version}` : ""}
          {probe?.identity?.name ? ` as ${probe.identity.name}` : ""}.
        </Notice>
      )}

      <div className="flex flex-wrap gap-2">
        {!verified && (
          <Button variant="secondary" disabled={busy || !baseUrl} onClick={() => doProbe(trusted)}>
            {busy ? "Checking…" : "Test connection"}
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={!verified || busy}>
          {existing ? "Save connection" : "Connect and start syncing"}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
