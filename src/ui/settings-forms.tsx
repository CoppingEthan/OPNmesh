"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "./api";
import { Button, Callout, Card, Field, Input, Mono, PageHeader } from "./components";
import { Notice } from "./components-client";

interface SettingsView {
  networkName: string;
  gatewayCidr: string;
  clientCidr: string;
  listenPort: number;
  mtu: number;
  keepalive: number;
  interfaceName: string;
  telemetryIntervalS: number;
  publicUrl: string | null;
  configVersion: number;
}

export interface SmtpFormView {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPasswordSet: boolean;
  smtpFrom: string;
  alertTo: string;
  configured: boolean;
}

export function SettingsForms({ admin, settings, env, smtp }: { admin: { email: string }; settings: SettingsView; env: { publicUrl: string; dataDir: string; insecureHttp: boolean }; smtp: SmtpFormView }) {
  const router = useRouter();
  const [v, setV] = useState(settings);
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof SettingsView>(k: K, val: SettingsView[K]) => setV((s) => ({ ...s, [k]: val }));

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Network-wide defaults. Changes reach every gateway on its next report." />
      {env.insecureHttp && (
        <Callout tone="warn" title="Plain HTTP is enabled">
          This controller is running with OPNMESH_INSECURE_HTTP=1. Gateway tokens travel unencrypted. That is fine for a lab or the simulation, never for a real network: put Caddy (or any TLS proxy) in front and remove the flag.
        </Callout>
      )}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Network">
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setMsg(null);
                try {
                  await apiFetch("PUT", "/api/admin/settings", {
                    networkName: v.networkName,
                    gatewayCidr: v.gatewayCidr,
                    clientCidr: v.clientCidr,
                    listenPort: Number(v.listenPort),
                    mtu: Number(v.mtu),
                    keepalive: Number(v.keepalive),
                    interfaceName: v.interfaceName,
                    telemetryIntervalS: Number(v.telemetryIntervalS),
                    publicUrl: v.publicUrl || null,
                  });
                  setMsg({ tone: "success", text: "Saved." });
                  router.refresh();
                } catch (e2) {
                  setMsg({ tone: "error", text: e2 instanceof Error ? e2.message : String(e2) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label="Network name">
                <Input value={v.networkName} onChange={(e) => set("networkName", e.target.value)} />
              </Field>
              <Field label="Public URL" hint={`Shown in install commands and invite links. Currently served as ${env.publicUrl}.`}>
                <Input className="mono" value={v.publicUrl ?? ""} onChange={(e) => set("publicUrl", e.target.value)} placeholder={env.publicUrl} />
              </Field>
              <Field label="Gateway tunnel range" hint="Addresses for gateways inside the mesh. Change only before the first gateway enrols.">
                <Input className="mono" value={v.gatewayCidr} onChange={(e) => set("gatewayCidr", e.target.value)} />
              </Field>
              <Field label="Client tunnel range" hint="Addresses for roaming clients. Must not overlap any site network.">
                <Input className="mono" value={v.clientCidr} onChange={(e) => set("clientCidr", e.target.value)} />
              </Field>
              <Field label="Default listen port (UDP)" hint="Each gateway can override this.">
                <Input className="mono" type="number" min={1} max={65535} value={v.listenPort} onChange={(e) => set("listenPort", Number(e.target.value))} />
              </Field>
              <Field label="MTU" hint="1420 fits a normal 1500-byte internet link.">
                <Input className="mono" type="number" min={1280} max={1500} value={v.mtu} onChange={(e) => set("mtu", Number(e.target.value))} />
              </Field>
              <Field label="Keepalive (seconds)" hint="How often outbound-only gateways and clients refresh their NAT mapping.">
                <Input className="mono" type="number" min={1} max={3600} value={v.keepalive} onChange={(e) => set("keepalive", Number(e.target.value))} />
              </Field>
              <Field label="Report interval (seconds)" hint="How often gateways report telemetry. Lower is livelier, 5 is a good default.">
                <Input className="mono" type="number" min={2} max={60} value={v.telemetryIntervalS} onChange={(e) => set("telemetryIntervalS", Number(e.target.value))} />
              </Field>
              <Field label="Interface name on gateways" hint="Changing it restarts every tunnel once.">
                <Input className="mono" value={v.interfaceName} onChange={(e) => set("interfaceName", e.target.value)} />
              </Field>
              <div className="flex items-end gap-3 sm:col-span-2">
                <Button type="submit" variant="primary" disabled={busy}>
                  {busy ? "Saving…" : "Save settings"}
                </Button>
                {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
              </div>
            </form>
          </Card>
          <AlertsForm smtp={smtp} />
          <PasswordForm />
        </div>
        <div className="space-y-6">
          <Card title="About this controller">
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-xs text-ink-3">Signed in as</dt>
                <dd className="text-ink">{admin.email}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Configuration version</dt>
                <dd className="text-ink">{settings.configVersion}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Data directory</dt>
                <dd className="mono text-ink">{env.dataDir}</dd>
              </div>
            </dl>
          </Card>
          <Card title="Backups">
            <p className="text-sm text-ink-2">
              Everything lives in the data directory: <Mono>opnmesh.db</Mono> (sites, clients, telemetry) and <Mono>secret.key</Mono>, which encrypts client private keys. Back up both together; the database alone cannot decrypt client keys, and the key alone is useless without the database.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function AlertsForm({ smtp }: { smtp: SmtpFormView }) {
  const router = useRouter();
  const [v, setV] = useState({ ...smtp, smtpPassword: "" });
  const [msg, setMsg] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((s) => ({ ...s, [k]: val }));
  const save = async () => {
    setBusy("save");
    setMsg(null);
    try {
      await apiFetch("PUT", "/api/admin/settings", {
        smtpHost: v.smtpHost,
        smtpPort: Number(v.smtpPort),
        smtpSecure: v.smtpSecure,
        smtpUser: v.smtpUser,
        smtpPassword: v.smtpPassword || undefined,
        smtpFrom: v.smtpFrom,
        alertTo: v.alertTo,
      });
      setMsg({ tone: "success", text: "Saved." });
      setV((s) => ({ ...s, smtpPassword: "", smtpPasswordSet: s.smtpPasswordSet || !!s.smtpPassword }));
      router.refresh();
    } catch (e2) {
      setMsg({ tone: "error", text: e2 instanceof Error ? e2.message : String(e2) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Email alerts" description="OPNmesh emails you when a site's gateway stops responding, and again when it is back. Each site has its own switch; new sites start with alerts on.">
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="SMTP server" hint="e.g. smtp.office365.com, smtp.gmail.com, or your own relay.">
          <Input className="mono" value={v.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} placeholder="smtp.example.com" />
        </Field>
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Field label="Port" hint="587 with STARTTLS is the usual choice; 465 needs the box ticked.">
            <Input className="mono" type="number" min={1} max={65535} value={v.smtpPort} onChange={(e) => set("smtpPort", Number(e.target.value))} />
          </Field>
          <label className="mb-6 flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="h-4 w-4 accent-brand" checked={v.smtpSecure} onChange={(e) => set("smtpSecure", e.target.checked)} /> TLS on connect
          </label>
        </div>
        <Field label="Username" hint="Leave empty for a relay without authentication.">
          <Input value={v.smtpUser} onChange={(e) => set("smtpUser", e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Password" hint={v.smtpPasswordSet ? "A password is saved. Leave empty to keep it." : "Stored encrypted."}>
          <Input type="password" value={v.smtpPassword} onChange={(e) => set("smtpPassword", e.target.value)} autoComplete="off" placeholder={v.smtpPasswordSet ? "••••••••" : ""} />
        </Field>
        <Field label="From address">
          <Input value={v.smtpFrom} onChange={(e) => set("smtpFrom", e.target.value)} placeholder="opnmesh@example.com" />
        </Field>
        <Field label="Send alerts to" hint="One or more addresses, separated by commas.">
          <Input value={v.alertTo} onChange={(e) => set("alertTo", e.target.value)} placeholder="it@example.com, oncall@example.com" />
        </Field>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" variant="primary" disabled={busy !== null}>
            {busy === "save" ? "Saving…" : "Save email settings"}
          </Button>
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("test");
              setMsg(null);
              try {
                await save();
                const r = await apiFetch<{ to: string[] }>("POST", "/api/admin/settings/test-email");
                setMsg({ tone: "success", text: `Test email sent to ${r.to.join(", ")}.` });
              } catch (e2) {
                setMsg({ tone: "error", text: e2 instanceof Error ? e2.message : String(e2) });
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "test" ? "Sending…" : "Save and send a test email"}
          </Button>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        </div>
      </form>
    </Card>
  );
}

function PasswordForm() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  return (
    <Card title="Admin password">
      <form
        className="grid gap-4 sm:grid-cols-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (next !== confirm) {
            setMsg({ tone: "error", text: "new passwords do not match" });
            return;
          }
          try {
            await apiFetch("POST", "/api/admin/me", { currentPassword: current, newPassword: next });
            setMsg({ tone: "success", text: "Password changed. Sign in again." });
            setTimeout(() => {
              router.push("/login");
              router.refresh();
            }, 800);
          } catch (e2) {
            setMsg({ tone: "error", text: e2 instanceof Error ? e2.message : String(e2) });
          }
        }}
      >
        <Field label="Current password">
          <Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password">
          <Input type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirm">
          <Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <div className="flex items-center gap-3 sm:col-span-3">
          <Button type="submit" variant="secondary">
            Change password
          </Button>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        </div>
      </form>
    </Card>
  );
}
