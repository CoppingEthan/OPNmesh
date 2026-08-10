import { revalidatePath } from "next/cache";
import { requireAdmin } from "../../lib/ui/auth.js";
import { control } from "../../lib/ui/control.js";

export const dynamic = "force-dynamic";

const PROM_URL = process.env["OPNMESH_PROM_URL"] ?? "http://localhost:19090";

async function activeAlerts(): Promise<Array<{ name: string; state: string; description: string }> | null> {
  try {
    const res = await fetch(`${PROM_URL}/api/v1/alerts`, { cache: "no-store" });
    const body = (await res.json()) as any;
    if (body.status !== "success") return null;
    return body.data.alerts.map((a: any) => ({
      name: a.labels.alertname,
      state: a.state,
      description: a.annotations?.description ?? "",
    }));
  } catch {
    return null;
  }
}

async function sendTest() {
  "use server";
  await requireAdmin();
  const res = await control.testEmail().catch((e) => ({ ok: false, error: String(e) }));
  const { redirect } = await import("next/navigation");
  redirect(res.ok ? "/alerts?sent=1" : `/alerts?err=${encodeURIComponent(res.error ?? "failed")}`);
}

const SMTP_VARS = [
  "OPNMESH_SMTP_HOST",
  "OPNMESH_SMTP_PORT",
  "OPNMESH_SMTP_USER",
  "OPNMESH_SMTP_PASSWORD",
  "OPNMESH_SMTP_FROM",
  "OPNMESH_ALERT_TO",
] as const;

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; err?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const alerts = await activeAlerts();

  return (
    <div className="space-y-6">
      <h1 className="h1">Alerts</h1>

      <div className="card">
        <div className="label mb-3">Active alerts (Prometheus)</div>
        {alerts === null ? (
          <p className="text-sm text-zinc-500">Prometheus unreachable at {PROM_URL}.</p>
        ) : alerts.length === 0 ? (
          <p className="status-ok text-sm">No active alerts.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Alert</th>
                <th>State</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a, i) => (
                <tr key={i}>
                  <td className="mono">{a.name}</td>
                  <td className={a.state === "firing" ? "status-bad" : "status-warn"}>{a.state}</td>
                  <td className="text-zinc-400">{a.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="label mb-3">SMTP delivery</div>
        <p className="mb-2 text-sm text-zinc-400">
          Alertmanager sends mail using credentials from the environment — they are never stored in
          this panel or the repository.
        </p>
        <table className="data mb-3">
          <thead>
            <tr>
              <th>Variable</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {SMTP_VARS.map((v) => (
              <tr key={v}>
                <td className="mono">{v}</td>
                <td>
                  {process.env[v] ? (
                    <span className="status-ok">set{v.includes("PASSWORD") ? " (hidden)" : `: ${v.includes("PASSWORD") ? "" : process.env[v]}`}</span>
                  ) : (
                    <span className="status-dim">not set</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={sendTest}>
          <button className="btn btn-primary" type="submit">Send test email</button>
        </form>
        {params.sent && <p className="status-ok mt-2 text-sm">Test email sent — check the inbox (or spam folder).</p>}
        {params.err && <p className="status-bad mt-2 text-sm">Send failed: {params.err}</p>}
      </div>

      <div className="card">
        <div className="label mb-2">Configured alert rules</div>
        <p className="text-sm text-zinc-400">
          Shipped in deploy/prometheus/rules/opnmesh.yml: tunnel down (180s), node unreachable, node
          degraded, config drift, port bind failure, reconcile error, enrolment pending, update
          failed &amp; rolled back, rollout aborted, dead-man's switch missed. Every alert names the
          node, the peer, since when, and what to check.
        </p>
      </div>
    </div>
  );
}
